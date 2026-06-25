const pool=require('../config/db');
const bcrypt=require('bcryptjs');
const crypto=require('crypto');
const notification=require('../services/notification.service');
const {validatePasswordStrength}=require('../utils/passwordValidator');

function makeCustomerCode(id){
  return 'KH'+String(id).padStart(5,'0');
}
function randomCode(){ return String(Math.floor(100000+Math.random()*900000)); }
function randomToken(){ return crypto.randomBytes(32).toString('hex'); }
function sha256(v){ return crypto.createHash('sha256').update(String(v||'')).digest('hex'); }
function appUrl(path){
  const base=(process.env.PUBLIC_APP_URL||process.env.FRONTEND_URL||'https://meatbiz.posora.vn').replace(/\/$/,'');
  return `${base}${path}`;
}
function htmlEscape(v){ return String(v||'').replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

function normalizeEmail(v){
  return String(v||'').trim().toLowerCase();
}

function isValidEmail(v){
  const email=normalizeEmail(v);
  // Strict enough for production forms: no spaces, one @, domain has a dot, no leading/trailing dot.
  if(!email || email.length>254) return false;
  if(/\s/.test(email)) return false;
  const re=/^[^\s@<>(),;:\\"\[\]]+@([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$/;
  if(!re.test(email)) return false;
  const [local,domain]=email.split('@');
  if(!local || !domain || local.startsWith('.') || local.endsWith('.')) return false;
  if(domain.split('.').some(p=>!p || p.startsWith('-') || p.endsWith('-'))) return false;
  return true;
}


class RegistrationAgent{
  async ensureColumn(table,column,definition){
    const [rows]=await pool.query(
      `SELECT COUNT(*) cnt FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?`,
      [table,column]
    );
    if(Number(rows[0].cnt)===0){
      await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  async ensureSchema(){
    await pool.query(`CREATE TABLE IF NOT EXISTS customer_account_registrations (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      full_name VARCHAR(255) NULL,
      business_name VARCHAR(255) NOT NULL,
      owner_name VARCHAR(255) NOT NULL,
      phone VARCHAR(50) NOT NULL,
      email VARCHAR(255) NULL,
      address TEXT NULL,
      username VARCHAR(100) NOT NULL,
      password_hash VARCHAR(255) NULL,
      service_plan VARCHAR(50) NOT NULL DEFAULT 'TRIAL',
      payment_method VARCHAR(50) NOT NULL DEFAULT 'NONE',
      transfer_note TEXT NULL,
      description TEXT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
      customer_id BIGINT NULL,
      user_id BIGINT NULL,
      approved_at DATETIME NULL,
      rejected_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_registration_username(username),
      KEY idx_registration_phone(phone),
      KEY idx_registration_email(email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    const cols=[
      ['full_name',`VARCHAR(255) NULL`],['password_hash',`VARCHAR(255) NULL`],['description',`TEXT NULL`],
      ['customer_id',`BIGINT NULL`],['user_id',`BIGINT NULL`],['approved_at',`DATETIME NULL`],['rejected_at',`DATETIME NULL`],
      ['email_verified_at',`DATETIME NULL`],['phone_verified_at',`DATETIME NULL`],
      ['email_verify_token_hash',`VARCHAR(128) NULL`],['email_verify_expires_at',`DATETIME NULL`],
      ['phone_otp_hash',`VARCHAR(255) NULL`],['phone_otp_expires_at',`DATETIME NULL`],['phone_otp_sent_at',`DATETIME NULL`],
      ['verification_status',`VARCHAR(30) NOT NULL DEFAULT 'PENDING'`],
      ['approved_by',`BIGINT NULL`],['last_verify_error',`TEXT NULL`]
    ];
    for(const [c,d] of cols) await this.ensureColumn('customer_account_registrations',c,d);

    await pool.query(`CREATE TABLE IF NOT EXISTS auth_event_logs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      event_type VARCHAR(80) NOT NULL,
      actor_user_id BIGINT NULL,
      registration_id BIGINT NULL,
      identifier VARCHAR(255) NULL,
      ip VARCHAR(80) NULL,
      user_agent TEXT NULL,
      success_flg TINYINT(1) NOT NULL DEFAULT 1,
      message TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_event_type_created(event_type,created_at),
      KEY idx_identifier_created(identifier,created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }

  async logEvent({event_type,registration_id,identifier,success_flg=1,message,req}){
    try{
      await pool.query(`INSERT INTO auth_event_logs(event_type,registration_id,identifier,ip,user_agent,success_flg,message) VALUES(?,?,?,?,?,?,?)`,[
        event_type,registration_id||null,identifier||null,req?.ip||null,req?.headers?.['user-agent']||null,success_flg?1:0,message||null
      ]);
    }catch(e){ console.warn('auth_event_log skipped:',e.message); }
  }

  async create(data, req){
    await this.ensureSchema();

    const fullName=(data.full_name||data.owner_name||data.business_name||'').trim();
    const phone=String(data.phone||'').trim();
    const email=normalizeEmail(data.email);
    const username=String(data.username||phone||'').trim();

    if(!fullName) throw new Error('Nhập họ tên');
    if(!phone) throw new Error('Nhập số điện thoại liên hệ');
    if(!/^[0-9]+$/.test(phone)) throw new Error('Số điện thoại chỉ được nhập số');
    if(!email) throw new Error('Vui lòng nhập email để xác minh tài khoản. Đăng ký chỉ bằng số điện thoại đang phát triển.');
    if(!isValidEmail(email)) throw new Error('Email không hợp lệ. Vui lòng nhập email đúng định dạng, ví dụ: ten@posora.vn');
    if(!username) throw new Error('Nhập tài khoản hoặc số điện thoại đăng nhập');
    if(!data.password) throw new Error('Nhập mật khẩu');
    const pwCheck=validatePasswordStrength(data.password);
    if(!pwCheck.ok) throw new Error(pwCheck.message);

    const [u]=await pool.query(`SELECT id FROM users WHERE username=? OR phone=? OR email=? LIMIT 1`,[username,phone,email]);
    if(u.length) throw new Error('Tài khoản, email hoặc số điện thoại đã tồn tại');

    const [r]=await pool.query(`SELECT id,status FROM customer_account_registrations WHERE username=? OR phone=? OR (email<>'' AND email=?) LIMIT 1`,[username,phone,email]);
    if(r.length) throw new Error('Tài khoản, email hoặc số điện thoại này đã gửi đăng ký, vui lòng chờ MeatBiz kiểm tra');

    const passwordHash=await bcrypt.hash(String(data.password),10);
    const description=data.description||data.transfer_note||'';
    const emailToken=email?randomToken():'';

    const [ins]=await pool.query(
      `INSERT INTO customer_account_registrations(
        full_name,business_name,owner_name,phone,email,address,username,password_hash,
        service_plan,payment_method,transfer_note,description,status,
        email_verify_token_hash,email_verify_expires_at,phone_otp_hash,phone_otp_expires_at,phone_otp_sent_at,verification_status
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'PENDING', ?, DATE_ADD(NOW(), INTERVAL 24 HOUR), NULL, NULL, NULL, 'PENDING')`,
      [fullName,data.business_name||fullName,data.owner_name||fullName,phone,email,data.address||'',username,passwordHash,
       data.service_plan||'TRIAL',data.payment_method||'NONE',data.transfer_note||'',description,
       sha256(emailToken)]
    );

    const registrationId=ins.insertId;
    const verifyUrl=email?appUrl(`/verify-email?token=${emailToken}`):'';
    const mailPayload={id:registrationId,full_name:fullName,username,phone,email,description,verifyUrl};

    await notification.sendSupportMail({
      subject:`[MeatBiz] Đăng ký tài khoản mới: ${fullName}`,
      text:`Có đăng ký MeatBiz mới\nHọ tên: ${fullName}\nUsername: ${username}\nPhone: ${phone}\nEmail: ${email||''}\nNhu cầu: ${description||''}\nTrạng thái: chờ khách verify email/phone và admin kích hoạt`,
      html:notification.registrationHtml(mailPayload)
    }).catch(e=>console.error('Send registration support mail failed:',e.message));

    if(email){
      await notification.sendMail({
        to:email,
        subject:'Xác minh email đăng ký MeatBiz',
        text:`Chào ${fullName}, vui lòng bấm link để xác minh email MeatBiz: ${verifyUrl}. Link hết hạn sau 24 giờ.`,
        html:notification.verifyEmailHtml({fullName,verifyUrl})
      }).catch(e=>console.error('Send verify email failed:',e.message));
    }
    await this.logEvent({event_type:'REGISTRATION_CREATED',registration_id:registrationId,identifier:username,message:'Created pending registration',req});

    return {
      message: 'Đã gửi đăng ký. Vui lòng kiểm tra email để xác minh, MeatBiz sẽ kích hoạt sau khi kiểm tra.',
      registration_id: registrationId,
      requires_email_verify: true,
      requires_phone_verify: false
    };
  }

  async verifyEmail(token, req){
    await this.ensureSchema();
    const tokenHash=sha256(token||'');
    if(!token) throw new Error('Thiếu token xác minh email');
    const [rows]=await pool.query(`SELECT id,email_verified_at,email FROM customer_account_registrations WHERE email_verify_token_hash=? AND email_verify_expires_at>NOW() LIMIT 1`,[tokenHash]);
    if(!rows.length){
      await this.logEvent({event_type:'EMAIL_VERIFY_FAILED',identifier:'token',success_flg:0,message:'Invalid or expired token',req});
      throw new Error('Link xác minh email không hợp lệ hoặc đã hết hạn');
    }
    const r=rows[0];
    await pool.query(`UPDATE customer_account_registrations SET email_verified_at=IFNULL(email_verified_at,NOW()), email_verify_token_hash=NULL, verification_status='VERIFIED', updated_at=NOW() WHERE id=?`,[r.id]);
    await this.logEvent({event_type:'EMAIL_VERIFIED',registration_id:r.id,identifier:r.email,message:'Email verified',req});
    return {message:'Đã xác minh email. MeatBiz sẽ kiểm tra và kích hoạt tài khoản cho bạn.', registration_id:r.id};
  }

  async resendEmailVerify(identifier, req){
    await this.ensureSchema();
    const value=String(identifier||'').trim().toLowerCase();
    if(!value) throw new Error('Nhập email, số điện thoại hoặc tài khoản');
    const [rows]=await pool.query(`SELECT * FROM customer_account_registrations WHERE username=? OR phone=? OR email=? ORDER BY id DESC LIMIT 1`,[value,value,value]);
    if(!rows.length) throw new Error('Không tìm thấy đăng ký');
    const r=rows[0];
    if(!r.email) throw new Error('Đăng ký này chưa có email');
    if(r.email_verified_at) return {message:'Email đã được xác minh'};
    const token=randomToken();
    await pool.query(`UPDATE customer_account_registrations SET email_verify_token_hash=?, email_verify_expires_at=DATE_ADD(NOW(), INTERVAL 24 HOUR), updated_at=NOW() WHERE id=?`,[sha256(token),r.id]);
    const verifyUrl=appUrl(`/verify-email?token=${token}`);
    await notification.sendMail({to:r.email,subject:'Gửi lại link xác minh MeatBiz',text:`Link xác minh MeatBiz: ${verifyUrl}. Link hết hạn sau 24 giờ.`}).catch(e=>console.error('Resend verify email failed:',e.message));
    await this.logEvent({event_type:'EMAIL_VERIFY_RESENT',registration_id:r.id,identifier:value,message:'Resent verify email',req});
    return {message:'Đã gửi lại link xác minh email'};
  }

  async requestPhoneOtp(identifier, req){
    await this.ensureSchema();
    await this.logEvent({event_type:'PHONE_OTP_DEVELOPING',identifier:String(identifier||''),success_flg:0,message:'Phone OTP is under development',req});
    return {message:'Đăng ký / xác minh bằng số điện thoại đang phát triển. Vui lòng dùng email để xác minh tài khoản.', developing:true};
  }

  async verifyPhone({identifier,otp}, req){
    await this.ensureSchema();
    await this.logEvent({event_type:'PHONE_VERIFY_DEVELOPING',identifier:String(identifier||''),success_flg:0,message:'Phone verify is under development',req});
    return {message:'Xác minh số điện thoại đang phát triển. Vui lòng dùng email để xác minh tài khoản.', developing:true};
  }

  async list(){
    await this.ensureSchema();
    const [rows]=await pool.query(
      `SELECT r.id,r.full_name,r.business_name,r.owner_name,r.phone,r.email,r.address,r.username,
              r.service_plan,r.payment_method,r.transfer_note,r.description,r.status,r.verification_status,
              r.email_verified_at,r.phone_verified_at,r.customer_id,r.user_id,r.approved_at,r.rejected_at,r.created_at,r.updated_at,
              u.is_active user_is_active,c.customer_code,c.name customer_name
       FROM customer_account_registrations r
       LEFT JOIN users u ON u.id=r.user_id
       LEFT JOIN customers c ON c.id=r.customer_id
       ORDER BY r.id DESC`
    );
    return rows;
  }

  async approve(id, adminUserId){
    await this.ensureSchema();
    const conn=await pool.getConnection();
    try{
      await conn.beginTransaction();
      const [rows]=await conn.query(`SELECT * FROM customer_account_registrations WHERE id=? FOR UPDATE`,[id]);
      if(!rows.length) throw new Error('Không tìm thấy đăng ký');
      const r=rows[0];
      if(r.status==='APPROVED'&&r.user_id){ await conn.commit(); return {message:'Tài khoản này đã được kích hoạt',user_id:r.user_id,customer_id:r.customer_id}; }
      if(r.email && !r.email_verified_at) throw new Error('Khách chưa xác minh email, chưa thể kích hoạt');

      const [dups]=await conn.query(`SELECT id FROM users WHERE username=? OR phone=? OR (email<>'' AND email=?) LIMIT 1`,[r.username,r.phone||'',r.email||'']);
      if(dups.length) throw new Error(`Tên đăng nhập, email hoặc số điện thoại đã tồn tại trong bảng users`);

      let customerId=r.customer_id;
      if(!customerId){
        const [cust]=await conn.query(
          `INSERT INTO customers(customer_code,name,phone,address,note,is_active,del_flg) VALUES(?,?,?,?,?,1,0)`,
          ['TMP',r.business_name||r.full_name||r.owner_name||r.username,r.phone||'',r.address||'',`Tạo tự động từ đăng ký tài khoản #${r.id}`]
        );
        customerId=cust.insertId;
        await conn.query(`UPDATE customers SET customer_code=? WHERE id=?`,[makeCustomerCode(customerId),customerId]);
      }

      const fullName=r.full_name||r.owner_name||r.business_name||r.username;
      if(!r.password_hash) throw new Error('Đăng ký chưa có password_hash, vui lòng yêu cầu khách đăng ký lại');
      const [user]=await conn.query(
        `INSERT INTO users(username,full_name,phone,email,password_hash,role,customer_id,is_active) VALUES(?,?,?,?,?,'CUSTOMER',?,1)`,
        [r.username,fullName,r.phone||'',r.email||'',r.password_hash,customerId]
      );
      const userId=user.insertId;
      await conn.query(`UPDATE customer_account_registrations SET status='APPROVED',verification_status='VERIFIED',customer_id=?,user_id=?,approved_at=NOW(),approved_by=?,updated_at=NOW() WHERE id=?`,[customerId,userId,adminUserId||null,id]);
      await conn.commit();

      const notice=`Tài khoản MeatBiz của bạn đã được kích hoạt. Tên đăng nhập: ${r.username}`;
      if(r.email) notification.sendMail({to:r.email,subject:'Tài khoản MeatBiz đã được kích hoạt',text:notice,html:notification.approvedHtml({fullName,username:r.username})}).catch(e=>console.error('Send approve email failed:',e.message));
      await this.logEvent({event_type:'REGISTRATION_APPROVED',registration_id:id,identifier:r.username,message:'Approved registration'});

      return {message:'Đã duyệt đăng ký, tạo khách hàng và kích hoạt user đăng nhập',user_id:userId,customer_id:customerId};
    }catch(e){ await conn.rollback(); throw e; }finally{ conn.release(); }
  }

  async reject(id){
    await this.ensureSchema();
    await pool.query(`UPDATE customer_account_registrations SET status='REJECTED',rejected_at=NOW(),updated_at=NOW() WHERE id=?`,[id]);
    await this.logEvent({event_type:'REGISTRATION_REJECTED',registration_id:id,message:'Rejected registration'});
    return {message:'Đã từ chối đăng ký'};
  }

  async updateStatus(id,status, adminUserId){
    if(!['PENDING','APPROVED','REJECTED'].includes(status)) throw new Error('Trạng thái không hợp lệ');
    if(status==='APPROVED') return this.approve(id, adminUserId);
    if(status==='REJECTED') return this.reject(id);
    await this.ensureSchema();
    await pool.query(`UPDATE customer_account_registrations SET status='PENDING',updated_at=NOW() WHERE id=?`,[id]);
    return {message:'Đã chuyển về trạng thái chờ duyệt'};
  }
}

module.exports=new RegistrationAgent();
