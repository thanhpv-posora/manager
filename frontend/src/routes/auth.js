const express=require('express');
const bcrypt=require('bcryptjs');
const jwt=require('jsonwebtoken');
const pool=require('../config/db');
const router=express.Router();
const UserPermissionAgent=require('../agents/UserPermissionAgent');
const notification=require('../services/notification.service');

function signUser(u){
  const token=jwt.sign({id:u.id,username:u.username,full_name:u.full_name,role:u.role,customer_id:u.customer_id}, process.env.JWT_SECRET||'dev_secret', {expiresIn:'7d'});
  return {token,user:{id:u.id,username:u.username,full_name:u.full_name,role:u.role,customer_id:u.customer_id}};
}

function randomCode(){
  return String(Math.floor(100000+Math.random()*900000));
}

async function ensureColumn(table,column,definition){
  const [rows]=await pool.query(`SELECT COUNT(*) cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?`,[table,column]);
  if(Number(rows[0].cnt)===0){
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function ensureAuthSchema(){
  await ensureColumn('users','phone',`VARCHAR(50) NULL`);
  await ensureColumn('users','email',`VARCHAR(255) NULL`);

  await pool.query(`CREATE TABLE IF NOT EXISTS user_login_otps (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    phone VARCHAR(50) NOT NULL,
    code_hash VARCHAR(255) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    expires_at DATETIME NOT NULL,
    used_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_phone_status(phone,status),
    KEY idx_user_status(user_id,status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await pool.query(`CREATE TABLE IF NOT EXISTS password_reset_requests (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    identifier VARCHAR(255) NOT NULL,
    channel VARCHAR(30) NOT NULL,
    code_hash VARCHAR(255) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    expires_at DATETIME NOT NULL,
    used_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_identifier_status(identifier,status),
    KEY idx_user_status(user_id,status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

async function findUserByLogin(username){
  const value=String(username||'').trim();
  const [rows]=await pool.query(`SELECT id,username,full_name,password_hash,role,customer_id,is_active,phone,email FROM users WHERE username=? OR phone=? OR email=? LIMIT 1`, [value,value,value]);
  return rows[0]||null;
}

router.post('/login', async (req,res,next)=>{
  try {
    await ensureAuthSchema();
    const {username,password}=req.body;
    const u=await findUserByLogin(username);
    if (!u || !u.is_active) return res.status(401).json({message:'Sai user hoặc mật khẩu'});
    let ok=false;
    if (String(u.password_hash||'').startsWith('$2')) ok=await bcrypt.compare(password,u.password_hash);
    else if (process.env.ALLOW_PLAIN_PASSWORD==='true') {
      ok=password===u.password_hash;
      if (ok) await pool.query(`UPDATE users SET password_hash=? WHERE id=?`, [await bcrypt.hash(password,10), u.id]);
    }
    if (!ok) return res.status(401).json({message:'Sai user hoặc mật khẩu'});
    res.json(signUser(u));
  } catch(e) { next(e); }
});

router.post('/request-otp',async(req,res,next)=>{
  try{
    await ensureAuthSchema();
    res.status(501).json({message:'Đăng nhập bằng OTP điện thoại đang phát triển. Vui lòng đăng nhập bằng mật khẩu hoặc dùng quên mật khẩu qua email.', developing:true});
  }catch(e){next(e)}
});

router.post('/verify-otp',async(req,res,next)=>{
  try{
    await ensureAuthSchema();
    const phone=String(req.body.phone||'').trim();
    const otp=String(req.body.otp||'').trim();
    if(!phone) return res.status(400).json({message:'Nhập số điện thoại'});
    if(!otp) return res.status(400).json({message:'Nhập mã OTP'});
    const [rows]=await pool.query(`SELECT o.*,u.username,u.full_name,u.role,u.customer_id,u.is_active,u.email FROM user_login_otps o JOIN users u ON u.id=o.user_id WHERE o.phone=? AND o.status='PENDING' AND o.expires_at>NOW() ORDER BY o.id DESC LIMIT 1`,[phone]);
    if(!rows.length) return res.status(401).json({message:'OTP không hợp lệ hoặc đã hết hạn'});
    const r=rows[0];
    const ok=await bcrypt.compare(otp,r.code_hash);
    if(!ok) return res.status(401).json({message:'OTP không hợp lệ hoặc đã hết hạn'});
    if(!r.is_active) return res.status(401).json({message:'Tài khoản chưa được kích hoạt'});
    await pool.query(`UPDATE user_login_otps SET status='USED',used_at=NOW() WHERE id=?`,[r.id]);
    res.json(signUser({id:r.user_id,username:r.username,full_name:r.full_name,role:r.role,customer_id:r.customer_id}));
  }catch(e){next(e)}
});

router.post('/forgot-password',async(req,res,next)=>{
  try{
    await ensureAuthSchema();
    const identifier=String(req.body.identifier||req.body.username||req.body.phone||req.body.email||'').trim();
    if(!identifier) return res.status(400).json({message:'Nhập email, số điện thoại hoặc tên đăng nhập'});
    const u=await findUserByLogin(identifier);
    if(!u || !u.is_active) return res.status(404).json({message:'Không tìm thấy tài khoản đang hoạt động'});
    const code=randomCode();
    const hash=await bcrypt.hash(code,10);
    if(!u.email) return res.status(400).json({message:'Tài khoản này chưa có email. Vui lòng liên hệ support@posora.vn để đặt lại mật khẩu.'});
    const channel = 'EMAIL';
    await pool.query(`UPDATE password_reset_requests SET status='EXPIRED' WHERE user_id=? AND status='PENDING'`,[u.id]);
    await pool.query(`INSERT INTO password_reset_requests(user_id,identifier,channel,code_hash,expires_at) VALUES(?,?,?,?,DATE_ADD(NOW(), INTERVAL 15 MINUTE))`,[u.id,identifier,channel,hash]);

    await notification.sendMail({
      to:u.email,
      subject:'Mã đặt lại mật khẩu MeatBiz',
      text:`Mã đặt lại mật khẩu MeatBiz của bạn là ${code}. Mã hết hạn sau 15 phút.`,
      html:notification.resetPasswordHtml({fullName:u.full_name,code})
    }).catch(e=>console.error('Send reset email failed:',e.message));
    await notification.sendSupportMail({subject:`[MeatBiz] Yêu cầu quên mật khẩu: ${u.username}`,text:`User ${u.username} yêu cầu đặt lại mật khẩu qua email. Phone: ${u.phone||''}. Email: ${u.email||''}.`}).catch(()=>{});
    res.json({message:'Đã gửi mã đặt lại mật khẩu qua email đã đăng ký.', dev_code:process.env.RETURN_DEV_OTP==='true'?code:undefined});
  }catch(e){next(e)}
});

router.post('/reset-password',async(req,res,next)=>{
  try{
    await ensureAuthSchema();
    const identifier=String(req.body.identifier||req.body.username||req.body.phone||req.body.email||'').trim();
    const code=String(req.body.code||req.body.otp||'').trim();
    const password=String(req.body.password||'');
    if(!identifier) return res.status(400).json({message:'Nhập email, số điện thoại hoặc tên đăng nhập'});
    if(!code) return res.status(400).json({message:'Nhập mã xác nhận'});
    if(password.length<6) return res.status(400).json({message:'Mật khẩu mới nên có ít nhất 6 ký tự'});
    const u=await findUserByLogin(identifier);
    if(!u || !u.is_active) return res.status(404).json({message:'Không tìm thấy tài khoản đang hoạt động'});
    const [rows]=await pool.query(`SELECT * FROM password_reset_requests WHERE user_id=? AND status='PENDING' AND expires_at>NOW() ORDER BY id DESC LIMIT 1`,[u.id]);
    if(!rows.length) return res.status(401).json({message:'Mã xác nhận không hợp lệ hoặc đã hết hạn'});
    const r=rows[0];
    const ok=await bcrypt.compare(code,r.code_hash);
    if(!ok) return res.status(401).json({message:'Mã xác nhận không hợp lệ hoặc đã hết hạn'});
    await pool.query(`UPDATE users SET password_hash=? WHERE id=?`,[await bcrypt.hash(password,10),u.id]);
    await pool.query(`UPDATE password_reset_requests SET status='USED',used_at=NOW() WHERE id=?`,[r.id]);
    res.json({message:'Đã đổi mật khẩu. Bạn có thể đăng nhập bằng mật khẩu mới.'});
  }catch(e){next(e)}
});

module.exports=router;
