import React,{useEffect,useState}from'react';
import api from'../api/api';

export default function VerifyEmail({onBack}){
 const[loading,setLoading]=useState(true);
 const[message,setMessage]=useState('Đang xác minh email...');
 const[ok,setOk]=useState(false);
 useEffect(()=>{
  const run=async()=>{
   const token=new URLSearchParams(window.location.search).get('token')||'';
   if(!token){setLoading(false);setOk(false);setMessage('Thiếu token xác minh email');return;}
   try{
    const r=await api.get(`/registrations/verify-email?token=${encodeURIComponent(token)}`);
    setOk(true);setMessage(r.data?.message||'Đã xác minh email');
   }catch(e){
    setOk(false);setMessage(e.response?.data?.message||e.message||'Không xác minh được email');
   }finally{setLoading(false);}
  };
  run();
 },[]);
 return <div className="mb-register-v7">
  <div className="mb-register-v7__wrap" style={{maxWidth:760,gridTemplateColumns:'1fr'}}>
   <section className="mb-register-v7__card">
    <div className="mb-register-v7__eyebrow">MeatBiz Verification</div>
    <h2>{loading?'Đang xử lý':(ok?'Xác minh thành công':'Xác minh chưa thành công')}</h2>
    <div className={`mb-register-v7__alert ${ok?'mb-register-v7__alert--success':'mb-register-v7__alert--error'}`}>{message}</div>
    <div className="mb-register-v7__note">Sau khi xác minh, MeatBiz sẽ kiểm tra và kích hoạt tài khoản cho bạn.</div>
    <button className="mb-register-v7__btn" onClick={onBack}>Về trang đăng nhập</button>
   </section>
  </div>
 </div>
}
