const express=require('express');
const bcrypt=require('bcryptjs');
const jwt=require('jsonwebtoken');
const pool=require('../config/db');
const router=express.Router();
const UserPermissionAgent=require('../agents/UserPermissionAgent');

router.post('/login', async (req,res,next)=>{
  try {
    const {username,password}=req.body;
    const [rows]=await pool.query(`SELECT id,username,full_name,password_hash,role,customer_id,is_active FROM users WHERE username=? LIMIT 1`, [username]);
    if (!rows.length || !rows[0].is_active) return res.status(401).json({message:'Sai user hoặc mật khẩu'});
    const u=rows[0]; let ok=false;
    if (String(u.password_hash||'').startsWith('$2')) ok=await bcrypt.compare(password,u.password_hash);
    else if (process.env.ALLOW_PLAIN_PASSWORD==='true') {
      ok=password===u.password_hash;
      if (ok) await pool.query(`UPDATE users SET password_hash=? WHERE id=?`, [await bcrypt.hash(password,10), u.id]);
    }
    if (!ok) return res.status(401).json({message:'Sai user hoặc mật khẩu'});
    const token=jwt.sign({id:u.id,username:u.username,full_name:u.full_name,role:u.role,customer_id:u.customer_id}, process.env.JWT_SECRET||'dev_secret', {expiresIn:'7d'});
    res.json({token,user:{id:u.id,username:u.username,full_name:u.full_name,role:u.role,customer_id:u.customer_id}});
  } catch(e) { next(e); }
});
module.exports=router;
