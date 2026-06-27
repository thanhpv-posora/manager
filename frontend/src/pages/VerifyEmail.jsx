import React,{useEffect,useState}from'react';
import {CheckCircle2,XCircle,Mail,ArrowLeft,Loader2}from'lucide-react';
import api from'../api/api';

const verifyStyles=`
.mb-verify-v1{min-height:100vh;width:100%;background:#F8FAFC;display:flex;align-items:center;justify-content:center;padding:28px;box-sizing:border-box;}
.mb-verify-v1 *{box-sizing:border-box;}
.mb-verify-v1__card{width:100%;max-width:600px;background:#fff;border-radius:28px;padding:48px;border:1px solid #E2E8F0;box-shadow:0 4px 32px rgba(15,23,42,.10);text-align:center;}
.mb-verify-v1__logo{display:flex;align-items:center;gap:14px;justify-content:center;margin-bottom:36px;}
.mb-verify-v1__logo>span{width:52px;height:52px;border-radius:18px;background:#fff;display:grid;place-items:center;font-size:28px;box-shadow:0 4px 16px rgba(26,115,232,.12);border:1px solid #BFDBFE;flex-shrink:0;}
.mb-verify-v1__logo b{font-size:26px;color:#1558B0;letter-spacing:-.03em;display:block;line-height:1.1;}
.mb-verify-v1__logo small{display:block;color:#1A73E8;font-weight:600;text-transform:uppercase;letter-spacing:.06em;font-size:12px;margin-top:3px;}
.mb-verify-v1__logo-text{text-align:left;}
.mb-verify-v1__icon{display:flex;align-items:center;justify-content:center;margin:0 auto 22px;}
.mb-verify-v1__spin{display:flex;align-items:center;justify-content:center;margin:0 auto 22px;animation:mb-verify-spin 1s linear infinite;}
@keyframes mb-verify-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
.mb-verify-v1__eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:1.6px;color:#1A73E8;font-weight:600;margin-bottom:8px;}
.mb-verify-v1__title{font-size:38px;font-weight:700;color:#111827;letter-spacing:-1.5px;margin:0 0 16px;line-height:1.1;}
.mb-verify-v1__desc{color:#475569;font-size:16px;line-height:1.72;margin:0 0 24px;}
.mb-verify-v1__desc p{margin:0 0 4px;}
.mb-verify-v1__infobox{display:flex;align-items:flex-start;gap:12px;background:#ECFDF5;border:1px solid #BBF7D0;border-radius:16px;padding:16px 18px;margin-bottom:28px;text-align:left;}
.mb-verify-v1__infobox-icon{flex-shrink:0;margin-top:1px;}
.mb-verify-v1__infobox-text{color:#166534;font-size:14px;line-height:1.62;}
.mb-verify-v1__infobox-text div:first-child{font-weight:600;margin-bottom:2px;}
.mb-verify-v1__errorbox{background:#fef2f2;border:1px solid #fecaca;border-radius:16px;padding:14px 18px;color:#991b1b;font-size:14px;line-height:1.6;margin-bottom:24px;}
.mb-verify-v1__btn{display:inline-flex;align-items:center;gap:8px;border:0;border-radius:14px;padding:14px 28px;font-weight:600;font-size:16px;font-family:inherit;cursor:pointer;background:#1A73E8;color:#fff;box-shadow:0 2px 8px rgba(26,115,232,.22);transition:.18s background,.18s box-shadow;margin-bottom:24px;}
.mb-verify-v1__btn:hover{background:#1557B0;box-shadow:0 4px 16px rgba(26,115,232,.32);}
.mb-verify-v1__footer{color:#94A3B8;font-size:13px;}
.mb-verify-v1__footer a{color:#1A73E8;font-weight:600;text-decoration:none;}
.mb-verify-v1__footer a:hover{text-decoration:underline;}
@media(max-width:640px){
  .mb-verify-v1{padding:16px;align-items:flex-start;padding-top:36px;}
  .mb-verify-v1__card{padding:32px 20px;border-radius:24px;}
  .mb-verify-v1__title{font-size:30px;}
  .mb-verify-v1__btn{width:100%;justify-content:center;}
}
@media(max-width:400px){
  .mb-verify-v1__title{font-size:26px;}
}
`;

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

 return <div className="mb-verify-v1">
  <style>{verifyStyles}</style>
  <div className="mb-verify-v1__card">

   {/* Logo — identical to RegisterAccount */}
   <div className="mb-verify-v1__logo">
    <span>🥩</span>
    <div className="mb-verify-v1__logo-text">
     <b>MeatBiz</b>
     <small>AI-native ERP</small>
    </div>
   </div>

   {/* Icon */}
   {loading
    ? <div className="mb-verify-v1__spin"><Loader2 size={72} color="#1A73E8" strokeWidth={1.5}/></div>
    : ok
     ? <div className="mb-verify-v1__icon"><CheckCircle2 size={80} color="#22C55E" strokeWidth={1.5}/></div>
     : <div className="mb-verify-v1__icon"><XCircle size={80} color="#EF4444" strokeWidth={1.5}/></div>
   }

   {/* Eyebrow */}
   <div className="mb-verify-v1__eyebrow">
    {loading?'Đang xử lý':ok?'MeatBiz Verification':'Verification Error'}
   </div>

   {/* Title */}
   <h2 className="mb-verify-v1__title">
    {loading?'Đang xác minh…':ok?'Xác minh thành công':'Xác minh thất bại'}
   </h2>

   {/* Description */}
   {loading&&<div className="mb-verify-v1__desc"><p>Vui lòng chờ trong giây lát...</p></div>}

   {!loading&&ok&&<div className="mb-verify-v1__desc">
    <p>Đã xác minh email thành công.</p>
    <p>MeatBiz sẽ kiểm tra và kích hoạt tài khoản của bạn.</p>
    <p>Sau khi tài khoản được kích hoạt, bạn sẽ nhận được thông báo qua email.</p>
   </div>}

   {!loading&&!ok&&<div className="mb-verify-v1__errorbox">{message}</div>}

   {/* Info box — success only */}
   {!loading&&ok&&<div className="mb-verify-v1__infobox">
    <span className="mb-verify-v1__infobox-icon"><Mail size={18} color="#16A34A"/></span>
    <div className="mb-verify-v1__infobox-text">
     <div>Email của bạn đã được xác minh.</div>
     <div>Hệ thống sẽ gửi email thông báo khi tài khoản được kích hoạt.</div>
    </div>
   </div>}

   {/* CTA button */}
   {!loading&&<button className="mb-verify-v1__btn" onClick={onBack}>
    <ArrowLeft size={18}/> Về trang đăng nhập
   </button>}

   {/* Support footer */}
   <div className="mb-verify-v1__footer">
    Cần hỗ trợ?&nbsp;<a href="mailto:support@posora.vn">support@posora.vn</a>
   </div>

  </div>
 </div>
}
