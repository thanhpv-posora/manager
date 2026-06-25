import React,{useEffect,useState}from'react';
import {CheckCircle2,XCircle}from'lucide-react';
import api from'../api/api';
import SafePage from'../components/SafePage';
import {showSuccess,showError,showWarning}from'../utils/toast';

export default function UserCustomerMapping(){
 const[rows,setRows]=useState([]);
 const[registrations,setRegistrations]=useState([]);
 const[customers,setCustomers]=useState([]);
 const[form,setForm]=useState({});
 const[loading,setLoading]=useState(true);
 const[error,setError]=useState('');

 const load=async()=>{
  try{
    const[r,c,reg]=await Promise.all([
      api.get('/user-mapping'),
      api.get('/customers'),
      api.get('/user-mapping/registrations').catch(()=>({data:[]}))
    ]);
    setRows(r.data||[]);
    setCustomers(c.data||[]);
    setRegistrations(reg.data||[]);
  }catch(e){
    setError(e.response?.data?.message||e.message);
  }finally{
    setLoading(false);
  }
 };

 useEffect(()=>{load()},[]);

 const map=async(row,customer_id)=>{
  try{
    await api.post('/user-mapping/map',{user_id:row.user_id,customer_id});
    showSuccess('Đã mapping user với khách hàng');
    await load();
  }catch(e){
    showError(e.response?.data?.message||e.message);
  }
 };

 const createUser=async()=>{
  try{
    await api.post('/user-mapping/customer-user',form);
    showSuccess('Đã tạo user khách hàng');
    setForm({});
    await load();
  }catch(e){
    showError(e.response?.data?.message||e.message);
  }
 };

 const approve=async(id)=>{
  try{
    const r=await api.post('/user-mapping/registrations/'+id+'/approve');
    showSuccess(r.data?.message||'Đã duyệt và tạo user');
    await load();
  }catch(e){
    showError(e.response?.data?.message||e.message);
  }
 };

 const reject=async(id)=>{
  if(!await window.appConfirm('Bạn chắc chắn muốn từ chối đăng ký này?',{title:'Từ chối đăng ký',confirmText:'Từ chối',variant:'danger'}))return;
  try{
    const r=await api.post('/user-mapping/registrations/'+id+'/reject');
    showWarning(r.data?.message||'Đã từ chối đăng ký');
    await load();
  }catch(e){
    showError(e.response?.data?.message||e.message);
  }
 };

 const pending=registrations.filter(x=>x.status==='PENDING');
 const handled=registrations.filter(x=>x.status!=='PENDING');

 return <SafePage loading={loading} error={error}>
  <div className="grid cols-2">
    <div className="card">
      <h3>Duyệt user đăng ký</h3>
      <p className="muted">Khách đăng ký ngoài trang home sẽ nằm ở đây. Bấm duyệt sẽ tự tạo khách hàng + user CUSTOMER để khách đăng nhập được.</p>

      {!pending.length&&<p className="muted">Không có đăng ký mới đang chờ duyệt.</p>}

      <table className="table mapping-registration-table">
        <thead><tr><th>Thông tin đăng ký</th><th>Tài khoản</th><th></th></tr></thead>
        <tbody>{pending.map(x=><tr key={x.id}>
          <td>
            <b>{x.full_name||x.business_name}</b><br/>
            <span className="muted">{x.phone} · {x.email}</span><br/>
            <span className="muted">{x.description||x.transfer_note||''}</span>
          </td>
          <td><b>{x.username}</b><br/><span className="muted">{x.service_plan||'TRIAL'}</span></td>
          <td>
            <div style={{display:'flex',flexWrap:'nowrap',gap:6,alignItems:'center',justifyContent:'center'}}>
              <button className="btn" title="Duyệt & tạo user" style={{padding:0,width:32,height:32,display:'inline-flex',alignItems:'center',justifyContent:'center'}} onClick={()=>approve(x.id)}><CheckCircle2 size={14}/></button>
              <button className="btn danger" title="Từ chối" style={{padding:0,width:32,height:32,display:'inline-flex',alignItems:'center',justifyContent:'center'}} onClick={()=>reject(x.id)}><XCircle size={14}/></button>
            </div>
          </td>
        </tr>)}</tbody>
      </table>
    </div>

    <div className="card">
      <h3>Tạo user khách hàng thủ công</h3>
      <div className="form-grid">
        <select className="select" value={form.customer_id||''} onChange={e=>setForm({...form,customer_id:e.target.value})}>
          <option value="">Chọn khách</option>
          {customers.map(c=><option key={c.id} value={c.id}>{c.customer_code} - {c.name}</option>)}
        </select>
        <input className="input" placeholder="Username" value={form.username||''} onChange={e=>setForm({...form,username:e.target.value})}/>
        <input className="input" placeholder="Tên hiển thị" value={form.full_name||''} onChange={e=>setForm({...form,full_name:e.target.value})}/>
        <input className="input" placeholder="Password" type="password" value={form.password||''} onChange={e=>setForm({...form,password:e.target.value})}/>
      </div>
      <button className="btn" style={{marginTop:10}} onClick={createUser}>Tạo user KH</button>
    </div>
  </div>

  <div className="card">
    <h3>Danh sách user và khách đang gắn</h3>
    <p className="muted">Mapping này quyết định user đó thấy dữ liệu của khách hàng nào.</p>
    <table className="table">
      <thead><tr><th>User</th><th>Role</th><th>Khách đang gắn</th><th>Mapping</th></tr></thead>
      <tbody>{rows.map(x=><tr key={x.user_id}>
        <td><b>{x.username}</b><br/>{x.full_name}</td>
        <td>{x.role}</td>
        <td>{x.customer_code?`${x.customer_code} - ${x.customer_name}`:'-'}</td>
        <td>
          <select className="select" value={x.customer_id||''} onChange={e=>map(x,e.target.value)}>
            <option value="">Chưa gắn</option>
            {customers.map(c=><option key={c.id} value={c.id}>{c.customer_code} - {c.name}</option>)}
          </select>
        </td>
      </tr>)}</tbody>
    </table>
  </div>

  {!!handled.length&&<div className="card">
    <h3>Lịch sử đăng ký đã xử lý</h3>
    <table className="table">
      <thead><tr><th>Khách</th><th>User</th><th>Trạng thái</th><th>Mapping</th></tr></thead>
      <tbody>{handled.slice(0,30).map(x=><tr key={x.id}>
        <td><b>{x.full_name||x.business_name}</b><br/><span className="muted">{x.phone}</span></td>
        <td>{x.username}<br/><span className="muted">user_id: {x.user_id||'-'}</span></td>
        <td>{x.status}</td>
        <td>customer_id: {x.customer_id||'-'}</td>
      </tr>)}</tbody>
    </table>
  </div>}
 </SafePage>
}
