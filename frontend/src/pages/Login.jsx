import React,{useEffect,useState}from'react';
import {Brain,ChevronRight,Lock,Phone,ShieldCheck,Sparkles,TrendingUp,Truck,Wallet} from'lucide-react';
import api from'../api/api';
import {showSuccess,showError,showWarning,showInfo} from'../utils/toast';

export default function Login({onLogin,onRegister}){
 const[mode,setMode]=useState('PASSWORD');

 const[username,setUsername]=useState(()=>localStorage.getItem('meatbiz_remember_username')||'');
 const[password,setPassword]=useState('');
 const[remember,setRemember]=useState(()=>localStorage.getItem('meatbiz_remember_login')==='1');

 const[phone,setPhone]=useState('');
 const[otp,setOtp]=useState('');
 const[otpSent,setOtpSent]=useState(false);

 const[error,setError]=useState('');
 const[info,setInfo]=useState('');
 const[loading,setLoading]=useState(false);
 const[forgotIdentifier,setForgotIdentifier]=useState('');
 const[forgotCode,setForgotCode]=useState('');
 const[forgotPasswordNew,setForgotPasswordNew]=useState('');
 const[forgotSent,setForgotSent]=useState(false);

 useEffect(()=>{
  if(remember&&username){
    localStorage.setItem('meatbiz_remember_login','1');
    localStorage.setItem('meatbiz_remember_username',username);
  }
 },[remember,username]);

 const submitPassword=async(e)=>{
  e.preventDefault();
  setError('');
  setInfo('');
  setLoading(true);
  try{
    const r=await api.post('/auth/login',{username,password,remember});
    if(remember){
      localStorage.setItem('meatbiz_remember_login','1');
      localStorage.setItem('meatbiz_remember_username',username);
    }else{
      localStorage.removeItem('meatbiz_remember_login');
      localStorage.removeItem('meatbiz_remember_username');
    }
    onLogin(r.data);
  }catch(e){
    const message=e.response?.data?.message||'Đăng nhập thất bại';setError(message);showError(message);
  }finally{
    setLoading(false);
  }
 };

 const requestOtp=async()=>{
  setError('');
  setInfo('');
  const message='Đăng nhập bằng OTP điện thoại đang phát triển. Vui lòng dùng mật khẩu hoặc quên mật khẩu qua email.';
  setError(message);
  showInfo(message);
  return;
  if(!phone.trim()){showWarning('Nhập số điện thoại');return setError('Nhập số điện thoại');}
  setLoading(true);
  try{
    const r=await api.post('/auth/request-otp',{phone});
    setOtpSent(true);
    const message=r.data.message||'Đã gửi OTP về số điện thoại';setInfo(message);showSuccess(message);
  }catch(e){
    const message=e.response?.data?.message||'Chưa gửi được OTP. Kiểm tra backend / SMS provider.';setError(message);showError(message);
  }finally{
    setLoading(false);
  }
 };

 const verifyOtp=async(e)=>{
  e.preventDefault();
  setError('');
  setInfo('');
  if(!phone.trim()){showWarning('Nhập số điện thoại');return setError('Nhập số điện thoại');}
  if(!otp.trim()){showWarning('Nhập mã OTP');return setError('Nhập mã OTP');}
  setLoading(true);
  try{
    const r=await api.post('/auth/verify-otp',{phone,otp,remember});
    onLogin(r.data);
  }catch(e){
    const message=e.response?.data?.message||'OTP không hợp lệ hoặc đã hết hạn';setError(message);showError(message);
  }finally{
    setLoading(false);
  }
 };

 const forgotPassword=async()=>{
  setMode('FORGOT');
  setForgotIdentifier(mode==='OTP'?phone:username);
  setForgotSent(false);
  setForgotCode('');
  setForgotPasswordNew('');
  clearNotice();
 };

 const requestResetPassword=async(e)=>{
  e.preventDefault();
  setError('');
  setInfo('');
  if(!forgotIdentifier.trim()){showWarning('Nhập email, số điện thoại hoặc tên đăng nhập');return setError('Nhập email, số điện thoại hoặc tên đăng nhập');}
  setLoading(true);
  try{
    const r=await api.post('/auth/forgot-password',{identifier:forgotIdentifier.trim()});
    const message=r.data.message||'Đã gửi mã đặt lại mật khẩu';
    setForgotSent(true);
    setInfo(message);
    showInfo(message);
  }catch(e){
    const message=e.response?.data?.message||'Chưa gửi được yêu cầu quên mật khẩu';setError(message);showError(message);
  }finally{setLoading(false);}
 };

 const resetPassword=async(e)=>{
  e.preventDefault();
  setError('');
  setInfo('');
  if(!forgotIdentifier.trim()){showWarning('Nhập tài khoản');return setError('Nhập tài khoản');}
  if(!forgotCode.trim()){showWarning('Nhập mã xác nhận');return setError('Nhập mã xác nhận');}
  if(forgotPasswordNew.length<6){showWarning('Mật khẩu mới nên có ít nhất 6 ký tự');return setError('Mật khẩu mới nên có ít nhất 6 ký tự');}
  setLoading(true);
  try{
    const r=await api.post('/auth/reset-password',{identifier:forgotIdentifier.trim(),code:forgotCode.trim(),password:forgotPasswordNew});
    const message=r.data.message||'Đã đổi mật khẩu';
    setInfo(message);showSuccess(message);
    setMode('PASSWORD');
    setUsername(forgotIdentifier.trim());
    setPassword('');
  }catch(e){
    const message=e.response?.data?.message||'Chưa đổi được mật khẩu';setError(message);showError(message);
  }finally{setLoading(false);}
 };

 const clearNotice=()=>{setError('');setInfo('')};

 return <div className="login-ai-shell">
  <div className="login-ai-orb orb-one"/>
  <div className="login-ai-orb orb-two"/>

  <section className="login-ai-story">
   <div className="login-ai-logo">
    <span>🥩</span>
    <div>
     <b>MeatBiz</b>
     <small>AI-native ERP for meat wholesalers</small>
    </div>
   </div>

   <div className="login-ai-hero-copy">
    <div className="login-ai-pill"><Sparkles size={16}/> AI Operating Center</div>
    <h1>Điều hành bán sỉ thịt nhanh hơn, rõ hơn, chủ động hơn.</h1>
    <p>Đăng nhập để quản lý POS, công nợ, tồn kho, nhập hàng và AI Dashboard trong một giao diện gọn gàng cho hộ kinh doanh.</p>
   </div>

   <div className="login-ai-feature-grid">
    <div><Brain size={22}/><b>AI hiểu nghiệp vụ</b><span>Chat, voice, dashboard và đề xuất hành động.</span></div>
    <div><Truck size={22}/><b>Nhập hàng thông minh</b><span>Dự báo thiếu hàng và lập nháp mua hàng.</span></div>
    <div><Wallet size={22}/><b>Công nợ rõ ràng</b><span>Theo dõi khách nợ cao, bill chưa thanh toán.</span></div>
    <div><TrendingUp size={22}/><b>Tổng quan mỗi ngày</b><span>Doanh thu, bán chạy, tồn kho và việc cần làm.</span></div>
   </div>
  </section>

  <section className="login-ai-card">
   <div className="login-ai-card-head">
    <div className="login-ai-secure"><ShieldCheck size={18}/> Kết nối bảo mật</div>
    <h2>Đăng nhập MeatBiz</h2>
    <p>Chọn cách đăng nhập phù hợp để vào hệ thống điều hành.</p>
   </div>

   <div className="login-tabs ai-login-tabs">
    <button type="button" className={mode==='PASSWORD'?'active':''} onClick={()=>{setMode('PASSWORD');clearNotice()}}>
      <Lock size={16}/> User / mật khẩu
    </button>
    <button type="button" className={mode==='OTP'?'active':''} onClick={()=>{setMode('OTP');clearNotice();setInfo('Đăng nhập OTP điện thoại đang phát triển.')}}>
      <Phone size={16}/> Số điện thoại / OTP
    </button>
   </div>

   {error&&<div className="alert-error ai-alert">{error}</div>}
   {info&&<div className="alert-success ai-alert">{info}</div>}

   {mode==='PASSWORD'&&<form onSubmit={submitPassword} className="login-form-stack ai-login-form">
    <label>Tên đăng nhập</label>
    <input className="input" value={username} onChange={e=>setUsername(e.target.value)} placeholder="admin / kh001" autoComplete="username"/>

    <label>Mật khẩu</label>
    <input className="input" type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="Nhập mật khẩu" autoComplete="current-password"/>

    <div className="login-ai-options">
     <label className="remember-row">
       <input type="checkbox" checked={remember} onChange={e=>setRemember(e.target.checked)}/>
       <span>Ghi nhớ đăng nhập</span>
     </label>
     <button type="button" className="link-btn" onClick={forgotPassword}>Quên mật khẩu?</button>
    </div>

    <button className="btn login-btn ai-login-submit" disabled={loading}>{loading?'Đang đăng nhập...':<>Đăng nhập <ChevronRight size={18}/></>}</button>
   </form>}

   {mode==='OTP'&&<form onSubmit={verifyOtp} className="login-form-stack ai-login-form">
    <label>Số điện thoại</label>
    <div className="login-inline">
      <input className="input" value={phone} onChange={e=>setPhone(e.target.value)} placeholder="0905123456" autoComplete="tel"/>
      <button type="button" className="btn secondary" onClick={requestOtp} disabled={loading}>
        {otpSent?'Gửi lại':'Gửi OTP'}
      </button>
    </div>

    <label>Mã OTP</label>
    <input className="input" value={otp} onChange={e=>setOtp(e.target.value)} placeholder="Nhập mã OTP" inputMode="numeric"/>

    <div className="login-ai-options">
     <label className="remember-row">
       <input type="checkbox" checked={remember} onChange={e=>setRemember(e.target.checked)}/>
       <span>Ghi nhớ đăng nhập</span>
     </label>
     <button type="button" className="link-btn" onClick={forgotPassword}>Quên mật khẩu?</button>
    </div>

    <button className="btn login-btn ai-login-submit" disabled={loading}>{loading?'Đang xử lý...':<>Đăng nhập bằng OTP <ChevronRight size={18}/></>}</button>
   </form>}


   {mode==='FORGOT'&&<form onSubmit={forgotSent?resetPassword:requestResetPassword} className="login-form-stack ai-login-form">
    <label>Email, số điện thoại hoặc tên đăng nhập</label>
    <input className="input" value={forgotIdentifier} onChange={e=>setForgotIdentifier(e.target.value)} placeholder="Email hoặc tên đăng nhập có email" autoComplete="username"/>

    {forgotSent&&<>
     <label>Mã xác nhận</label>
     <input className="input" value={forgotCode} onChange={e=>setForgotCode(e.target.value)} placeholder="Nhập mã đã nhận" inputMode="numeric"/>
     <label>Mật khẩu mới</label>
     <input className="input" type="password" value={forgotPasswordNew} onChange={e=>setForgotPasswordNew(e.target.value)} placeholder="Tối thiểu 6 ký tự" autoComplete="new-password"/>
    </>}

    <button className="btn login-btn ai-login-submit" disabled={loading}>{loading?'Đang xử lý...':(forgotSent?'Đổi mật khẩu':'Gửi mã đặt lại mật khẩu')}</button>
    <button type="button" className="btn secondary" onClick={()=>{setMode('PASSWORD');clearNotice();}}>Quay lại đăng nhập</button>
   </form>}

   <div className="login-register-row ai-register-row">
    <div>
     <b>Chưa có tài khoản?</b>
     <span>Tạo tài khoản để nhân viên hoặc khách hàng truy cập đúng quyền.</span>
    </div>
    <button type="button" className="btn secondary" onClick={onRegister}>Đăng ký</button>
   </div>
  </section>
 </div>
}
