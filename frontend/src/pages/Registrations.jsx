import React,{useEffect,useState}from'react';
import api from'../api/api';
import SafePage from'../components/SafePage';
import {showSuccess,showError}from'../utils/toast';

export default function Registrations(){
 const[rows,setRows]=useState([]),[loading,setLoading]=useState(true),[error,setError]=useState('');
 const load=async()=>{try{const r=await api.get('/registrations');setRows(r.data||[])}catch(e){setError(e.response?.data?.message||e.message)}finally{setLoading(false)}};
 useEffect(()=>{load()},[]);

 const status=async(id,s)=>{
  try{
    const r=await api.put('/registrations/'+id+'/status',{status:s});
    showSuccess(r.data?.message||'Đã cập nhật đăng ký');
    await load();
  }catch(e){
    showError(e.response?.data?.message||e.message);
  }
 };

 return <SafePage loading={loading} error={error}>
  <div className="card portal-hero">
    <h1>Đăng ký tài khoản khách hàng</h1>
    <p>Luồng chuẩn: khách đăng ký → verify email/SĐT → admin duyệt → hệ thống tự tạo khách hàng + user CUSTOMER → admin phân quyền dùng thử tại màn Phân quyền user.</p>
  </div>

  <div className="card">
    <table className="table">
      <thead>
        <tr>
          <th>Khách</th>
          <th>Liên hệ</th>
          <th>Tài khoản</th>
          <th>Mapping sau duyệt</th>
          <th>Verify</th>
          <th>Trạng thái</th>
          <th></th>
        </tr>
      </thead>
      <tbody>{rows.map(x=><tr key={x.id}>
        <td><b>{x.full_name||x.business_name}</b><br/><span className="muted">{x.description||x.owner_name}</span></td>
        <td>{x.phone}<br/><span className="muted">{x.email}</span></td>
        <td><b>{x.username}</b><br/><span className="muted">{x.service_plan} · {x.payment_method}</span></td>
        <td>
          {x.user_id?<span>user_id: <b>{x.user_id}</b></span>:<span className="muted">Chưa tạo user</span>}<br/>
          {x.customer_id?<span>customer_id: <b>{x.customer_id}</b></span>:<span className="muted">Chưa tạo khách hàng</span>}
        </td>
        <td>
          <div>Email: {x.email_verified_at?<b style={{color:'#16a34a'}}>Đã xác minh</b>:<span className="muted">Chưa</span>}</div>
          <div>SĐT: {x.phone_verified_at?<b style={{color:'#16a34a'}}>Đã xác minh</b>:<span className="muted">Chưa</span>}</div>
        </td>
        <td><b>{x.status}</b>{x.approved_at&&<><br/><span className="muted">Duyệt: {x.approved_at}</span></>}</td>
        <td>
          <button className="btn secondary" disabled={x.status==='APPROVED'} onClick={()=>status(x.id,'APPROVED')}>Duyệt & tạo user</button>{' '}
          <button className="btn danger" disabled={x.status==='REJECTED'} onClick={()=>status(x.id,'REJECTED')}>Từ chối</button>
        </td>
      </tr>)}</tbody>
    </table>
  </div>
 </SafePage>
}
