const TOAST_EVENT='meatbiz-toast';

export function showToast(message,type='info',options={}){
  const text=String(message||'');
  if(!text)return;
  window.dispatchEvent(new CustomEvent(TOAST_EVENT,{detail:{message:text,type,...options}}));
}

export const showSuccess=(message,options={})=>showToast(message,'success',options);
export const showError=(message,options={})=>showToast(message,'error',options);
export const showWarning=(message,options={})=>showToast(message,'warning',options);
export const showInfo=(message,options={})=>showToast(message,'info',options);

export function setupGlobalToast(){
  if(typeof window==='undefined'||window.__MEATBIZ_TOAST_READY__)return;
  window.__MEATBIZ_TOAST_READY__=true;
  window.meatbizToast={success:showSuccess,error:showError,warning:showWarning,info:showInfo};

  const nativeAlert=window.alert?.bind(window);
  window.__MEATBIZ_NATIVE_ALERT__=nativeAlert;
  window.alert=(message)=>{
    showInfo(message);
  };
}
