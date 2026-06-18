import React,{useEffect,useRef,useState}from'react';

const DEFAULTS={
  alert:{title:'Thông báo',confirmText:'OK',variant:'info'},
  confirm:{title:'Xác nhận thao tác',confirmText:'Xác nhận',cancelText:'Hủy',variant:'warning'}
};

function normalizeOptions(input,type){
  if(typeof input==='string'||input===undefined||input===null)return {...DEFAULTS[type],message:String(input??'')};
  return {...DEFAULTS[type],...input,message:String(input.message??'')};
}

export default function AppDialogHost(){
  const[dialog,setDialog]=useState(null);
  const queueRef=useRef([]);
  const nativeAlertRef=useRef(window.alert?.bind(window));
  const nativeConfirmRef=useRef(window.confirm?.bind(window));

  const openDialog=(type,opts)=>new Promise(resolve=>{
    queueRef.current.push({type,opts:normalizeOptions(opts,type),resolve});
    setDialog(d=>d||queueRef.current.shift());
  });

  const closeDialog=(value)=>{
    if(dialog?.resolve)dialog.resolve(value);
    setDialog(null);
    setTimeout(()=>setDialog(d=>d||queueRef.current.shift()||null),0);
  };

  useEffect(()=>{
    window.appAlert=(message,options={})=>openDialog('alert',{...options,message});
    window.appConfirm=(message,options={})=>openDialog('confirm',{...options,message});
    window.alert=(message)=>{openDialog('alert',{message});};
    window.__nativeAlert=nativeAlertRef.current;
    window.__nativeConfirm=nativeConfirmRef.current;
    return()=>{
      window.alert=nativeAlertRef.current;
      delete window.appAlert;
      delete window.appConfirm;
    };
  },[]);

  useEffect(()=>{
    if(!dialog)return;
    const onKey=(e)=>{
      if(e.key==='Escape')closeDialog(dialog.type==='confirm'?false:true);
      if(e.key==='Enter')closeDialog(true);
    };
    window.addEventListener('keydown',onKey);
    return()=>window.removeEventListener('keydown',onKey);
  },[dialog]);

  if(!dialog)return null;
  const opts=dialog.opts||{};
  const variant=opts.variant||'info';
  const icon=variant==='danger'?'⚠️':variant==='success'?'✅':variant==='warning'?'⚠️':'ℹ️';
  return <div className="app-dialog-backdrop" role="dialog" aria-modal="true">
    <div className={'app-dialog app-dialog-'+variant}>
      <div className="app-dialog-head">
        <div className="app-dialog-icon">{icon}</div>
        <div className="app-dialog-title">{opts.title||DEFAULTS[dialog.type].title}</div>
      </div>
      <div className="app-dialog-message">{opts.message}</div>
      <div className="app-dialog-actions">
        {dialog.type==='confirm'&&<button className="app-dialog-btn app-dialog-btn-cancel" onClick={()=>closeDialog(false)}>{opts.cancelText||'Hủy'}</button>}
        <button autoFocus className={'app-dialog-btn app-dialog-btn-confirm '+(variant==='danger'?'danger':'')} onClick={()=>closeDialog(true)}>{opts.confirmText||'OK'}</button>
      </div>
    </div>
  </div>;
}
