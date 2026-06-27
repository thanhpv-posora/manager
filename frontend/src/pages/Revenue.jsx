import React,{useEffect,useMemo,useState}from'react';
import{Bar,BarChart,CartesianGrid,ResponsiveContainer,Tooltip,XAxis,YAxis}from'recharts';
import api from'../api/api';
import SafePage from'../components/SafePage';

const money=n=>Number(n||0).toLocaleString('en-US')+'đ';
const esc=s=>String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

export default function Revenue(){
 const today=new Date().toISOString().slice(0,10);
 const first=today.slice(0,8)+'01';
 const[rows,setRows]=useState([]),[group,setGroup]=useState('day'),[from,setFrom]=useState(first),[to,setTo]=useState(today),[loading,setLoading]=useState(true),[error,setError]=useState('');
 const load=async()=>{setLoading(true);setError('');try{setRows((await api.get('/reports/revenue',{params:{from,to,group_by:group}})).data||[])}catch(e){setError(e.response?.data?.message||e.message)}finally{setLoading(false)}};
 useEffect(()=>{load()},[]);
 const totals=useMemo(()=>rows.reduce((s,r)=>({
  revenue:s.revenue+Number(r.revenue||0),pos_revenue:s.pos_revenue+Number(r.pos_revenue||0),retail_amount:s.retail_amount+Number(r.retail_amount||0),paid:s.paid+Number(r.paid||0),debt:s.debt+Number(r.debt||0),orders:s.orders+Number(r.orders||0)
 }),{revenue:0,pos_revenue:0,retail_amount:0,paid:0,debt:0,orders:0}),[rows]);
 const printRevenue=()=>{
  const label=group==='month'?'Theo tháng':'Theo ngày';
  const body=rows.map(r=>`<tr><td>${esc(r.period)}</td><td class="num">${money(r.revenue)}</td><td class="num">${money(r.paid)}</td><td class="num">${money(r.debt)}</td><td class="num">${esc(r.orders||0)}</td></tr>`).join('')||'<tr><td colspan="5" class="empty">Không có dữ liệu</td></tr>';
  const html=`<!doctype html><html><head><meta charset="utf-8"/><title>Thống kê doanh thu</title><style>
   body{font-family:Arial,sans-serif;margin:24px;color:#111}.head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.brand{font-size:22px;font-weight:800}.muted{color:#666;font-size:13px}.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:18px 0}.box{border:1px solid #ddd;border-radius:10px;padding:10px}.box span{display:block;color:#666;font-size:12px}.box b{font-size:18px}table{width:100%;border-collapse:collapse;margin-top:10px}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background:#f3f4f6}.num{text-align:right}.empty{text-align:center;color:#777}button{padding:8px 14px;border:0;border-radius:8px;background:#111;color:#fff}@media print{button{display:none}body{margin:10mm}.box{break-inside:avoid}}
  </style></head><body><div class="head"><div><div class="brand">MeatBiz - Thống kê doanh thu</div><div class="muted">${esc(label)} | Từ ${esc(from)} đến ${esc(to)}</div></div><button onclick="window.print()">In thống kê</button></div><div class="summary"><div class="box"><span>Tổng doanh thu</span><b>${money(totals.revenue)}</b></div><div class="box"><span>Đã thu</span><b>${money(totals.paid)}</b></div><div class="box"><span>Công nợ</span><b>${money(totals.debt)}</b></div><div class="box"><span>Số bill</span><b>${esc(totals.orders)}</b></div></div><table><thead><tr><th>Kỳ</th><th>Doanh thu</th><th>Đã thu</th><th>Công nợ</th><th>Số bill</th></tr></thead><tbody>${body}</tbody></table><script>window.focus();setTimeout(()=>window.print(),300)</script></body></html>`;
  const w=window.open('','_blank','width=1100,height=800');
  if(!w){alert('Trình duyệt đang chặn popup in. Vui lòng cho phép popup.');return}
  w.document.open();w.document.write(html);w.document.close();
 };
 return <SafePage loading={loading} error={error}><div className="grid"><div className="card"><h3>Lọc doanh thu</h3><div className="actions"><input className="input" style={{width:180}} type="date" value={from} onChange={e=>setFrom(e.target.value)}/><input className="input" style={{width:180}} type="date" value={to} onChange={e=>setTo(e.target.value)}/><select className="select" style={{width:160}} value={group} onChange={e=>setGroup(e.target.value)}><option value="day">Theo ngày</option><option value="month">Theo tháng</option></select><button className="btn" onClick={load}>Xem thống kê</button><button className="btn secondary" onClick={printRevenue}>In thống kê</button></div><h2>Tổng doanh thu: {money(totals.revenue)}</h2></div><div className="card"><div style={{height:320}}><ResponsiveContainer width="100%" height="100%"><BarChart data={rows}><CartesianGrid strokeDasharray="3 3"/><XAxis dataKey="period"/><YAxis/><Tooltip formatter={v=>money(v)}/><Bar dataKey="pos_revenue" name="Doanh thu POS"/><Bar dataKey="retail_amount" name="Retail Summary"/><Bar dataKey="revenue" name="Tổng doanh thu"/></BarChart></ResponsiveContainer></div></div><div className="card"><table className="table"><thead><tr><th>Kỳ</th><th>Doanh thu POS</th><th>Retail Summary</th><th>Tổng doanh thu</th><th>Đã thu</th><th>Công nợ</th><th>Số bill</th></tr></thead><tbody>{rows.map((r,i)=><tr key={i}><td>{r.period}</td><td>{money(r.pos_revenue)}</td><td>{money(r.retail_amount)}</td><td>{money(r.revenue)}</td><td>{money(r.paid)}</td><td>{money(r.debt)}</td><td>{r.orders}</td></tr>)}</tbody></table></div></div></SafePage>
}
