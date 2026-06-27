import React,{useEffect,useState}from'react';
import {CheckCircle2,XCircle}from'lucide-react';
import api from'../api/api';
import SafePage from'../components/SafePage';
import {showSuccess,showError}from'../utils/toast';

export default function Registrations(){
 const[rows,setRows]=useState([]),[loading,setLoading]=useState(true),[error,setError]=useState('');
 const[search,setSearch]=useState('');
 const[page,setPage]=useState(1);
 const[pageSize,setPageSize]=useState(20);
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

 const q=search.toLowerCase().trim();
 const filtered=q?rows.filter(x=>[x.full_name,x.business_name,x.phone,x.email,x.username,x.status].some(f=>String(f||'').toLowerCase().includes(q))):rows;
 const totalPages=Math.max(1,Math.ceil(filtered.length/pageSize));
 const cp=Math.min(page,totalPages);
 const paginated=filtered.slice((cp-1)*pageSize,cp*pageSize);

 return <SafePage loading={loading} error={error}>
  <div className="card portal-hero">
    <h1>Đăng ký tài khoản khách hàng</h1>
    <p>Luồng chuẩn: khách đăng ký → verify email/SĐT → admin duyệt → hệ thống tự tạo khách hàng + user CUSTOMER → admin phân quyền dùng thử tại màn Phân quyền user.</p>
  </div>

  <div className="card">
    <div style={{marginBottom:12,display:'flex',gap:8,alignItems:'center'}}>
      <input className="input" placeholder="Tìm theo tên, SĐT, email, tài khoản, trạng thái..." value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}} style={{maxWidth:420}}/>
      {search&&<button className="btn secondary" onClick={()=>{setSearch('');setPage(1);}}>Xóa lọc</button>}
      <span className="muted">{filtered.length} đăng ký</span>
    </div>
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
      <tbody>{paginated.map(x=><tr key={x.id}>
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
          <div style={{display:'flex',flexWrap:'nowrap',gap:6,alignItems:'center',justifyContent:'center'}}>
            <button className="btn" title="Duyệt & tạo user" style={{padding:0,width:32,height:32,display:'inline-flex',alignItems:'center',justifyContent:'center'}} disabled={x.status==='APPROVED'} onClick={()=>status(x.id,'APPROVED')}><CheckCircle2 size={14}/></button>
            <button className="btn danger" title="Từ chối" style={{padding:0,width:32,height:32,display:'inline-flex',alignItems:'center',justifyContent:'center'}} disabled={x.status==='REJECTED'} onClick={()=>status(x.id,'REJECTED')}><XCircle size={14}/></button>
          </div>
        </td>
      </tr>)}</tbody>
    </table>
    <div style={{display:'flex',justifyContent:'flex-end',alignItems:'center',gap:8,marginTop:12,flexWrap:'wrap'}}>
      <select className="select" value={pageSize} onChange={e=>{setPageSize(Number(e.target.value));setPage(1);}} style={{width:'auto'}}>
        <option value={10}>10 / trang</option>
        <option value={20}>20 / trang</option>
        <option value={50}>50 / trang</option>
      </select>
      <span className="muted">Trang {cp} / {totalPages}</span>
      <button className="btn secondary" onClick={()=>setPage(p=>Math.max(1,p-1))} disabled={cp<=1}>Trước</button>
      <button className="btn secondary" onClick={()=>setPage(p=>Math.min(totalPages,p+1))} disabled={cp>=totalPages}>Sau</button>
    </div>
  </div>
 </SafePage>
}
