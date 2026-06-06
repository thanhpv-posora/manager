import {useEffect}from'react';
import {showError}from'../utils/toast';

export default function SafePage({loading,error,children}){
  useEffect(()=>{
    if(error)showError(error);
  },[error]);

  if(loading)return <div className="card">Đang tải...</div>;
  if(error)return <div className="card error"><h3>Lỗi màn hình</h3><p>{error}</p></div>;
  return children;
}
