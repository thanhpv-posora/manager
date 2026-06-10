import React,{useEffect,useState}from'react';
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
  setError('');
  setInfo('');
  const value=mode==='OTP'?phone:username;
  if(!value){showWarning('Nhập số điện thoại hoặc tên đăng nhập trước');return setError('Nhập số điện thoại hoặc tên đăng nhập trước');}
  setLoading(true);
  try{
    const r=await api.post('/auth/forgot-password',{username:value,phone:value});
    const message=r.data.message||'Đã gửi hướng dẫn đặt lại mật khẩu';setInfo(message);showInfo(message);
  }catch(e){
    const message=e.response?.data?.message||'Chưa gửi được yêu cầu quên mật khẩu';setError(message);showError(message);
  }finally{
    setLoading(false);
  }
 };

 return <div className="login-shell">
  <div className="login-brand-panel">
   <div className="brand-mark">🥩</div>
   <h1>MeatBiz</h1>
   <p>Quản lý bán hàng thịt, công nợ, nhập lô, giá riêng và AI OCR cho hộ kinh doanh.</p>
   <div className="login-points"><span>POS nhanh</span><span>Công nợ rõ</span><span>OCR ảnh</span><span>Agent AI</span></div>
  </div>

  <div className="login-card-pro">
   <h2>Đăng nhập hệ thống</h2>
   <p className="muted">Chọn hình thức đăng nhập phù hợp.</p>

   <div className="login-tabs">
    <button type="button" className={mode==='OTP'?'active':''} onClick={()=>{setMode('OTP');setError('');setInfo('')}}>
      Số điện thoại / OTP
    </button>
    <button type="button" className={mode==='PASSWORD'?'active':''} onClick={()=>{setMode('PASSWORD');setError('');setInfo('')}}>
      User / mật khẩu
    </button>
   </div>

   {error&&<div className="alert-error">{error}</div>}
   {info&&<div className="alert-success">{info}</div>}

   {mode==='OTP'&&<form onSubmit={verifyOtp} className="login-form-stack">
    <label>Số điện thoại</label>
    <div className="login-inline">
      <input className="input" value={phone} onChange={e=>setPhone(e.target.value)} placeholder="0905123456"/>
      <button type="button" className="btn secondary" onClick={requestOtp} disabled={loading}>
        {otpSent?'Gửi lại OTP':'Gửi OTP'}
      </button>
    </div>

    <label>Mã OTP</label>
    <input className="input" value={otp} onChange={e=>setOtp(e.target.value)} placeholder="Nhập mã OTP"/>

    <label className="remember-row">
      <input type="checkbox" checked={remember} onChange={e=>setRemember(e.target.checked)}/>
      <span>Ghi nhớ đăng nhập</span>
    </label>

    <button className="btn login-btn" disabled={loading}>{loading?'Đang xử lý...':'Đăng nhập bằng OTP'}</button>

    <button type="button" className="link-btn" onClick={forgotPassword}>Quên mật khẩu?</button>
   </form>}

   {mode==='PASSWORD'&&<form onSubmit={submitPassword} className="login-form-stack">
    <label>Tên đăng nhập</label>
    <input className="input" value={username} onChange={e=>setUsername(e.target.value)} placeholder="admin / kh001"/>

    <label>Mật khẩu</label>
    <input className="input" type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="••••••••"/>

    <label className="remember-row">
      <input type="checkbox" checked={remember} onChange={e=>setRemember(e.target.checked)}/>
      <span>Ghi nhớ đăng nhập</span>
    </label>

    <button className="btn login-btn" disabled={loading}>{loading?'Đang đăng nhập...':'Đăng nhập'}</button>

    <button type="button" className="link-btn" onClick={forgotPassword}>Quên mật khẩu?</button>
   </form>}

   <div className="login-register-row">
    <span className="muted">Chưa có tài khoản?</span>
    <button type="button" className="btn secondary" onClick={onRegister}>Đăng ký tài khoản</button>
   </div>
  </div>
 </div>
}
