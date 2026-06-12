import React,{useEffect,useMemo,useState}from'react';
import api from'../api/api';
import SafePage from'../components/SafePage';
const money=n=>Number(n||0).toLocaleString('en-US')+'đ';
const pageSize=15;
const ymd=v=>String(v||'').slice(0,10);
const billDateLabel=o=>{
 const ct=String(o?.calendar_type||'SOLAR').toUpperCase();
 const lunar=String(o?.lunar_date_text||'').trim();
 if(ct==='LUNAR'&&lunar)return `${lunar} ÂL`;
 return ymd(o?.order_date);
};
const billDisplayTotal=o=>Number(o?.total_amount||0);

function Pager({page,totalPages,total,onChange,label='dòng'}){
 const current=Math.min(Math.max(1,page),totalPages||1);
 const pages=[];
 const start=Math.max(1,current-2),end=Math.min(totalPages,start+4);
 for(let i=start;i<=end;i++)pages.push(i);
 return <div className="pager-bar">
  <div className="muted">Tổng {total} {label} • Trang {current}/{totalPages}</div>
  <div className="pager-actions">
   <button className="btn secondary" disabled={current<=1} onClick={()=>onChange(1)}>Đầu</button>
   <button className="btn secondary" disabled={current<=1} onClick={()=>onChange(current-1)}>‹</button>
   {pages.map(p=><button key={p} className={p===current?'btn':'btn secondary'} onClick={()=>onChange(p)}>{p}</button>)}
   <button className="btn secondary" disabled={current>=totalPages} onClick={()=>onChange(current+1)}>›</button>
   <button className="btn secondary" disabled={current>=totalPages} onClick={()=>onChange(totalPages)}>Cuối</button>
  </div>
 </div>;
}

