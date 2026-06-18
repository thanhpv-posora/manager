import React,{useEffect,useMemo,useState}from'react';
import api from'../api/api';
import SafePage from'../components/SafePage';
import MoneyInput from'../components/MoneyInput';
const money=n=>Number(n||0).toLocaleString('en-US')+'đ';
const pageSize=15;
const isoDate=v=>String(v||'').slice(0,10);
const ymd=v=>{const raw=isoDate(v);const m=raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);return m?`${m[3]}/${m[2]}/${m[1]}`:raw};
const billDateLabel=o=>o?.calendar_type==='LUNAR'&&o?.lunar_date_text?`${o.lunar_date_text} ÂL / ${ymd(o?.order_date)} DL`:(ymd(o?.order_date)||'');

export default function Payments(){
 const today=new Date().toISOString().slice(0,10);
 const[customers,setCustomers]=useState([]);
 const[rows,setRows]=useState([]);
 const[summary,setSummary]=useState(null);
 const[form,setForm]=useState({payment_date:today,payment_method:'CASH',cash_amount:'',bank_amount:'',current_bill_amount:''});
 const[editingPayment,setEditingPayment]=useState(null);
 const[historyFilter,setHistoryFilter]=useState({from:'',to:'',customer:''});
 const[historyPage,setHistoryPage]=useState(1);
 const[loading,setLoading]=useState(true);
 const[error,setError]=useState('');
 const[overpayDialog,setOverpayDialog]=useState({open:false,availableAmount:0,surplus:0,oldBills:[]});
 const billTotal=Number(form.current_bill_amount||0);
 const paidTotal=useMemo(()=>Number(form.cash_amount||0)+Number(form.bank_amount||0),[form.cash_amount,form.bank_amount]);
 const remainDebt=Math.max(0,billTotal-paidTotal);
 const loadSummary=async id=>{if(!id)return;setSummary((await api.get('/payments/customer/'+id+'/summary')).data)};
 const loadPayments=async()=>setRows((await api.get('/payments')).data||[]);
 const load=async()=>{try{const user=JSON.parse(localStorage.getItem('user')||'{}');await loadPayments();if(user.role!=='CUSTOMER'){const cs=(await api.get('/customers')).data||[];setCustomers(cs);if(!form.customer_id&&cs.length){setForm(f=>({...f,customer_id:cs[0].id}));await loadSummary(cs[0].id)}}else if(user.customer_id){setForm(f=>({...f,customer_id:user.customer_id}));await loadSummary(user.customer_id)}}catch(e){setError(e.response?.data?.message||e.message)}finally{setLoading(false)}};
 useEffect(()=>{load()},[]);
 const historyRows=useMemo(()=>{const name=String(historyFilter.customer||'').trim().toLowerCase();return(rows||[]).filter(p=>{const d=isoDate(p.payment_date);if(historyFilter.from&&d<historyFilter.from)return false;if(historyFilter.to&&d>historyFilter.to)return false;if(name&&!String(p.customer_name||'').toLowerCase().includes(name))return false;return true})},[rows,historyFilter]);
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
 const buildPayload=(allocateIds=[])=>({
  ...form,
  amount:paidTotal,
  current_bill_amount:billTotal,
  monthly_installment_amount:0,
  installment_amount:0,
  calendar_type:form.selected_bill_calendar_type||'SOLAR',
  lunar_date_text:form.selected_bill_lunar_date_text||'',
  allocate_order_ids:allocateIds
 });
 const oldDebtBills=()=>((summary?.unpaid_orders)||[]).filter(o=>String(o.id)!==String(form.order_id||''));
 const doSave=async(allocateIds=[])=>{
  const payload=buildPayload(allocateIds);
  const res=editingPayment?await api.put('/payments/'+editingPayment.id,payload):await api.post('/payments',payload);
  const allocs=res.data?.old_debt_allocations||[];
  const unused=Number(res.data?.unused_amount||0);
  setForm({...form,cash_amount:'',bank_amount:'',current_bill_amount:'',order_id:''});
  setEditingPayment(null);
  setOverpayDialog({open:false,availableAmount:0,surplus:0,oldBills:[]});
  await loadSummary(form.customer_id);
  await loadPayments();
  let msg=editingPayment?'Đã sửa phiếu thu và phân bổ lại':'Đã lưu thu tiền';
  if(allocs.length) msg += `\nĐã phân bổ bill khác: ${allocs.map(a=>`${a.order_code}: ${money(a.applied_amount)}`).join(', ')}`;
  if(unused>0) msg += `\nTiền dư chưa phân bổ: ${money(unused)}`;
  alert(msg);
 };
 const save=async()=>{
  const surplus=Math.max(0,paidTotal-billTotal);
  const bills=oldDebtBills();
  // V65.33: Nếu khách còn bill nợ cũ thì luôn hỏi chọn bill muốn ưu tiên thanh toán,
  // dù tiền khách đưa nhỏ hơn bill đang thu. Tiền sẽ trừ bill đã chọn trước, còn dư mới trừ bill đang thu.
  if(form.customer_id && paidTotal>0 && bills.length){
   setOverpayDialog({open:true,availableAmount:paidTotal,surplus,oldBills:summary?.unpaid_orders||[]});
   return;
  }
  await doSave([]);
 };
 const confirmOverpay=async()=>{
  // V65.41: backend auto-allocates all open bills by Ngày xuất hàng old -> new.
  // No checkbox ids are needed anymore.
  await doSave([]);
 };
 const autoAllocationPreview=useMemo(()=>{
  let left=Number(overpayDialog.availableAmount||paidTotal||0);
  return (overpayDialog.oldBills||[]).map(b=>{
    const debt=Number(b.debt_amount||0);
    const applied=Math.min(left,debt);
    left=Math.max(0,left-applied);
    return {...b,preview_applied:applied,preview_after:Math.max(0,debt-applied)};
  }).filter(b=>Number(b.preview_applied||0)>0 || String(b.id)===String(form.order_id||''));
 },[overpayDialog,paidTotal,form.order_id]);
 const selectedOldDebtTotal=useMemo(()=>autoAllocationPreview.reduce((sum,b)=>sum+Number(b.preview_applied||0),0),[autoAllocationPreview]);
 const editPayment=p=>{
  if(Number(p.is_locked||0)===1||p.locked_at){alert('Phiếu thu đã chốt, không thể sửa');return;}
  if(String(p.status||'').toUpperCase()==='CANCELLED'){alert('Phiếu thu đã hủy');return;}
  setEditingPayment(p);
  setForm(f=>({...f,customer_id:p.customer_id,payment_date:isoDate(p.payment_date),order_id:p.order_id||'',cash_amount:Number(p.cash_amount||0)||'',bank_amount:Number(p.bank_amount||0)||'',current_bill_amount:p.current_bill_amount||'',payment_method:p.payment_method||'CASH'}));
  if(p.customer_id)loadSummary(p.customer_id);
  window.scrollTo({top:0,behavior:'smooth'});
 };
 const cancelEdit=()=>{setEditingPayment(null);setForm(f=>({...f,cash_amount:'',bank_amount:'',current_bill_amount:'',order_id:''}));};
 const cancelPayment=async p=>{
  if(!await window.appConfirm(`Hủy phiếu thu ${p.payment_code}?\nCông nợ sẽ được tính lại.`,{title:'Hủy phiếu thu',confirmText:'Hủy phiếu',variant:'danger'}))return;
  await api.post('/payments/'+p.id+'/cancel',{note:'Hủy phiếu thu nhập sai'});
  await loadPayments(); if(form.customer_id)await loadSummary(form.customer_id);
  alert('Đã hủy phiếu thu và trả lại công nợ');
 };
 const lockPayment=async p=>{
  if(!await window.appConfirm(`Chốt phiếu thu ${p.payment_code}?\nSau khi chốt sẽ không sửa/xóa được.`,{title:'Chốt phiếu thu',confirmText:'Chốt phiếu thu',variant:'warning'}))return;
  await api.post('/payments/'+p.id+'/lock',{});
  await loadPayments(); if(form.customer_id)await loadSummary(form.customer_id);
  alert('Đã chốt phiếu thu');
 };
 return <SafePage loading={loading} error={error}>
  <div className="card">
   <h3>{editingPayment?'Sửa phiếu thu':'Thu tiền khách'}</h3>{editingPayment&&<div className="ai-alert warn" style={{marginBottom:12}}>Đang sửa phiếu thu <b>{editingPayment.payment_code}</b>. Khi lưu, hệ thống sẽ xóa phân bổ cũ và phân bổ lại theo ngày xuất hàng cũ → mới. <button className="btn secondary" type="button" onClick={cancelEdit}>Hủy sửa</button></div>}
   <p className="muted">Nhập tiền khách trả ở bên trái, chọn nhanh bill còn nợ ở bên phải. Tiền mặt và chuyển khoản nhập độc lập; nếu tổng trả nhỏ hơn bill thì phần còn lại là còn nợ.</p>
   <div className="form-grid" style={{gridTemplateColumns:'2fr 1fr 1fr'}}><label className="field-label"><span>Khách hàng</span><select className="select" value={form.customer_id||''} onChange={changeCustomer}><option value="">Chọn khách</option>{customers.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label className="field-label"><span>Ngày thu</span><input className="input" type="date" value={form.payment_date} onChange={e=>setForm({...form,payment_date:e.target.value})}/></label><label className="field-label"><span>Tổng bill hôm nay</span><MoneyInput placeholder="Ví dụ: 60,000,000" value={form.current_bill_amount||''} onChange={setBillTotal}/></label></div>
   <div className="grid cols-2" style={{alignItems:'start',marginTop:14}}>
    <div className="card" style={{boxShadow:'none',border:'1px solid #fee2e2'}}><h3>Tiền của khách</h3><div className="form-grid"><label className="field-label"><span>Tiền mặt</span><MoneyInput placeholder="Ví dụ: 10,000,000" value={form.cash_amount||''} onChange={changeCash}/></label><label className="field-label"><span>Chuyển khoản</span><MoneyInput placeholder="Ví dụ: 5,000,000" value={form.bank_amount||''} onChange={changeBank}/></label></div><div className="payment-total-box"><div>Tổng bill hôm nay</div><b>{money(billTotal)}</b>{form.selected_bill_date_label&&<span>Ngày bill đang thu: <b>{form.selected_bill_date_label}</b></span>}<span>Tiền mặt {money(form.cash_amount)} + chuyển khoản {money(form.bank_amount)} = {money(paidTotal)}</span><span>Còn nợ: {money(remainDebt)}</span></div><div className="actions" style={{marginTop:12}}><button type="button" className="btn" disabled={!form.customer_id||paidTotal<=0} onClick={save}>{editingPayment?'Lưu sửa phiếu thu':'Lưu thu tiền'}</button></div></div>
    <div className="card" style={{boxShadow:'none',border:'1px solid #e5e7eb'}}><h3>Bill còn nợ</h3>{summary?.unpaid_orders?.length?<table className="table"><thead><tr><th>Bill</th><th>Ngày</th><th>Còn nợ</th><th></th></tr></thead><tbody>{summary.unpaid_orders.map(o=><tr key={o.id}><td>{o.order_code}</td><td>{billDateLabel(o)}</td><td><b>{money(o.debt_amount)}</b></td><td><button className="btn secondary" onClick={()=>fillOrder(o)}>Chọn</button></td></tr>)}</tbody></table>:<p className="muted">Khách này chưa có bill còn nợ.</p>}</div>
   </div>
   <div style={{marginTop:18}}><h3>Lịch sử thu tiền</h3><div className="form-grid" style={{gridTemplateColumns:'1fr 1fr 1.4fr auto',marginBottom:12}}><label className="field-label"><span>Từ ngày</span><input className="input" type="date" value={historyFilter.from} onChange={e=>changeHistoryFilter('from',e.target.value)}/></label><label className="field-label"><span>Đến ngày</span><input className="input" type="date" value={historyFilter.to} onChange={e=>changeHistoryFilter('to',e.target.value)}/></label><label className="field-label"><span>Tên khách hàng</span><input className="input" placeholder="Nhập tên khách" value={historyFilter.customer} onChange={e=>changeHistoryFilter('customer',e.target.value)}/></label><button className="btn secondary" style={{alignSelf:'end'}} onClick={()=>{setHistoryFilter({from:'',to:'',customer:''});setHistoryPage(1)}}>Xóa lọc</button></div><table className="table"><thead><tr><th>Mã thu</th><th>Khách hàng</th><th>Ngày</th><th>Tiền mặt</th><th>Chuyển khoản</th><th>Tổng thu</th><th>Trạng thái</th><th>Thao tác</th></tr></thead><tbody>{visibleHistory.map(p=><tr key={p.id}><td>{p.payment_code}</td><td>{p.customer_name}</td><td>{ymd(p.payment_date)}</td><td>{money(p.cash_amount)}</td><td>{money(p.bank_amount)}</td><td><b>{money(p.amount)}</b></td><td>{String(p.status||'ACTIVE')}{(Number(p.is_locked||0)===1||p.locked_at)?' / Đã chốt':''}</td><td><div className="row-actions"><button className="btn secondary" disabled={Number(p.is_locked||0)===1||p.locked_at||String(p.status||'').toUpperCase()==='CANCELLED'} onClick={()=>editPayment(p)}>Sửa</button><button className="btn secondary" disabled={Number(p.is_locked||0)===1||p.locked_at||String(p.status||'').toUpperCase()==='CANCELLED'} onClick={()=>cancelPayment(p)}>Hủy</button><button className="btn" disabled={Number(p.is_locked||0)===1||p.locked_at||String(p.status||'').toUpperCase()==='CANCELLED'} onClick={()=>lockPayment(p)}>Chốt</button></div></td></tr>)}</tbody></table><div className="actions" style={{justifyContent:'space-between',marginTop:12}}><span className="muted">Hiển thị {visibleHistory.length}/{historyRows.length} phiếu thu - trang {currentHistoryPage}/{historyPages}</span><div><button className="btn secondary" disabled={currentHistoryPage<=1} onClick={()=>setHistoryPage(p=>Math.max(1,p-1))}>Trước</button> <button className="btn secondary" disabled={currentHistoryPage>=historyPages} onClick={()=>setHistoryPage(p=>Math.min(historyPages,p+1))}>Sau</button></div></div></div>
  </div>
  {overpayDialog.open&&<div className="payment-overpay-overlay">
   <div className="card payment-overpay-dialog">
    <div className="payment-overpay-head">
     <div><h3>Xem trước phân bổ thanh toán</h3><p className="muted">Hệ thống tự phân bổ theo ngày xuất hàng cũ đến mới. Bill cũ được thanh toán trước; tiền dư tự chuyển sang bill kế tiếp.</p></div>
     <button className="btn secondary" onClick={()=>setOverpayDialog({open:false,availableAmount:0,surplus:0,oldBills:[]})}>Đóng</button>
    </div>
    <div className="payment-overpay-summary">
     <span>Bill đang thu: <b>{money(billTotal)}</b></span>
     <span>Khách đưa: <b>{money(paidTotal)}</b></span>
     <span>Tiền có thể phân bổ: <b>{money(overpayDialog.availableAmount||paidTotal)}</b></span>
     <span>Dự kiến phân bổ: <b>{money(Math.min(selectedOldDebtTotal,overpayDialog.availableAmount||paidTotal))}</b></span>
    </div>
    <div className="payment-overpay-table-wrap">
     <table className="table payment-overpay-table"><thead><tr><th>Thứ tự</th><th>Bill</th><th>Ngày xuất hàng</th><th>Còn nợ trước</th><th>Sẽ thanh toán</th><th>Còn nợ sau</th></tr></thead><tbody>{autoAllocationPreview.map((o,idx)=><tr key={o.id}>
      <td>{idx+1}</td><td>{o.order_code}</td><td>{billDateLabel(o)}</td><td><b>{money(o.debt_amount)}</b></td><td><b>{money(o.preview_applied)}</b></td><td>{money(o.preview_after)}</td>
     </tr>)}</tbody></table>
    </div>
    <div className="actions" style={{justifyContent:'space-between',marginTop:12}}>
     <button className="btn secondary" onClick={()=>setOverpayDialog({open:false,availableAmount:0,surplus:0,oldBills:[]})}>Hủy</button>
     <button className="btn" onClick={confirmOverpay}>Lưu theo phân bổ tự động</button>
    </div>
   </div>
  </div>}
 </SafePage>;
}
