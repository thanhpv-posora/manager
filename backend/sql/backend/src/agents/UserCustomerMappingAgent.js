const pool=require('../config/db');
const bcrypt=require('bcryptjs');
const RegistrationAgent=require('./RegistrationAgent');

class UserCustomerMappingAgent{
  constructor(){
    this.version='6.46.0';
    this.responsibility='Map user accounts to customers, approve registrations in mapping screen, create customer user account, isolate data by customer_id';
  }

  async list(){
    const [rows]=await pool.query(`SELECT u.id user_id,u.username,u.full_name,u.role,u.customer_id,c.customer_code,c.name customer_name,u.is_active
      FROM users u LEFT JOIN customers c ON c.id=u.customer_id ORDER BY u.id DESC`);
    return rows;
  }

  async pendingRegistrations(){
    return RegistrationAgent.list();
  }

  async approveRegistration(id){
    return RegistrationAgent.updateStatus(id,'APPROVED');
  }

  async rejectRegistration(id){
    return RegistrationAgent.updateStatus(id,'REJECTED');
  }

  async mapUser(data){
    if(!data.user_id||!data.customer_id) throw new Error('Thiếu user hoặc khách hàng');
    await pool.query(`UPDATE users SET customer_id=? WHERE id=?`,[data.customer_id,data.user_id]);
    return {message:'Đã mapping user với khách hàng'};
  }

  async createCustomerUser(data){
    if(!data.customer_id) throw new Error('Chọn khách hàng');
    if(!data.username) throw new Error('Nhập username');
    if(!data.password_hash&&!data.password) throw new Error('Nhập mật khẩu');

    const [exists]=await pool.query(`SELECT id FROM users WHERE username=? LIMIT 1`,[data.username]);
    if(exists.length) throw new Error('Username đã tồn tại');

    const pass=data.password_hash||await bcrypt.hash(String(data.password),10);
    await pool.query(`INSERT INTO users(username,full_name,phone,email,password_hash,role,customer_id,is_active)
      VALUES(?,?,?,?,?,'CUSTOMER',?,1)`,
      [data.username,data.full_name||data.username,data.phone||'',data.email||'',pass,data.customer_id]);
    return {message:'Đã tạo user khách hàng'};
  }
}
module.exports=new UserCustomerMappingAgent();
