import React,{useEffect,useState}from'react';
import api from'../api/api';
import SafePage from'../components/SafePage';
import {moneyVnd}from'../utils/money';
import AIActionCenter from'../components/ai/AIActionCenter';

export default function Dashboard(){
 const[stats,setStats]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
 useEffect(()=>{api.get('/reports/dashboard').then(r=>setStats(r.data?.summary||r.data||{})).catch(e=>setError(e.response?.data?.message||e.message)).finally(()=>setLoading(false))},[]);
 const cards=[
  ['Doanh thu hôm nay',stats?.today_revenue],
  ['Tổng doanh thu',stats?.total_revenue],
  ['Đã thu',stats?.total_paid],
  ['Công nợ',stats?.total_debt],
 ];
 return <SafePage loading={loading} error={error}>
  <div className="dashboard-compact">
   {cards.map(([label,val])=><div className="mini-card" key={label}><div className="mini-label">{label}</div><div className="mini-value">{moneyVnd(val)}</div></div>)}
  </div>
  <AIActionCenter/>
  <div className="grid cols-2">
   <div className="card"><h3>Việc cần chú ý</h3><p className="muted">Theo dõi công nợ, bill chưa thu đủ, hàng tồn âm và lịch góp nợ.</p></div>
   <div className="card"><h3>Agent AI gợi ý</h3><p className="muted">Nên kiểm tra quyền user, dữ liệu khách hàng theo scope, và backup dữ liệu cuối ngày.</p></div>
  </div>
 </SafePage>
}
