import React,{useEffect,useState}from'react';
import {setupGlobalToast} from'../utils/toast';

const config={
  success:{icon:'✅',title:'Thành công'},
  error:{icon:'❌',title:'Thất bại'},
  warning:{icon:'⚠️',title:'Cảnh báo'},
  info:{icon:'ℹ️',title:'Thông báo'}
};

export default function ToastHost(){
  const[toasts,setToasts]=useState([]);

  useEffect(()=>{
    setupGlobalToast();

    const onToast=e=>{
      const id=Date.now()+Math.random();
      const item={id,type:e.detail?.type||'info',message:e.detail?.message||'',duration:e.detail?.duration||3200};
      setToasts(prev=>[item,...prev].slice(0,5));
      window.setTimeout(()=>setToasts(prev=>prev.filter(x=>x.id!==id)),item.duration);
    };

    window.addEventListener('meatbiz-toast',onToast);
    return()=>window.removeEventListener('meatbiz-toast',onToast);
  },[]);

  const close=id=>setToasts(prev=>prev.filter(x=>x.id!==id));

  return <div className="meatbiz-toast-container">
    {toasts.map(t=>{
      const c=config[t.type]||config.info;
      return <div key={t.id} className={`meatbiz-toast meatbiz-toast-${t.type}`}>
        <div className="meatbiz-toast-icon">{c.icon}</div>
        <div className="meatbiz-toast-body">
          <div className="meatbiz-toast-title">{c.title}</div>
          <div className="meatbiz-toast-message">{t.message}</div>
        </div>
        <button type="button" className="meatbiz-toast-close" onClick={()=>close(t.id)}>×</button>
      </div>;
    })}
  </div>;
}
