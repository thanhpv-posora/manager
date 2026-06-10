import React,{useEffect,useState}from'react';
import api from'../api/api';
import {showSuccess,showError,showWarning} from'../utils/toast';

const EMPTY_FORM={
 full_name:'',
 username:'',
 phone:'',
 email:'',
 password:'',
 confirm_password:'',
 description:''
};

export default function RegisterAccount({onBack}){
 const[form,setForm]=useState(EMPTY_FORM);
 const[done,setDone]=useState('');
 const[error,setError]=useState('');
 const[loading,setLoading]=useState(false);
 const[showPassword,setShowPassword]=useState(false);
 const[showConfirmPassword,setShowConfirmPassword]=useState(false);

 useEffect(()=>{
  setForm(EMPTY_FORM);
  setDone('');
  setError('');
  setShowPassword(false);
  setShowConfirmPassword(false);
 },[]);

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
      full_name:form.full_name.trim(),
      username:form.username.trim(),
      phone:form.phone.trim(),
      email:form.email.trim(),
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

 return <div className="register-shell">
  <form className="register-card" onSubmit={save} autoComplete="off">
   <h1>Đăng ký tài khoản MeatBiz</h1>
   <p className="muted">Nhập thông tin cơ bản. Sau khi gửi, admin sẽ kiểm tra và kích hoạt tài khoản.</p>

   {done&&<div className="alert-success">{done}</div>}
   {error&&<div className="alert-error">{error}</div>}

   <div className="form-grid">
    <label className="field-label"><span>Full name *</span><input className="input" autoComplete="off" placeholder="Nhập họ tên đầy đủ" value={form.full_name} onChange={e=>set('full_name',e.target.value)}/></label>
    <label className="field-label"><span>Tên đăng nhập *</span><input className="input" autoComplete="new-username" placeholder="Ví dụ: khach001" value={form.username} onChange={e=>set('username',e.target.value)}/></label>
    <label className="field-label"><span>Số điện thoại *</span><input className="input" autoComplete="off" placeholder="Ví dụ: 0848778222" value={form.phone} onChange={e=>set('phone',e.target.value)}/></label>
    <label className="field-label"><span>Email *</span><input className="input" autoComplete="off" placeholder="Ví dụ: support@posora.vn" value={form.email} onChange={e=>set('email',e.target.value)}/></label>

    <label className="field-label"><span>Mật khẩu *</span><div className="password-field">
      <input className="input" autoComplete="new-password" type={showPassword?'text':'password'} placeholder="Nhập mật khẩu" value={form.password} onChange={e=>set('password',e.target.value)}/>
      <button type="button" onClick={()=>setShowPassword(!showPassword)}>{showPassword?'Ẩn':'Hiện'}</button>
    </div></label>

    <label className="field-label"><span>Xác nhận mật khẩu *</span><div className="password-field">
      <input className="input" autoComplete="new-password" type={showConfirmPassword?'text':'password'} placeholder="Nhập lại mật khẩu" value={form.confirm_password} onChange={e=>set('confirm_password',e.target.value)}/>
      <button type="button" onClick={()=>setShowConfirmPassword(!showConfirmPassword)}>{showConfirmPassword?'Ẩn':'Hiện'}</button>
    </div></label>

    <label className="field-label" style={{gridColumn:'1 / -1'}}><span>Mô tả / nhu cầu sử dụng</span><textarea className="input" style={{minHeight:110}} placeholder="Ví dụ: cần tạo bill POS, quản lý công nợ, bảng giá riêng..." value={form.description} onChange={e=>set('description',e.target.value)}/></label>
   </div>

   <div className="actions">
    <button className="btn" disabled={loading}>{loading?'Đang gửi...':'Đăng ký tài khoản'}</button>
    <button type="button" className="btn secondary" onClick={onBack}>Quay lại đăng nhập</button>
   </div>
  </form>
 </div>
}
