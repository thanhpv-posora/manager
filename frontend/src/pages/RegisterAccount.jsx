import React,{useState}from'react';
import api from'../api/api';
import {showSuccess,showError,showWarning} from'../utils/toast';

export default function RegisterAccount({onBack}){
 const[form,setForm]=useState({});
 const[done,setDone]=useState('');
 const[error,setError]=useState('');
 const[loading,setLoading]=useState(false);
 const[showPassword,setShowPassword]=useState(false);
 const[showConfirmPassword,setShowConfirmPassword]=useState(false);

 const set=(k,v)=>setForm(prev=>({...prev,[k]:v}));

 const save=async(e)=>{
  e.preventDefault();
  setError('');
  setDone('');

  if(!form.full_name?.trim()){showWarning('Nhập Full name');return setError('Nhập Full name');}
  if(!form.username?.trim()){showWarning('Nhập tên đăng nhập');return setError('Nhập tên đăng nhập');}
  if(!form.phone?.trim()){showWarning('Nhập số điện thoại');return setError('Nhập số điện thoại');}
  if(!form.email?.trim()){showWarning('Nhập email');return setError('Nhập email');}
  if(!form.password){showWarning('Nhập mật khẩu');return setError('Nhập mật khẩu');}
  if(form.password!==form.confirm_password){showWarning('Mật khẩu xác nhận không khớp');return setError('Mật khẩu xác nhận không khớp');}

  setLoading(true);
  try{
    const payload={
      full_name:form.full_name,
      username:form.username,
      phone:form.phone,
      email:form.email,
      password:form.password,
      description:form.description||'',

      // Compatible with current RegistrationAgent/API.
      business_name:form.full_name,
      owner_name:form.full_name,
      service_plan:'TRIAL',
      payment_method:'NONE',
      address:'',
      transfer_note:form.description||''
    };

    const r=await api.post('/registrations/public',payload);
    const message=r.data.message||'Đã gửi đăng ký tài khoản. Admin sẽ kiểm tra và kích hoạt.';setDone(message);showSuccess(message);
  }catch(e){
    const message=e.response?.data?.message||e.message;setError(message);showError(message);
  }finally{
    setLoading(false);
  }
 };

 return <div className="register-shell">
  <form className="register-card" onSubmit={save}>
   <h1>Đăng ký tài khoản MeatBiz</h1>
   <p className="muted">Nhập thông tin cơ bản. Sau khi gửi, admin sẽ kiểm tra và kích hoạt tài khoản.</p>

   {done&&<div className="alert-success">{done}</div>}
   {error&&<div className="alert-error">{error}</div>}

   <div className="form-grid">
    <input className="input" placeholder="Full name *" value={form.full_name||''} onChange={e=>set('full_name',e.target.value)}/>
    <input className="input" placeholder="Tên đăng nhập *" value={form.username||''} onChange={e=>set('username',e.target.value)}/>
    <input className="input" placeholder="Số điện thoại *" value={form.phone||''} onChange={e=>set('phone',e.target.value)}/>
    <input className="input" placeholder="Email *" value={form.email||''} onChange={e=>set('email',e.target.value)}/>
    <div className="password-field">
      <input className="input" type={showPassword?'text':'password'} placeholder="Mật khẩu *" value={form.password||''} onChange={e=>set('password',e.target.value)}/>
      <button type="button" onClick={()=>setShowPassword(!showPassword)}>{showPassword?'Ẩn':'Hiện'}</button>
    </div>
    <div className="password-field">
      <input className="input" type={showConfirmPassword?'text':'password'} placeholder="Xác nhận mật khẩu *" value={form.confirm_password||''} onChange={e=>set('confirm_password',e.target.value)}/>
      <button type="button" onClick={()=>setShowConfirmPassword(!showConfirmPassword)}>{showConfirmPassword?'Ẩn':'Hiện'}</button>
    </div>
    <textarea className="input" style={{gridColumn:'1 / -1',minHeight:110}} placeholder="Mô tả / nhu cầu sử dụng" value={form.description||''} onChange={e=>set('description',e.target.value)}/>
   </div>

   <div className="actions">
    <button className="btn" disabled={loading}>{loading?'Đang gửi...':'Đăng ký tài khoản'}</button>
    <button type="button" className="btn secondary" onClick={onBack}>Quay lại đăng nhập</button>
   </div>
  </form>
 </div>
}
