import React,{useEffect,useState}from'react';
import api from'../api/api';
import {showSuccess,showError,showWarning,showInfo} from'../utils/toast';
import {validatePasswordStrength} from'../utils/passwordValidator';

const EMPTY_FORM={
 full_name:'',
 username:'',
 phone:'',
 email:'',
 password:'',
 confirm_password:'',
 description:''
};

const registerStyles=`
.mb-register-v7{min-height:100vh;width:100%;padding:28px;background:#F8FAFC;color:#1F2937;}
.mb-register-v7 *{box-sizing:border-box;}
.mb-register-v7__wrap{max-width:1280px;margin:0 auto;display:grid;grid-template-columns:minmax(420px,.92fr) minmax(420px,520px);gap:24px;align-items:start;min-height:calc(100vh - 56px);padding-top:18px;padding-bottom:18px;}
.mb-register-v7__hero{border-radius:34px;padding:30px;position:sticky;top:24px;background:linear-gradient(145deg,#1558B0 0%,#1A73E8 60%,#2563EB 100%);color:white;box-shadow:0 8px 40px rgba(26,115,232,.22);position:relative;overflow:hidden;}
.mb-register-v7__hero:before{content:"";position:absolute;right:-90px;top:-90px;width:270px;height:270px;border-radius:999px;background:rgba(255,255,255,.08);}
.mb-register-v7__hero:after{content:"";position:absolute;left:-70px;bottom:-105px;width:285px;height:285px;border-radius:999px;background:rgba(191,219,254,.14);}
.mb-register-v7__hero>*{position:relative;z-index:1;}
.mb-register-v7__pill{display:inline-flex;align-items:center;gap:8px;padding:9px 14px;border-radius:999px;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.28);font-weight:600;margin-bottom:22px;}
.mb-register-v7 h1{font-size:42px;line-height:1.05;margin:0 0 16px;font-weight:800;letter-spacing:-1.7px;}
.mb-register-v7__lead{font-size:17px;line-height:1.68;color:rgba(255,255,255,.82);max-width:640px;margin:0 0 20px;}
.mb-register-v7__features{display:grid;grid-template-columns:1fr;gap:10px;margin:18px 0;}
.mb-register-v7__feature{background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.18);border-radius:18px;padding:12px 14px;backdrop-filter:blur(10px);}
.mb-register-v7__feature b{display:block;font-size:15px;margin-bottom:7px;color:#fff;}
.mb-register-v7__feature span{display:block;color:rgba(255,255,255,.72);font-size:13px;line-height:1.48;}
.mb-register-v7__steps{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:18px;}
.mb-register-v7__step{display:flex;gap:8px;align-items:center;background:#fff;border-radius:16px;padding:10px;color:#1558B0;font-weight:600;min-width:0;}
.mb-register-v7__step strong{flex:0 0 auto;display:grid;place-items:center;width:31px;height:31px;border-radius:999px;background:#EFF6FF;color:#1A73E8;}
.mb-register-v7__card{width:100%;border-radius:30px;padding:24px;border:1px solid #E2E8F0;background:#FFFFFF;box-shadow:0 4px 24px rgba(15,23,42,.08);}
.mb-register-v7__eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:1.6px;color:#1A73E8;font-weight:600;margin-bottom:6px;}
.mb-register-v7 h2{font-size:26px;margin:0 0 8px;color:#1F2937;letter-spacing:-.8px;}
.mb-register-v7__sub{margin:0 0 14px;color:#64748B;line-height:1.58;}
.mb-register-v7__alert{padding:13px 15px;border-radius:16px;font-weight:500;margin-bottom:14px;}
.mb-register-v7__alert--success{background:#ecfdf5;color:#166534;border:1px solid #bbf7d0;}
.mb-register-v7__alert--error{background:#fef2f2;color:#991b1b;border:1px solid #fecaca;}
.mb-register-v7__grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
.mb-register-v7__field{display:grid;gap:7px;font-weight:500;color:#374151;}
.mb-register-v7__field span{font-size:13px;}
.mb-register-v7__field--full{grid-column:1 / -1;}
.mb-register-v7__input{width:100%;padding:11px 13px;border:1px solid #E2E8F0;border-radius:16px;outline:none;background:#fff;color:#1F2937;font:inherit;transition:.18s box-shadow,.18s border-color;}
.mb-register-v7__input:focus{border-color:#1A73E8;background:#fff;box-shadow:0 0 0 3px rgba(26,115,232,.12);}
.mb-register-v7__textarea{min-height:78px;resize:vertical;}
.mb-register-v7__password{position:relative;}
.mb-register-v7__password .mb-register-v7__input{padding-right:76px;}
.mb-register-v7__toggle{position:absolute;right:8px;top:50%;transform:translateY(-50%);border:0;background:#EFF6FF;color:#1A73E8;border-radius:12px;padding:7px 10px;font-weight:600;cursor:pointer;}
.mb-register-v7__note{margin:12px 0 14px;padding:11px 13px;border-radius:16px;background:#EFF6FF;color:#1558B0;border:1px solid #BFDBFE;font-weight:500;line-height:1.45;}
.mb-register-v7__actions{display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end;}
.mb-register-v7__btn{border:0;border-radius:14px;padding:12px 17px;font-weight:600;cursor:pointer;background:#1A73E8;color:#fff;box-shadow:0 2px 8px rgba(26,115,232,.22);}
.mb-register-v7__btn:disabled{opacity:.68;cursor:not-allowed;}
.mb-register-v7__btn--secondary{background:#fff;color:#1A73E8;border:1px solid #BFDBFE;box-shadow:none;}
@media(max-width:1100px){.mb-register-v7{padding:18px}.mb-register-v7__wrap{grid-template-columns:1fr;align-items:start;}.mb-register-v7 h1{font-size:38px}.mb-register-v7__card{max-width:760px;margin:0 auto;}.mb-register-v7__hero{max-width:760px;margin:0 auto;width:100%;position:relative;top:auto;}}
@media(max-width:720px){.mb-register-v7__hero,.mb-register-v7__card{border-radius:24px;padding:22px}.mb-register-v7 h1{font-size:34px}.mb-register-v7__features,.mb-register-v7__steps,.mb-register-v7__grid{grid-template-columns:1fr}.mb-register-v7__actions{justify-content:stretch}.mb-register-v7__btn{width:100%;}.mb-register-v7__wrap{gap:16px;}}
.mb-register-v7__input::placeholder{color:#94A3B8;font-weight:400;opacity:1;}
.mb-register-v7__pw-hint{grid-column:1 / -1;font-size:12px;font-weight:400;color:#64748B;margin-top:-2px;line-height:1.5;}
`;

