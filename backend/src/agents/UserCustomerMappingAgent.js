const pool=require('../config/db');
const bcrypt=require('bcryptjs');
const RegistrationAgent=require('./RegistrationAgent');

class UserCustomerMappingAgent{
  constructor(){
    this.version='6.47.0';
    this.responsibility='Unified user account management: create STAFF users, map to customers, lock/unlock, reset password, approve/reject registrations';
  }

  async list(){
    const [rows]=await pool.query(`SELECT u.id user_id,u.username,u.full_name,u.role,u.customer_id,c.customer_code,c.name customer_name,u.is_active
      FROM users u LEFT JOIN customers c ON c.id=u.customer_id ORDER BY u.id DESC`);
    return rows;
  }

  async pendingRegistrations(){
    return RegistrationAgent.list();
  }

  async approveRegistration(id,adminUserId){
    return RegistrationAgent.updateStatus(id,'APPROVED',adminUserId);
  }

  async rejectRegistration(id){
    return RegistrationAgent.updateStatus(id,'REJECTED');
  }

  async mapUser(data){
    if(!data.user_id||!data.customer_id) throw new Error('Thiếu user hoặc khách hàng');
    await pool.query(`UPDATE users SET customer_id=? WHERE id=?`,[data.customer_id,data.user_id]);
    return {message:'Đã mapping user với khách hàng'};
  }

  async createUser(data,conn=null){
    const db=conn||pool;
    const role=String(data.role||'').trim().toUpperCase();

    if(role==='ADMIN') throw new Error('Không thể tạo tài khoản ADMIN qua module này');
    if(role!=='CUSTOMER'&&role!=='STAFF') throw new Error('Role không hợp lệ');
    if(!data.username) throw new Error('Nhập username');
    if(!data.password_hash&&!data.password) throw new Error('Nhập mật khẩu');

    const customerId=role==='CUSTOMER'?(data.customer_id||null):null;
    if(role==='CUSTOMER'&&!customerId) throw new Error('Chọn khách hàng');

    const [exists]=await db.query(`SELECT id FROM users WHERE username=? LIMIT 1`,[data.username]);
    if(exists.length) throw new Error('Username đã tồn tại');

    const pass=data.password_hash||await bcrypt.hash(String(data.password),10);
    const [ins]=await db.query(
      `INSERT INTO users(username,full_name,phone,email,password_hash,role,customer_id,is_active) VALUES(?,?,?,?,?,?,?,1)`,
      [data.username,data.full_name||data.username,data.phone||'',data.email||'',pass,role,customerId]
    );
    return {message:`Đã tạo tài khoản ${role==='STAFF'?'nội bộ':'khách hàng'}`,user_id:ins.insertId};
  }

  async createCustomerUser(data){
    return this.createUser({...data,role:'CUSTOMER'});
  }

  async lockUser(id){
    if(!id) throw new Error('Thiếu user_id');
    const [r]=await pool.query(`SELECT role FROM users WHERE id=? LIMIT 1`,[id]);
    if(!r.length) throw new Error('Không tìm thấy user');
    if(r[0].role==='ADMIN') throw new Error('Không thể khóa tài khoản ADMIN');
    await pool.query(`UPDATE users SET is_active=0 WHERE id=?`,[id]);
    return {message:'Đã khóa tài khoản'};
  }

  async unlockUser(id){
    if(!id) throw new Error('Thiếu user_id');
    await pool.query(`UPDATE users SET is_active=1 WHERE id=?`,[id]);
    return {message:'Đã mở khóa tài khoản'};
  }

  async resetPassword(id,newPassword){
    if(!id) throw new Error('Thiếu user_id');
    if(!newPassword||String(newPassword).length<6) throw new Error('Mật khẩu phải ít nhất 6 ký tự');
    const [r]=await pool.query(`SELECT role FROM users WHERE id=? LIMIT 1`,[id]);
    if(!r.length) throw new Error('Không tìm thấy user');
    if(r[0].role==='ADMIN') throw new Error('Không thể reset mật khẩu ADMIN qua module này');
    const hash=await bcrypt.hash(String(newPassword),10);
    await pool.query(`UPDATE users SET password_hash=? WHERE id=?`,[hash,id]);
    return {message:'Đã đặt lại mật khẩu'};
  }
}
module.exports=new UserCustomerMappingAgent();