export default function Orders(){
 const[rows,setRows]=useState([]),[detail,setDetail]=useState(null),[qr,setQr]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
 const[filters,setFilters]=useState({from:'',to:'',customer:''});
 const[page,setPage]=useState(1);
 const base=import.meta.env.VITE_API_URL||(typeof window !== 'undefined' ? `${window.location.origin}/api` : '/api');
 const load=async()=>{try{setRows((await api.get('/orders')).data||[])}catch(e){setError(e.response?.data?.message||e.message)}finally{setLoading(false)}};
 useEffect(()=>{load()},[]);
 const filtered=useMemo(()=>{
  const name=String(filters.customer||'').trim().toLowerCase();
  return (rows||[]).filter(o=>{
   const d=ymd(o.order_date);
   if(filters.from&&d<filters.from)return false;
   if(filters.to&&d>filters.to)return false;
   if(name&&!String(o.customer_name||'').toLowerCase().includes(name))return false;
   return true;
  });
 },[rows,filters]);
 const totalPages=Math.max(1,Math.ceil(filtered.length/pageSize));
 const currentPage=Math.min(page,totalPages);
 const pageRows=filtered.slice((currentPage-1)*pageSize,currentPage*pageSize);
 const changeFilter=(k,v)=>{setFilters(f=>({...f,[k]:v}));setPage(1)};
 const open=async id=>{const d=(await api.get('/orders/'+id)).data;const q=(await api.get('/orders/'+id+'/qrcode')).data;setDetail(d);setQr(q)};
 const getToken=async order=>{let token=qr?.token;if(!token||detail?.id!==order.id){token=(await api.get('/orders/'+order.id+'/qrcode')).data.token}return token};
 const print=async order=>{const token=await getToken(order);window.open(base+'/orders/public/'+encodeURIComponent(token)+'/print','_blank')};
 const printK80=async order=>{const token=await getToken(order);window.open(base+'/orders/public/'+encodeURIComponent(token)+'/k80','_blank')};
 const saveItem=async item=>{await api.put(`/orders/${detail.id}/items/${item.id}`,{quantity:item.quantity,sale_price:item.sale_price});const d=(await api.get('/orders/'+detail.id)).data;setDetail(d);load()};
 return <SafePage loading={loading} error={error}>
  <div className="grid cols-2 orders-page">
   <div className="card">
    <div className="section-head"><h3>Bill bán hàng</h3><span className="muted">15 bill/trang</span></div>
    <div className="filter-row">
     <label className="field-label"><span>Từ ngày</span><input className="input" type="date" value={filters.from} onChange={e=>changeFilter('from',e.target.value)}/></label>
     <label className="field-label"><span>Đến ngày</span><input className="input" type="date" value={filters.to} onChange={e=>changeFilter('to',e.target.value)}/></label>
     <label className="field-label"><span>Tên khách hàng</span><input className="input" placeholder="Nhập tên khách" value={filters.customer} onChange={e=>changeFilter('customer',e.target.value)}/></label>
     <button className="btn secondary" onClick={()=>{setFilters({from:'',to:'',customer:''});setPage(1)}}>Xóa lọc</button>
    </div>
    <Pager page={currentPage} totalPages={totalPages} total={filtered.length} label="bill" onChange={setPage}/>
    <div className="table-wrap"><table className="table orders-table"><thead><tr><th>Thao tác</th><th>Ngày</th><th>Khách hàng</th><th>Tổng</th><th>Trạng thái</th><th>Bill</th></tr></thead><tbody>{pageRows.map(o=><tr key={o.id}><td><div className="row-actions bill-actions"><button className="btn secondary" onClick={()=>open(o.id)}>Xem</button><button className="btn" onClick={()=>print(o)}>In A4</button><button className="btn secondary" onClick={()=>printK80(o)}>K80</button></div></td><td>{billDateLabel(o)}</td><td>{o.customer_name}</td><td>{money(o.total_amount)}</td><td>{o.payment_status}</td><td><b>{o.order_code}</b></td></tr>)}</tbody></table></div>
    <Pager page={currentPage} totalPages={totalPages} total={filtered.length} label="bill" onChange={setPage}/>
   </div>
   <div className="card detail-card">{detail?<div><h2>{detail.order_code}</h2><p>{detail.customer_name} - {detail.phone}</p>{qr&&<img src={qr.qrcode} style={{width:130}}/>}<div className="table-wrap"><table className="table"><thead><tr><th>Hàng</th><th>SL</th><th>Giá</th><th>Tiền</th><th></th></tr></thead><tbody>{detail.items.map(i=><tr key={i.id}><td>{i.product_name}</td><td><input className="input" style={{width:90}} value={i.quantity} onChange={e=>setDetail({...detail,items:detail.items.map(x=>x.id===i.id?{...x,quantity:e.target.value}:x)})}/></td><td><input className="input" style={{width:120}} value={i.sale_price} onChange={e=>setDetail({...detail,items:detail.items.map(x=>x.id===i.id?{...x,sale_price:e.target.value}:x)})}/></td><td>{money(Number(i.quantity)*Number(i.sale_price))}</td><td><button className="btn secondary" onClick={()=>saveItem(i)}>Lưu</button></td></tr>)}</tbody></table></div><h3>Tổng bill này: {money(billDisplayTotal(detail))}</h3>{detail.old_debts&&detail.old_debts.length>0&&<div><h3>Những bill chưa thanh toán</h3><div className="table-wrap"><table className="table"><tbody>{detail.old_debts.map(d=><tr key={d.id}><td>{billDateLabel(d)}</td><td>{d.order_code}</td><td>{money(d.debt_amount)}</td></tr>)}</tbody></table></div><h3>Tổng nợ cũ: {money(detail.old_debt_total)}</h3></div>}<div className="actions"><button className="btn" onClick={()=>print(detail)}>In A4 + QR</button><button className="btn secondary" onClick={()=>printK80(detail)}>In nhiệt K80</button></div></div>:<p>Chọn bill để xem/in QR/sửa giá</p>}</div>
  </div>
 </SafePage>;
}
