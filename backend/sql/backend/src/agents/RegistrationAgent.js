const pool=require('../config/db');
const bcrypt=require('bcryptjs');

function makeCustomerCode(id){
  return 'KH'+String(id).padStart(5,'0');
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
      status ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
      customer_id BIGINT NULL,
      user_id BIGINT NULL,
      approved_at DATETIME NULL,
      rejected_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_registration_username(username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await this.ensureColumn('customer_account_registrations','full_name',`VARCHAR(255) NULL`);
    await this.ensureColumn('customer_account_registrations','password_hash',`VARCHAR(255) NULL`);
    await this.ensureColumn('customer_account_registrations','description',`TEXT NULL`);
    await this.ensureColumn('customer_account_registrations','customer_id',`BIGINT NULL`);
    await this.ensureColumn('customer_account_registrations','user_id',`BIGINT NULL`);
    await this.ensureColumn('customer_account_registrations','approved_at',`DATETIME NULL`);
    await this.ensureColumn('customer_account_registrations','rejected_at',`DATETIME NULL`);
  }

  async create(data){
    await this.ensureSchema();

    const fullName=(data.full_name||data.owner_name||data.business_name||'').trim();
    const username=(data.username||'').trim();
    const phone=String(data.phone||'').trim();
    const email=String(data.email||'').trim();

    if(!fullName) throw new Error('Nhập Full name');
    if(!username) throw new Error('Nhập tài khoản mong muốn');
    if(!phone) throw new Error('Nhập số điện thoại');
    if(!data.password) throw new Error('Nhập mật khẩu');

    const [u]=await pool.query(`SELECT id FROM users WHERE username=? LIMIT 1`,[username]);
    if(u.length) throw new Error('Tên đăng nhập đã tồn tại, vui lòng chọn tên khác');

    const [r]=await pool.query(`SELECT id,status FROM customer_account_registrations WHERE username=? LIMIT 1`,[username]);
    if(r.length) throw new Error('Tài khoản này đã gửi đăng ký, vui lòng chờ admin duyệt');

    const passwordHash=await bcrypt.hash(String(data.password),10);

    await pool.query(
      `INSERT INTO customer_account_registrations(
        full_name,business_name,owner_name,phone,email,address,username,password_hash,
        service_plan,payment_method,transfer_note,description,status
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'PENDING')`,
      [
        fullName,
        data.business_name||fullName,
        data.owner_name||fullName,
        phone,
        email,
        data.address||'',
        username,
        passwordHash,
        data.service_plan||'TRIAL',
        data.payment_method||'NONE',
        data.transfer_note||'',
        data.description||data.transfer_note||''
      ]
    );

    return {message:'Đã gửi đăng ký tài khoản. Admin sẽ kiểm tra, kích hoạt và phân quyền dùng thử.'};
  }

  async list(){
    await this.ensureSchema();
    const [rows]=await pool.query(
      `SELECT r.id,r.full_name,r.business_name,r.owner_name,r.phone,r.email,r.address,r.username,
              r.service_plan,r.payment_method,r.transfer_note,r.description,r.status,
              r.customer_id,r.user_id,r.approved_at,r.rejected_at,r.created_at,r.updated_at,
              u.is_active user_is_active,c.customer_code,c.name customer_name
       FROM customer_account_registrations r
       LEFT JOIN users u ON u.id=r.user_id
       LEFT JOIN customers c ON c.id=r.customer_id
       ORDER BY r.id DESC`
    );
    return rows;
  }

  async approve(id){
    await this.ensureSchema();
    const conn=await pool.getConnection();
    try{
      await conn.beginTransaction();

      const [rows]=await conn.query(`SELECT * FROM customer_account_registrations WHERE id=? FOR UPDATE`,[id]);
      if(!rows.length) throw new Error('Không tìm thấy đăng ký');
      const r=rows[0];

      if(r.status==='APPROVED'&&r.user_id){
        await conn.commit();
        return {message:'Tài khoản này đã được kích hoạt',user_id:r.user_id,customer_id:r.customer_id};
      }

      const [dups]=await conn.query(`SELECT id FROM users WHERE username=? LIMIT 1`,[r.username]);
      if(dups.length) throw new Error(`Tên đăng nhập "${r.username}" đã tồn tại trong bảng users`);

      let customerId=r.customer_id;
      if(!customerId){
        const [cust]=await conn.query(
          `INSERT INTO customers(customer_code,name,phone,address,note,is_active,del_flg)
           VALUES(?,?,?,?,?,1,0)`,
          [
            'TMP',
            r.business_name||r.full_name||r.owner_name||r.username,
            r.phone||'',
            r.address||'',
            `Tạo tự động từ đăng ký tài khoản #${r.id}`
          ]
        );
        customerId=cust.insertId;
        await conn.query(`UPDATE customers SET customer_code=? WHERE id=?`,[makeCustomerCode(customerId),customerId]);
      }

      const fullName=r.full_name||r.owner_name||r.business_name||r.username;
      const passwordHash=r.password_hash;
      if(!passwordHash) throw new Error('Đăng ký chưa có password_hash, vui lòng yêu cầu khách đăng ký lại');

      const [user]=await conn.query(
        `INSERT INTO users(username,full_name,phone,email,password_hash,role,customer_id,is_active)
         VALUES(?,?,?,?,?,'CUSTOMER',?,1)`,
        [r.username,fullName,r.phone||'',r.email||'',passwordHash,customerId]
      );
      const userId=user.insertId;

      await conn.query(
        `UPDATE customer_account_registrations
         SET status='APPROVED',customer_id=?,user_id=?,approved_at=NOW(),updated_at=NOW()
         WHERE id=?`,
        [customerId,userId,id]
      );

      await conn.commit();
      return {
        message:'Đã duyệt đăng ký, tạo khách hàng và kích hoạt user đăng nhập',
        user_id:userId,
        customer_id:customerId
      };
    }catch(e){
      await conn.rollback();
      throw e;
    }finally{
      conn.release();
    }
  }

  async reject(id){
    await this.ensureSchema();
    await pool.query(
      `UPDATE customer_account_registrations
       SET status='REJECTED',rejected_at=NOW(),updated_at=NOW()
       WHERE id=?`,
      [id]
    );
    return {message:'Đã từ chối đăng ký'};
  }

  async updateStatus(id,status){
    if(!['PENDING','APPROVED','REJECTED'].includes(status)) throw new Error('Trạng thái không hợp lệ');
    if(status==='APPROVED') return this.approve(id);
    if(status==='REJECTED') return this.reject(id);
    await this.ensureSchema();
    await pool.query(`UPDATE customer_account_registrations SET status='PENDING',updated_at=NOW() WHERE id=?`,[id]);
    return {message:'Đã chuyển về trạng thái chờ duyệt'};
  }
}

module.exports=new RegistrationAgent();
