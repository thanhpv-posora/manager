import React,{useEffect,useState}from'react';
import api from'../api/api';
import SafePage from'../components/SafePage';

export default function UserCustomerMapping(){
 const[rows,setRows]=useState([]),[customers,setCustomers]=useState([]),[form,setForm]=useState({}),[loading,setLoading]=useState(true),[error,setError]=useState('');
 const load=async()=>{try{const[r,c]=await Promise.all([api.get('/user-mapping'),api.get('/customers')]);setRows(r.data||[]);setCustomers(c.data||[])}catch(e){setError(e.response?.data?.message||e.message)}finally{setLoading(false)}};
 useEffect(()=>{load()},[]);
 const map=async(row,customer_id)=>{await api.post('/user-mapping/map',{user_id:row.user_id,customer_id});await load()};
 const createUser=async()=>{await api.post('/user-mapping/customer-user',form);setForm({});await load()};
 return <SafePage loading={loading} error={error}>
  <div className="grid cols-2"><div className="card"><h3>Tạo user khách hàng</h3><div className="form-grid"><select className="select" value={form.customer_id||''} onChange={e=>setForm({...form,customer_id:e.target.value})}><option value="">Chọn khách</option>{customers.map(c=><option key={c.id} value={c.id}>{c.customer_code} - {c.name}</option>)}</select><input className="input" placeholder="Username" value={form.username||''} onChange={e=>setForm({...form,username:e.target.value})}/><input className="input" placeholder="Tên hiển thị" value={form.full_name||''} onChange={e=>setForm({...form,full_name:e.target.value})}/><input className="input" placeholder="Password hoặc hash" value={form.password||''} onChange={e=>setForm({...form,password:e.target.value})}/></div><button className="btn" style={{marginTop:10}} onClick={createUser}>Tạo user KH</button></div><div className="card"><h3>Agent mapping user ↔ khách hàng</h3><p className="muted">Mapping này quyết định user đó thấy dữ liệu của khách hàng nào.</p></div></div>
  <div className="card"><table className="table"><thead><tr><th>User</th><th>Role</th><th>Khách đang gắn</th><th>Mapping</th></tr></thead><tbody>{rows.map(x=><tr key={x.user_id}><td><b>{x.username}</b><br/>{x.full_name}</td><td>{x.role}</td><td>{x.customer_code} - {x.customer_name}</td><td><select className="select" value={x.customer_id||''} onChange={e=>map(x,e.target.value)}><option value="">Chưa gắn</option>{customers.map(c=><option key={c.id} value={c.id}>{c.customer_code} - {c.name}</option>)}</select></td></tr>)}</tbody></table></div>
 </SafePage>
}
