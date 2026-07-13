import React,{useEffect,useMemo,useState}from'react';
import {Bar,BarChart,CartesianGrid,ResponsiveContainer,Tooltip,XAxis,YAxis} from'recharts';
import api from'../api/api';
import SafePage from'../components/SafePage';
import {formatQty}from'../utils/quantity';

const money=v=>Number(v||0).toLocaleString('en-US')+'đ';
const pct=v=>`${Number(v||0).toLocaleString('en-US',{maximumFractionDigits:2})}%`;
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const today=()=>new Date().toISOString().slice(0,10);
const monthStart=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`;};

export default function Profit(){
 const[from,setFrom]=useState(monthStart());
 const[to,setTo]=useState(today());
 const[group,setGroup]=useState('day');
 const[rows,setRows]=useState([]);
 const[details,setDetails]=useState([]);
 const[loading,setLoading]=useState(false);
 const[error,setError]=useState('');
 const load=async()=>{setLoading(true);setError('');try{const r=await api.get('/reports/profit',{params:{from,to,group_by:group}});setRows(r.data?.rows||[]);setDetails(r.data?.details||[]);}catch(e){setError(e.response?.data?.message||e.message)}finally{setLoading(false)}};
 useEffect(()=>{load()},[]);
 const totals=useMemo(()=>rows.reduce((s,r)=>({revenue:s.revenue+Number(r.revenue||0),retail_revenue:s.retail_revenue+Number(r.retail_revenue||0),cost:s.cost+Number(r.cost||0),profit:s.profit+Number(r.profit||0),orders:s.orders+Number(r.orders||0),items:s.items+Number(r.items||0)}),{revenue:0,retail_revenue:0,cost:0,profit:0,orders:0,items:0}),[rows]);
 const margin=totals.revenue>0?(totals.profit/totals.revenue*100):0;
 const label=group==='year'?'Theo năm':(group==='month'?'Theo tháng':'Theo ngày');
 const printProfit=()=>{
  const body=rows.map(r=>`<tr><td>${esc(r.period)}</td><td class="num">${money(r.revenue)}</td><td class="num">${money(r.cost)}</td><td class="num"><b>${money(r.profit)}</b></td><td class="num">${pct(r.gross_margin)}</td><td class="num">${esc(r.orders)}</td></tr>`).join('')||'<tr><td colspan="6" class="empty">Không có dữ liệu</td></tr>';
  const html=`<!doctype html><html><head><meta charset="utf-8"><title>Thống kê lợi nhuận</title><style>body{font-family:Arial;margin:24px;color:#111}.head{display:flex;justify-content:space-between;align-items:flex-start}.brand{font-size:22px;font-weight:800}.muted{color:#666;font-size:12px}.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:16px 0}.box{border:1px solid #ddd;border-radius:10px;padding:10px}.box span{display:block;color:#666;font-size:12px}.box b{font-size:18px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ddd;padding:8px;font-size:12px}th{background:#f5f5f5}.num{text-align:right}.empty{text-align:center;color:#777}button{padding:8px 12px;border:0;border-radius:8px;background:#111;color:#fff}@media print{button{display:none}}</style></head><body><div class="head"><div><div class="brand">MeatBiz - Thống kê lợi nhuận</div><div class="muted">${esc(label)} | Từ ${esc(from)} đến ${esc(to)} | Giá vốn: FIFO cho hàng kiểm tồn, giá vốn ngày nhập NCC cho bò xô không kiểm tồn</div></div><button onclick="window.print()">In</button></div><div class="summary"><div class="box"><span>Doanh thu</span><b>${money(totals.revenue)}</b></div><div class="box"><span>Giá vốn</span><b>${money(totals.cost)}</b></div><div class="box"><span>Lợi nhuận gộp</span><b>${money(totals.profit)}</b></div><div class="box"><span>Tỷ suất LN</span><b>${pct(margin)}</b></div></div><table><thead><tr><th>Kỳ</th><th>Doanh thu</th><th>Giá vốn</th><th>Lợi nhuận</th><th>Tỷ suất</th><th>Số bill</th></tr></thead><tbody>${body}</tbody></table><script>window.focus();setTimeout(()=>window.print(),300)</script></body></html>`;
  const w=window.open('','_blank');w.document.write(html);w.document.close();
 };
 return <SafePage loading={loading} error={error}><div className="grid">
  <div className="card"><h3>Thống kê lợi nhuận</h3><p className="muted">Doanh thu lấy theo <b>Ngày xuất hàng</b>. Giá vốn lấy theo <b>Ngày nhập hàng NCC</b> với hàng bò xô không kiểm tồn; hàng kiểm tồn dùng FIFO nếu có dữ liệu layer.</p><p className="muted" style={{marginTop:4}}>Retail Summary hiện chưa theo dõi giá vốn. Phần doanh thu này đang được tính với giá vốn = 0.</p><div className="actions"><input className="input" style={{width:180}} type="date" value={from} onChange={e=>setFrom(e.target.value)}/><input className="input" style={{width:180}} type="date" value={to} onChange={e=>setTo(e.target.value)}/><select className="select" style={{width:160}} value={group} onChange={e=>setGroup(e.target.value)}><option value="day">Theo ngày</option><option value="month">Theo tháng</option><option value="year">Theo năm</option></select><button className="btn" onClick={load}>Xem thống kê</button><button className="btn secondary" onClick={printProfit}>In thống kê</button></div></div>
  <div className="grid grid-4"><div className="stat-card"><span>Doanh thu POS</span><b>{money(totals.revenue-totals.retail_revenue)}</b></div><div className="stat-card"><span>Doanh thu bán lẻ</span><b>{money(totals.retail_revenue)}</b></div><div className="stat-card"><span>Tổng doanh thu</span><b>{money(totals.revenue)}</b></div><div className="stat-card"><span>Tổng giá vốn</span><b>{money(totals.cost)}</b></div><div className="stat-card"><span>Lợi nhuận ròng</span><b>{money(totals.profit)}</b></div><div className="stat-card"><span>Tỷ suất LN</span><b>{pct(margin)}</b></div></div>
  <div className="card"><div style={{height:320}}><ResponsiveContainer width="100%" height="100%"><BarChart data={rows}><CartesianGrid strokeDasharray="3 3"/><XAxis dataKey="period"/><YAxis/><Tooltip formatter={v=>money(v)}/><Bar dataKey="revenue" name="Tổng doanh thu"/><Bar dataKey="cost" name="Tổng giá vốn"/><Bar dataKey="profit" name="Lợi nhuận ròng"/></BarChart></ResponsiveContainer></div></div>
  <div className="card"><table className="table"><thead><tr><th>Kỳ</th><th>Doanh thu bán lẻ</th><th>Tổng doanh thu</th><th>Tổng giá vốn</th><th>Lợi nhuận ròng</th><th>Tỷ suất</th><th>Số bill</th></tr></thead><tbody>{rows.map((r,i)=><tr key={i}><td>{r.period}</td><td>{money(r.retail_revenue)}</td><td>{money(r.revenue)}</td><td>{money(r.cost)}</td><td><b>{money(r.profit)}</b></td><td>{pct(r.gross_margin)}</td><td>{r.orders}</td></tr>)}</tbody></table></div>
  <div className="card"><h3>Chi tiết giá vốn / lợi nhuận theo mặt hàng</h3><table className="table"><thead><tr><th>Ngày xuất</th><th>Bill</th><th>Khách</th><th>Mặt hàng</th><th>SL</th><th>Doanh thu</th><th>Giá vốn</th><th>Lãi</th><th>Cách tính</th></tr></thead><tbody>{details.slice(0,300).map((r,i)=><tr key={i}><td>{r.order_date}</td><td>{r.order_code}</td><td>{r.customer_name}</td><td>{r.product_name}</td><td>{formatQty(r.quantity)}</td><td>{money(r.revenue)}</td><td>{money(r.cost)}</td><td>{money(r.profit)}</td><td>{r.cost_mode}</td></tr>)}</tbody></table>{details.length>300&&<p className="muted">Đang hiển thị 300 dòng đầu. Dùng lọc ngày để xem chi tiết nhỏ hơn.</p>}</div>
 </div></SafePage>
}