const normalizeEmail=(v)=>String(v||'').trim().toLowerCase();
const isValidEmail=(v)=>{
 const email=normalizeEmail(v);
 if(!email || email.length>254 || /\s/.test(email)) return false;
 const re=/^[^\s@<>(),;:\\"\[\]]+@([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$/;
 if(!re.test(email)) return false;
 const [local,domain]=email.split('@');
 if(!local || !domain || local.startsWith('.') || local.endsWith('.')) return false;
 if(domain.split('.').some(p=>!p || p.startsWith('-') || p.endsWith('-'))) return false;
 return true;
};

export default function RegisterAccount({onBack}){
 const[form,setForm]=useState(EMPTY_FORM);
 const[done,setDone]=useState('');
 const[error,setError]=useState('');
 const[loading,setLoading]=useState(false);
 const[showPassword,setShowPassword]=useState(false);
 const[showConfirmPassword,setShowConfirmPassword]=useState(false);
 const[registeredIdentifier,setRegisteredIdentifier]=useState('');
 const[phoneOtp,setPhoneOtp]=useState('');
 const[verifyingPhone,setVerifyingPhone]=useState(false);

 useEffect(()=>{
  setForm(EMPTY_FORM);
  setDone('');
  setError('');
  setShowPassword(false);
  setShowConfirmPassword(false);
 },[]);

 const set=(k,v)=>setForm(prev=>({...prev,[k]:v}));


 const phoneRegisterDeveloping=()=>{
  const message='Đăng ký / xác minh bằng số điện thoại đang phát triển. Vui lòng đăng ký bằng email để MeatBiz xác minh tài khoản.';
  setDone('');
  setError('');
  showInfo(message);
 };

 const save=async(e)=>{
  e.preventDefault();
  setError('');
  setDone('');

  if(!form.full_name?.trim()){showWarning('Nhập họ tên');return setError('Nhập họ tên');}
  if(!form.phone?.trim()){showWarning('Nhập số điện thoại liên hệ');return setError('Nhập số điện thoại liên hệ');}
  if(!form.email?.trim()){showWarning('Nhập email để xác minh tài khoản');return setError('Nhập email để xác minh tài khoản. Đăng ký chỉ bằng số điện thoại đang phát triển.');}
  if(!isValidEmail(form.email)){showWarning('Email không hợp lệ');return setError('Email không hợp lệ. Vui lòng nhập đúng định dạng, ví dụ: ten@posora.vn');}
  if(!form.password){showWarning('Nhập mật khẩu');return setError('Nhập mật khẩu');}
  const pwCheck=validatePasswordStrength(form.password);
  if(!pwCheck.ok){showWarning(pwCheck.message);return setError(pwCheck.message);}
  if(form.password!==form.confirm_password){showWarning('Mật khẩu xác nhận không khớp');return setError('Mật khẩu xác nhận không khớp');}

  setLoading(true);
  try{
    const payload={
      full_name:form.full_name.trim(),
      username:(form.username||form.phone).trim(),
      phone:form.phone.trim(),
      email:normalizeEmail(form.email),
      password:form.password,
      description:form.description||'',
      business_name:form.full_name.trim(),
      owner_name:form.full_name.trim(),
      service_plan:'TRIAL',
      payment_method:'NONE',
      address:'',
      transfer_note:form.description||''
    };

    const r=await api.post('/registrations/public',payload);
    const message=r.data.message||'Đã gửi đăng ký tài khoản. Admin sẽ kiểm tra và kích hoạt.';
    setRegisteredIdentifier(payload.phone||payload.username);
    setDone(message);
    showSuccess(message);
    setForm(EMPTY_FORM);
    setShowPassword(false);
    setShowConfirmPassword(false);
  }catch(e){
    const message=e.response?.data?.message||e.message;
    setError(message);
    showError(message);
  }finally{
    setLoading(false);
  }
 };

 return <div className="mb-register-v7">
  <style>{registerStyles}</style>
  <div className="mb-register-v7__wrap">
   <section className="mb-register-v7__hero">
    <div className="mb-register-v7__pill">MeatBiz AI-native ERP</div>
    <h1>Đăng ký dùng MeatBiz</h1>
    <p className="mb-register-v7__lead">Hệ thống quản lý bán sỉ thịt tươi với POS, công nợ, tồn kho, nhập hàng và AI điều hành trong một giao diện gọn.</p>

    <div className="mb-register-v7__features">
     <div className="mb-register-v7__feature"><b>AI tạo bill POS</b><span>Nói hoặc nhập đơn hàng, hệ thống lập nháp để xác nhận.</span></div>
     <div className="mb-register-v7__feature"><b>AI nhập hàng</b><span>Dự báo hàng sắp thiếu và lập nháp phiếu mua hàng.</span></div>
     <div className="mb-register-v7__feature"><b>Công nợ thông minh</b><span>Theo dõi khách nợ cao, bill chưa thanh toán và lịch sử thu tiền.</span></div>
     <div className="mb-register-v7__feature"><b>Âm lịch / Dương lịch</b><span>Phù hợp cách tính bill của khách hàng bán sỉ.</span></div>
    </div>

    <div className="mb-register-v7__steps">
     <div className="mb-register-v7__step"><strong>1</strong><span>Gửi thông tin</span></div>
     <div className="mb-register-v7__step"><strong>2</strong><span>Admin kiểm tra</span></div>
     <div className="mb-register-v7__step"><strong>3</strong><span>Kích hoạt tài khoản</span></div>
    </div>
   </section>

   <form className="mb-register-v7__card" onSubmit={save} autoComplete="off">
    <div className="mb-register-v7__eyebrow">Tài khoản mới</div>
    <h2>Thông tin đăng ký</h2>
    <p className="mb-register-v7__sub">Nhập thông tin liên hệ để MeatBiz kích hoạt tài khoản cho bạn.</p>

    {done&&<div className="mb-register-v7__alert mb-register-v7__alert--success">{done}</div>}
    {error&&<div className="mb-register-v7__alert mb-register-v7__alert--error">{error}</div>}

    <div className="mb-register-v7__grid">
     <label className="mb-register-v7__field"><span>Họ tên *</span><input className="mb-register-v7__input" autoComplete="off" placeholder="Họ và tên" value={form.full_name} onChange={e=>set('full_name',e.target.value)}/></label>
     <label className="mb-register-v7__field"><span>Tên đăng nhập</span><input className="mb-register-v7__input" autoComplete="new-username" placeholder="Tên đăng nhập" value={form.username} onChange={e=>set('username',e.target.value)}/></label>
     <label className="mb-register-v7__field"><span>Số điện thoại *</span><input className="mb-register-v7__input" autoComplete="off" placeholder="Số điện thoại" value={form.phone} onChange={e=>set('phone',e.target.value)}/></label>
     <label className="mb-register-v7__field"><span>Email *</span><input className="mb-register-v7__input" autoComplete="off" type="email" inputMode="email" placeholder="Email" value={form.email} onChange={e=>set('email',e.target.value)}/></label>

     <label className="mb-register-v7__field"><span>Mật khẩu *</span><div className="mb-register-v7__password">
      <input className="mb-register-v7__input" autoComplete="new-password" type={showPassword?'text':'password'} placeholder="Mật khẩu" value={form.password} onChange={e=>set('password',e.target.value)}/>
      <button className="mb-register-v7__toggle" type="button" onClick={()=>setShowPassword(!showPassword)}>{showPassword?'Ẩn':'Hiện'}</button>
     </div></label>

     <label className="mb-register-v7__field"><span>Xác nhận mật khẩu *</span><div className="mb-register-v7__password">
      <input className="mb-register-v7__input" autoComplete="new-password" type={showConfirmPassword?'text':'password'} placeholder="Nhập lại mật khẩu" value={form.confirm_password} onChange={e=>set('confirm_password',e.target.value)}/>
      <button className="mb-register-v7__toggle" type="button" onClick={()=>setShowConfirmPassword(!showConfirmPassword)}>{showConfirmPassword?'Ẩn':'Hiện'}</button>
     </div></label>

     <p className="mb-register-v7__pw-hint">8–16 ký tự, gồm chữ hoa, chữ thường, số và ký tự đặc biệt.</p>

     <label className="mb-register-v7__field mb-register-v7__field--full"><span>Nhu cầu sử dụng</span><textarea className="mb-register-v7__input mb-register-v7__textarea" placeholder="Ví dụ: tạo bill POS, quản lý công nợ, bảng giá riêng, nhập hàng, báo cáo doanh thu..." value={form.description} onChange={e=>set('description',e.target.value)}/></label>
    </div>

    <div className="mb-register-v7__note">✓ Hệ thống sẽ gửi link xác minh đến email của khách và gửi thông báo đăng ký về support@posora.vn để MeatBiz kiểm tra, kích hoạt.</div>

    <div className="mb-register-v7__note" style={{background:'#fff7ed',borderColor:'#fed7aa',color:'#9a3412'}}>
      <b>Đăng ký chỉ bằng số điện thoại</b>
      <div style={{marginTop:8}}>Tính năng này đang phát triển. Hiện tại vui lòng dùng email để xác minh tài khoản.</div>
      <button type="button" className="mb-register-v7__btn mb-register-v7__btn--secondary" style={{marginTop:12}} onClick={phoneRegisterDeveloping}>Đăng ký bằng số điện thoại</button>
    </div>


    <div className="mb-register-v7__actions">
     <button className="mb-register-v7__btn" disabled={loading}>{loading?'Đang gửi...':'Gửi đăng ký'}</button>
     <button type="button" className="mb-register-v7__btn mb-register-v7__btn--secondary" onClick={onBack}>Quay lại đăng nhập</button>
    </div>
   </form>
  </div>
 </div>
}
