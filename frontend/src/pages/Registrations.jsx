import React,{useEffect,useState}from'react';
import api from'../api/api';
import SafePage from'../components/SafePage';

export default function Registrations(){
 const[rows,setRows]=useState([]),[loading,setLoading]=useState(true),[error,setError]=useState('');
 const load=async()=>{try{const r=await api.get('/registrations');setRows(r.data||[])}catch(e){setError(e.response?.data?.message||e.message)}finally{setLoading(false)}};
 useEffect(()=>{load()},[]);
 const status=async(id,s)=>{await api.put('/registrations/'+id+'/status',{status:s});await load()};
 return <SafePage loading={loading} error={error}>
  <div className="card portal-hero"><h1>Đăng ký tài khoản khách hàng</h1><p>Quản lý khách đăng ký dùng dịch vụ MeatBiz.</p></div>
  <div className="card"><table className="table"><thead><tr><th>Khách</th><th>Liên hệ</th><th>Tài khoản</th><th>Gói</th><th>Trạng thái</th><th></th></tr></thead><tbody>{rows.map(x=><tr key={x.id}><td><b>{x.business_name}</b><br/>{x.owner_name}</td><td>{x.phone}<br/><span className="muted">{x.email}</span></td><td>{x.username}</td><td>{x.service_plan}<br/><span className="muted">{x.payment_method}</span></td><td>{x.status}</td><td><button className="btn secondary" onClick={()=>status(x.id,'APPROVED')}>Duyệt</button> <button className="btn danger" onClick={()=>status(x.id,'REJECTED')}>Từ chối</button></td></tr>)}</tbody></table></div>
 </SafePage>
}
