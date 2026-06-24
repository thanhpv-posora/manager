import React,{useState}from'react';
import {Eye,EyeOff,Lock,X}from'lucide-react';
import api from'../api/api';
import {showSuccess,showError,showWarning}from'../utils/toast';
import {validatePasswordStrength}from'../utils/passwordValidator';

const styles=`
.cpw-overlay{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.38);backdrop-filter:blur(4px);}
.cpw-box{background:#fff;border-radius:24px;padding:28px;width:min(440px,calc(100vw - 32px));box-shadow:0 8px 40px rgba(15,23,42,.18);border:1px solid #E2E8F0;}
.cpw-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;}
.cpw-title{display:flex;align-items:center;gap:9px;font-size:17px;font-weight:600;color:#1F2937;}
.cpw-close{border:0;background:transparent;cursor:pointer;color:#94A3B8;padding:4px;line-height:0;border-radius:8px;}
.cpw-close:hover{background:#F1F5F9;color:#334155;}
.cpw-form{display:grid;gap:14px;}
.cpw-field{display:grid;gap:6px;font-size:14px;font-weight:500;color:#374151;}
.cpw-wrap{position:relative;}
.cpw-input{width:100%;padding:11px 42px 11px 13px;border:1px solid #E2E8F0;border-radius:12px;outline:none;background:#fff;color:#1F2937;font:inherit;font-size:14px;box-sizing:border-box;transition:.15s border-color,.15s box-shadow;}
.cpw-input:focus{border-color:#1A73E8;box-shadow:0 0 0 3px rgba(26,115,232,.12);}
.cpw-input::placeholder{color:#94A3B8;font-weight:400;opacity:1;}
.cpw-eye{position:absolute;right:10px;top:50%;transform:translateY(-50%);border:0;background:transparent;cursor:pointer;color:#94A3B8;padding:2px;line-height:0;}
.cpw-eye:hover{color:#64748B;}
.cpw-hint{color:#64748B;font-size:12px;font-weight:400;margin-top:-6px;line-height:1.5;}
.cpw-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:4px;}
.cpw-btn{border:0;border-radius:12px;padding:10px 20px;font-size:14px;font-weight:600;cursor:pointer;}
.cpw-btn-primary{background:#1A73E8;color:#fff;box-shadow:0 2px 8px rgba(26,115,232,.20);}
.cpw-btn-primary:disabled{opacity:.65;cursor:not-allowed;}
.cpw-btn-secondary{background:#fff;color:#64748B;border:1px solid #E2E8F0;}
.cpw-btn-secondary:hover{background:#F8FAFC;}
`;

function PwField({label,value,visible,onToggle,onChange,placeholder}){
  return(
    <label className="cpw-field">
      {label}
      <div className="cpw-wrap">
        <input className="cpw-input" type={visible?'text':'password'} value={value}
          onChange={e=>onChange(e.target.value)} placeholder={placeholder} autoComplete="new-password"/>
        <button type="button" className="cpw-eye" onClick={onToggle} tabIndex={-1}>
          {visible?<EyeOff size={15}/>:<Eye size={15}/>}
        </button>
      </div>
    </label>
  );
}

export default function ChangePasswordModal({onClose}){
  const[form,setForm]=useState({current:'',next:'',confirm:''});
  const[show,setShow]=useState({current:false,next:false,confirm:false});
  const[loading,setLoading]=useState(false);

  const set=(k,v)=>setForm(p=>({...p,[k]:v}));
  const toggle=(k)=>setShow(p=>({...p,[k]:!p[k]}));

  const submit=async(e)=>{
    e.preventDefault();
    if(!form.current.trim()){showWarning('Nhập mật khẩu hiện tại');return;}
    if(!form.next){showWarning('Nhập mật khẩu mới');return;}
    if(!form.confirm){showWarning('Xác nhận mật khẩu mới');return;}
    if(form.next!==form.confirm){showWarning('Mật khẩu xác nhận không khớp');return;}
    const pwCheck=validatePasswordStrength(form.next);
    if(!pwCheck.ok){showWarning(pwCheck.message);return;}
    setLoading(true);
    try{
      const r=await api.post('/auth/change-password',{
        current_password:form.current,
        new_password:form.next,
        confirm_password:form.confirm
      });
      showSuccess(r.data.message||'Đã đổi mật khẩu');
      onClose();
    }catch(e){
      showError(e.response?.data?.message||'Không thể đổi mật khẩu');
    }finally{
      setLoading(false);
    }
  };

  return(
    <div className="cpw-overlay" onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <style>{styles}</style>
      <div className="cpw-box">
        <div className="cpw-head">
          <div className="cpw-title"><Lock size={18} color="#1A73E8"/>Đổi mật khẩu</div>
          <button type="button" className="cpw-close" onClick={onClose}><X size={18}/></button>
        </div>
        <form className="cpw-form" onSubmit={submit}>
          <PwField label="Mật khẩu hiện tại" value={form.current} visible={show.current}
            onToggle={()=>toggle('current')} onChange={v=>set('current',v)} placeholder="Mật khẩu hiện tại"/>
          <PwField label="Mật khẩu mới" value={form.next} visible={show.next}
            onToggle={()=>toggle('next')} onChange={v=>set('next',v)} placeholder="Mật khẩu mới"/>
          <p className="cpw-hint">8–16 ký tự, gồm chữ hoa, chữ thường, số và ký tự đặc biệt.</p>
          <PwField label="Nhập lại mật khẩu mới" value={form.confirm} visible={show.confirm}
            onToggle={()=>toggle('confirm')} onChange={v=>set('confirm',v)} placeholder="Nhập lại mật khẩu mới"/>
          <div className="cpw-actions">
            <button type="button" className="cpw-btn cpw-btn-secondary" onClick={onClose}>Hủy</button>
            <button type="submit" className="cpw-btn cpw-btn-primary" disabled={loading}>
              {loading?'Đang lưu...':'Xác nhận'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
