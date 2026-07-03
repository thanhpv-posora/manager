const express=require('express');
const bcrypt=require('bcryptjs');
const jwt=require('jsonwebtoken');
const rateLimit=require('express-rate-limit');
const pool=require('../config/db');
const router=express.Router();
const {auth}=require('../middleware/auth');
const UserPermissionAgent=require('../agents/UserPermissionAgent');
const notification=require('../services/notification.service');
const {validatePasswordStrength}=require('../utils/passwordValidator');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Quá nhiều yêu cầu. Vui lòng thử lại sau 15 phút.' },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const username = String(req.body.username || '').toLowerCase().trim();
    return username ? `${req.ip}:${username}` : req.ip;
  },
  message: { message: 'Đăng nhập sai quá nhiều lần. Vui lòng thử lại sau 15 phút.' },
});

function signUser(u){
  const token=jwt.sign({id:u.id,username:u.username,full_name:u.full_name,role:u.role,customer_id:u.customer_id}, process.env.JWT_SECRET, {expiresIn:'7d'});
  return {token,user:{id:u.id,username:u.username,full_name:u.full_name,role:u.role,customer_id:u.customer_id}};
}

function randomCode(){
  return String(Math.floor(100000+Math.random()*900000));
}

async function findUserByLogin(username){
  const value=String(username||'').trim();
  const [rows]=await pool.query(`SELECT id,username,full_name,password_hash,role,customer_id,is_active,phone,email,failed_login_count,locked_until,last_failed_login FROM users WHERE username=? OR phone=? OR email=? LIMIT 1`, [value,value,value]);
  return rows[0]||null;
}

router.post('/login', loginLimiter, async (req,res,next)=>{
  try {
    const {username,password}=req.body;
    const u=await findUserByLogin(username);
    if (!u || !u.is_active) return res.status(401).json({message:'Sai user hoặc mật khẩu'});

    if (u.locked_until && new Date(u.locked_until) > new Date()) {
      return res.status(423).json({message:'Tài khoản tạm khóa. Vui lòng thử lại sau 15 phút.'});
    }

    let ok=false;
    if (String(u.password_hash||'').startsWith('$2')) ok=await bcrypt.compare(password,u.password_hash);
    else if (process.env.ALLOW_PLAIN_PASSWORD==='true') {
      ok=password===u.password_hash;
      if (ok) await pool.query(`UPDATE users SET password_hash=? WHERE id=?`, [await bcrypt.hash(password,10), u.id]);
    }

    if (!ok) {
      // Auth lock fix: if locked_until has already expired, treat the failed
      // count as 0 before applying this new failure — otherwise stale counts
      // from a past, already-expired lockout re-trigger a lock on a single
      // new wrong attempt. failed_login_count is reassigned first so the
      // locked_until CASE below can read its updated value (MySQL evaluates
      // single-table UPDATE assignments left to right).
      await pool.query(
        `UPDATE users
         SET failed_login_count = CASE
               WHEN locked_until IS NOT NULL AND locked_until <= NOW() THEN 1
               ELSE failed_login_count + 1
             END,
             last_failed_login = NOW(),
             locked_until = CASE
               WHEN failed_login_count >= 5 THEN DATE_ADD(NOW(), INTERVAL 15 MINUTE)
               WHEN locked_until IS NOT NULL AND locked_until <= NOW() THEN NULL
               ELSE locked_until
             END
         WHERE id = ?`,
        [u.id]
      );
      const [[updated]]=await pool.query(
        `SELECT failed_login_count,locked_until FROM users WHERE id=?`,
        [u.id]
      );
      if (updated.locked_until && new Date(updated.locked_until) > new Date()) {
        return res.status(423).json({message:'Tài khoản tạm khóa do nhập sai mật khẩu quá nhiều lần. Vui lòng thử lại sau 15 phút.'});
      }
      return res.status(401).json({message:'Sai user hoặc mật khẩu'});
    }

    await pool.query(
      `UPDATE users SET failed_login_count=0,locked_until=NULL,last_failed_login=NULL WHERE id=?`,
      [u.id]
    );
    res.json(signUser(u));
  } catch(e) { next(e); }
});

router.post('/request-otp', authLimiter, async(req,res,next)=>{
  try{
    res.status(501).json({message:'Đăng nhập bằng OTP điện thoại đang phát triển. Vui lòng đăng nhập bằng mật khẩu hoặc dùng quên mật khẩu qua email.', developing:true});
  }catch(e){next(e)}
});

router.post('/verify-otp', authLimiter, async(req,res,next)=>{
  try{
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

router.post('/forgot-password', authLimiter, async(req,res,next)=>{
  try{
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

router.post('/reset-password', authLimiter, async(req,res,next)=>{
  try{
    const identifier=String(req.body.identifier||req.body.username||req.body.phone||req.body.email||'').trim();
    const code=String(req.body.code||req.body.otp||'').trim();
    const password=String(req.body.password||'');
    if(!identifier) return res.status(400).json({message:'Nhập email, số điện thoại hoặc tên đăng nhập'});
    if(!code) return res.status(400).json({message:'Nhập mã xác nhận'});
    const pwCheck=validatePasswordStrength(password);
    if(!pwCheck.ok) return res.status(400).json({message:pwCheck.message});
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

router.post('/change-password', auth(), async(req,res,next)=>{
  try{
    const userId=req.user.id;
    const current_password=String(req.body.current_password||'');
    const new_password=String(req.body.new_password||'');
    const confirm_password=String(req.body.confirm_password||'');
    if(!current_password) return res.status(400).json({message:'Nhập mật khẩu hiện tại'});
    if(!new_password) return res.status(400).json({message:'Nhập mật khẩu mới'});
    if(!confirm_password) return res.status(400).json({message:'Xác nhận mật khẩu mới'});
    if(new_password!==confirm_password) return res.status(400).json({message:'Mật khẩu xác nhận không khớp'});
    const pwCheck=validatePasswordStrength(new_password);
    if(!pwCheck.ok) return res.status(400).json({message:pwCheck.message});
    const [rows]=await pool.query(`SELECT id,password_hash FROM users WHERE id=? AND is_active=1 LIMIT 1`,[userId]);
    if(!rows.length) return res.status(404).json({message:'Không tìm thấy tài khoản'});
    const u=rows[0];
    const currentOk=await bcrypt.compare(current_password,u.password_hash);
    if(!currentOk) return res.status(400).json({message:'Mật khẩu hiện tại không đúng'});
    const sameAsCurrent=await bcrypt.compare(new_password,u.password_hash);
    if(sameAsCurrent) return res.status(400).json({message:'Mật khẩu mới phải khác mật khẩu hiện tại'});
    await pool.query(`UPDATE users SET password_hash=? WHERE id=?`,[await bcrypt.hash(new_password,10),userId]);
    res.json({message:'Đã đổi mật khẩu'});
  }catch(e){next(e)}
});

module.exports=router;
