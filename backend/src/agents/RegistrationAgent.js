const pool=require('../config/db');
const bcrypt=require('bcryptjs');

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
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_registration_username(username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await this.ensureColumn('customer_account_registrations','full_name',`VARCHAR(255) NULL`);
    await this.ensureColumn('customer_account_registrations','password_hash',`VARCHAR(255) NULL`);
    await this.ensureColumn('customer_account_registrations','description',`TEXT NULL`);
  }

  async create(data){
    await this.ensureSchema();

    const fullName=(data.full_name||data.owner_name||data.business_name||'').trim();
    const username=(data.username||'').trim();
    const phone=(data.phone||'').trim();
    const email=(data.email||'').trim();

    if(!fullName) throw new Error('Nhập Full name');
    if(!username) throw new Error('Nhập tài khoản mong muốn');
    if(!phone) throw new Error('Nhập số điện thoại');
    if(!data.password) throw new Error('Nhập mật khẩu');

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

    return {message:'Đã gửi đăng ký tài khoản. Admin sẽ kiểm tra và kích hoạt tài khoản.'};
  }

  async list(){
    await this.ensureSchema();
    const [rows]=await pool.query(
      `SELECT id,full_name,business_name,owner_name,phone,email,address,username,
              service_plan,payment_method,transfer_note,description,status,created_at,updated_at
       FROM customer_account_registrations
       ORDER BY id DESC`
    );
    return rows;
  }

  async updateStatus(id,status){
    await this.ensureSchema();
    if(!['PENDING','APPROVED','REJECTED'].includes(status)) throw new Error('Trạng thái không hợp lệ');
    await pool.query(`UPDATE customer_account_registrations SET status=?,updated_at=NOW() WHERE id=?`,[status,id]);
    return {message:'Đã cập nhật trạng thái đăng ký'};
  }
}

module.exports=new RegistrationAgent();
