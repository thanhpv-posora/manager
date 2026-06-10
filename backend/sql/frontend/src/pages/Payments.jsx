import React,{useEffect,useMemo,useState}from'react';
import api from'../api/api';
import SafePage from'../components/SafePage';
import MoneyInput from'../components/MoneyInput';
const money=n=>Number(n||0).toLocaleString('en-US')+'đ';
const pageSize=15;
const ymd=v=>String(v||'').slice(0,10);
const billDateLabel=o=>o?.calendar_type==='LUNAR'&&o?.lunar_date_text?`${o.lunar_date_text} ÂL`:(ymd(o?.order_date)||'');

export default function Payments(){
 const today=new Date().toISOString().slice(0,10);
 const[customers,setCustomers]=useState([]);
 const[rows,setRows]=useState([]);
 const[summary,setSummary]=useState(null);
 const[form,setForm]=useState({payment_date:today,payment_method:'CASH',cash_amount:'',bank_amount:'',current_bill_amount:''});
 const[historyFilter,setHistoryFilter]=useState({from:'',to:'',customer:''});
 const[historyPage,setHistoryPage]=useState(1);
 const[loading,setLoading]=useState(true);
 const[error,setError]=useState('');
 const billTotal=Number(form.current_bill_amount||0);
 const paidTotal=useMemo(()=>Number(form.cash_amount||0)+Number(form.bank_amount||0),[form.cash_amount,form.bank_amount]);
 const remainDebt=Math.max(0,billTotal-paidTotal);
 const loadSummary=async id=>{if(!id)return;setSummary((await api.get('/payments/customer/'+id+'/summary')).data)};
 const loadPayments=async()=>setRows((await api.get('/payments')).data||[]);
 const load=async()=>{try{const user=JSON.parse(localStorage.getItem('user')||'{}');await loadPayments();if(user.role!=='CUSTOMER'){const cs=(await api.get('/customers')).data||[];setCustomers(cs);if(!form.customer_id&&cs.length){setForm(f=>({...f,customer_id:cs[0].id}));await loadSummary(cs[0].id)}}else if(user.customer_id){setForm(f=>({...f,customer_id:user.customer_id}));await loadSummary(user.customer_id)}}catch(e){setError(e.response?.data?.message||e.message)}finally{setLoading(false)}};
 useEffect(()=>{load()},[]);
 const historyRows=useMemo(()=>{const name=String(historyFilter.customer||'').trim().toLowerCase();return(rows||[]).filter(p=>{const d=ymd(p.payment_date);if(historyFilter.from&&d<historyFilter.from)return false;if(historyFilter.to&&d>historyFilter.to)return false;if(name&&!String(p.customer_name||'').toLowerCase().includes(name))return false;return true})},[rows,historyFilter]);
 const historyPages=Math.max(1,Math.ceil(historyRows.length/pageSize));
 const currentHistoryPage=Math.min(historyPage,historyPages);
 const visibleHistory=historyRows.slice((currentHistoryPage-1)*pageSize,currentHistoryPage*pageSize);
 const changeHistoryFilter=(k,v)=>{setHistoryFilter(f=>({...f,[k]:v}));setHistoryPage(1)};
 const setBillTotal=v=>setForm({...form,current_bill_amount:v});
 const changeCustomer=e=>{const id=e.target.value;setForm({...form,customer_id:id,order_id:'',current_bill_amount:'',cash_amount:'',bank_amount:''});loadSummary(id)};
 const fillOrder=o=>setForm({...form,order_id:o.id,current_bill_amount:o.debt_amount,cash_amount:'',bank_amount:'',payment_method:'CASH',selected_bill_calendar_type:o.calendar_type||'SOLAR',selected_bill_lunar_date_text:o.lunar_date_text||'',selected_bill_date_label:billDateLabel(o)});
 const calcPaymentMethod=(cash,bank)=>{const c=Number(cash||0),b=Number(bank||0);if(c>0&&b>0)return'MIXED';if(b>0)return'BANK_TRANSFER';return'CASH'};
 const changeBank=v=>setForm({...form,bank_amount:v,payment_method:calcPaymentMethod(form.cash_amount,v)});
 const changeCash=v=>setForm({...form,cash_amount:v,payment_method:calcPaymentMethod(v,form.bank_amount)});
 const save=async()=>{const payload={...form,amount:paidTotal,current_bill_amount:billTotal,monthly_installment_amount:0,installment_amount:0,calendar_type:form.selected_bill_calendar_type||'SOLAR',lunar_date_text:form.selected_bill_lunar_date_text||''};await api.post('/payments',payload);setForm({...form,cash_amount:'',bank_amount:'',current_bill_amount:'',order_id:''});await loadSummary(form.customer_id);await loadPayments();alert('Đã lưu thu tiền')};
 return <SafePage loading={loading} error={error}>
  <div className="card">
   <h3>Thu tiền khách</h3>
   <p className="muted">Nhập tiền khách trả ở bên trái, chọn nhanh bill còn nợ ở bên phải. Tiền mặt và chuyển khoản nhập độc lập; nếu tổng trả nhỏ hơn bill thì phần còn lại là còn nợ.</p>
   <div className="form-grid" style={{gridTemplateColumns:'2fr 1fr 1fr'}}><label className="field-label"><span>Khách hàng</span><select className="select" value={form.customer_id||''} onChange={changeCustomer}><option value="">Chọn khách</option>{customers.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label className="field-label"><span>Ngày thu</span><input className="input" type="date" value={form.payment_date} onChange={e=>setForm({...form,payment_date:e.target.value})}/></label><label className="field-label"><span>Tổng bill hôm nay</span><MoneyInput placeholder="Ví dụ: 60,000,000" value={form.current_bill_amount||''} onChange={setBillTotal}/></label></div>
   <div className="grid cols-2" style={{alignItems:'start',marginTop:14}}>
    <div className="card" style={{boxShadow:'none',border:'1px solid #fee2e2'}}><h3>Tiền của khách</h3><div className="form-grid"><label className="field-label"><span>Tiền mặt</span><MoneyInput placeholder="Ví dụ: 10,000,000" value={form.cash_amount||''} onChange={changeCash}/></label><label className="field-label"><span>Chuyển khoản</span><MoneyInput placeholder="Ví dụ: 5,000,000" value={form.bank_amount||''} onChange={changeBank}/></label></div><div className="payment-total-box"><div>Tổng bill hôm nay</div><b>{money(billTotal)}</b>{form.selected_bill_date_label&&<span>Ngày bill đang thu: <b>{form.selected_bill_date_label}</b></span>}<span>Tiền mặt {money(form.cash_amount)} + chuyển khoản {money(form.bank_amount)} = {money(paidTotal)}</span><span>Còn nợ: {money(remainDebt)}</span></div><div className="actions" style={{marginTop:12}}><button className="btn" disabled={!form.customer_id||paidTotal<=0} onClick={save}>Lưu thu tiền</button></div></div>
    <div className="card" style={{boxShadow:'none',border:'1px solid #e5e7eb'}}><h3>Bill còn nợ</h3>{summary?.unpaid_orders?.length?<table className="table"><thead><tr><th>Bill</th><th>Ngày</th><th>Còn nợ</th><th></th></tr></thead><tbody>{summary.unpaid_orders.map(o=><tr key={o.id}><td>{o.order_code}</td><td>{billDateLabel(o)}</td><td><b>{money(o.debt_amount)}</b></td><td><button className="btn secondary" onClick={()=>fillOrder(o)}>Chọn</button></td></tr>)}</tbody></table>:<p className="muted">Khách này chưa có bill còn nợ.</p>}</div>
   </div>
   <div style={{marginTop:18}}><h3>Lịch sử thu tiền</h3><div className="form-grid" style={{gridTemplateColumns:'1fr 1fr 1.4fr auto',marginBottom:12}}><label className="field-label"><span>Từ ngày</span><input className="input" type="date" value={historyFilter.from} onChange={e=>changeHistoryFilter('from',e.target.value)}/></label><label className="field-label"><span>Đến ngày</span><input className="input" type="date" value={historyFilter.to} onChange={e=>changeHistoryFilter('to',e.target.value)}/></label><label className="field-label"><span>Tên khách hàng</span><input className="input" placeholder="Nhập tên khách" value={historyFilter.customer} onChange={e=>changeHistoryFilter('customer',e.target.value)}/></label><button className="btn secondary" style={{alignSelf:'end'}} onClick={()=>{setHistoryFilter({from:'',to:'',customer:''});setHistoryPage(1)}}>Xóa lọc</button></div><table className="table"><thead><tr><th>Mã thu</th><th>Khách hàng</th><th>Ngày</th><th>Tiền mặt</th><th>Chuyển khoản</th><th>Tổng thu</th></tr></thead><tbody>{visibleHistory.map(p=><tr key={p.id}><td>{p.payment_code}</td><td>{p.customer_name}</td><td>{ymd(p.payment_date)}</td><td>{money(p.cash_amount)}</td><td>{money(p.bank_amount)}</td><td><b>{money(p.amount)}</b></td></tr>)}</tbody></table><div className="actions" style={{justifyContent:'space-between',marginTop:12}}><span className="muted">Hiển thị {visibleHistory.length}/{historyRows.length} phiếu thu - trang {currentHistoryPage}/{historyPages}</span><div><button className="btn secondary" disabled={currentHistoryPage<=1} onClick={()=>setHistoryPage(p=>Math.max(1,p-1))}>Trước</button> <button className="btn secondary" disabled={currentHistoryPage>=historyPages} onClick={()=>setHistoryPage(p=>Math.min(historyPages,p+1))}>Sau</button></div></div></div>
  </div>
 </SafePage>;
}
