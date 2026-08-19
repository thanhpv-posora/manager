import React,{useEffect,useMemo,useState,useRef}from'react';
import {Pencil,XCircle,CheckCircle2}from'lucide-react';
import api from'../api/api';
import SafePage from'../components/SafePage';
import MoneyInput from'../components/MoneyInput';
import EnterpriseAutocomplete from'../components/common/EnterpriseAutocomplete';
import {formatLunarDate,solarToLunar,parseLunarText as parseLunarDateText,lunarToSolarDate}from'../utils/lunarDate';
const money=n=>Number(n||0).toLocaleString('en-US')+'đ';
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
 const[historyPageSize,setHistoryPageSize]=useState(20);
 const[loading,setLoading]=useState(true);
 const[error,setError]=useState('');
 // FEAT (overpay guard): the backend (PaymentAgent.create()) is the single
 // authority on whether an overpay is allowed and, if so, exactly which
 // other bills can receive the excess — this dialog only ever reflects what
 // the backend's error response says (mode:'BLOCK' = cannot proceed at all,
 // mode:'CHOICE' = pick which other bill(s) absorb the excess, in order).
 // Never a frontend-only computation of what "should" be allowed.
 const[overpayDialog,setOverpayDialog]=useState({open:false,mode:null,message:'',details:null,chosenIds:[]});
 // feat(debt): period contribution — "Đã góp trong kỳ" for the selected
 // customer, solar or lunar range. Calendar mode only changes which dates are
 // queried; it never touches accounting totals (LOCKED RULE H).
 const[periodCalendarType,setPeriodCalendarType]=useState('SOLAR');
 const[periodFrom,setPeriodFrom]=useState(today);
 const[periodTo,setPeriodTo]=useState(today);
 const[periodFromLunar,setPeriodFromLunar]=useState(formatLunarDate(today));
 const[periodToLunar,setPeriodToLunar]=useState(formatLunarDate(today));
 const[periodData,setPeriodData]=useState(null);
 const[periodError,setPeriodError]=useState('');
 // GO-LIVE BLOCKER 1: mint once per new "Thu tiền" attempt, reused verbatim on
 // retry (double-click before the button re-renders, or resubmitting after a
 // failed request) so PaymentAgent.create()'s idempotency check can dedupe it;
 // rotated to null only after a successful create (mirrors CreateOrder.jsx's
 // billIdempotencyKeyRef). Not used for editingPayment (PUT /payments/:id).
 const paymentIdemKeyRef=useRef(null);
 const billTotal=Number(form.current_bill_amount||0);
 const paidTotal=useMemo(()=>Number(form.cash_amount||0)+Number(form.bank_amount||0),[form.cash_amount,form.bank_amount]);
 const remainDebt=Math.max(0,billTotal-paidTotal);
 const loadSummary=async id=>{if(!id)return;setSummary((await api.get('/payments/customer/'+id+'/summary')).data)};
 const loadPeriod=async(id=form.customer_id,ct=periodCalendarType,from=periodFrom,to=periodTo,fromLunar=periodFromLunar,toLunar=periodToLunar)=>{
  if(!id){setPeriodData(null);return}
  try{
   setPeriodError('');
   const params=ct==='LUNAR'
    ?{calendar_type:'LUNAR',from_lunar_date_text:fromLunar,to_lunar_date_text:toLunar}
    :{calendar_type:'SOLAR',from_date:from,to_date:to};
   setPeriodData((await api.get('/payments/customer/'+id+'/period-contribution',{params})).data);
  }catch(e){setPeriodError(e.response?.data?.message||e.message);setPeriodData(null)}
 };
 const loadPayments=async()=>setRows((await api.get('/payments')).data||[]);
 const load=async()=>{try{
  const user=JSON.parse(localStorage.getItem('user')||'{}');await loadPayments();
  const cs=(await api.get('/partners',{params:{role:'customer'}})).data||[];setCustomers(cs);
  const initId=user.role!=='CUSTOMER'?(!form.customer_id&&cs.length?String(cs[0].id):''):(user.customer_id?String(user.customer_id):'');
  if(initId){
   setForm(f=>({...f,customer_id:initId}));
   await loadSummary(initId);
   const c=cs.find(x=>String(x.id)===initId);
   const ct=String(c?.billing_calendar_type||'SOLAR').toUpperCase()==='LUNAR'?'LUNAR':'SOLAR';
   setPeriodCalendarType(ct);
   await loadPeriod(initId,ct,periodFrom,periodTo,periodFromLunar,periodToLunar);
  }
 }catch(e){setError(e.response?.data?.message||e.message)}finally{setLoading(false)}};
 useEffect(()=>{load()},[]);
 const historyRows=useMemo(()=>{const name=String(historyFilter.customer||'').trim().toLowerCase();return(rows||[]).filter(p=>{const d=isoDate(p.payment_date);if(historyFilter.from&&d<historyFilter.from)return false;if(historyFilter.to&&d>historyFilter.to)return false;if(name&&!String(p.customer_name||'').toLowerCase().includes(name))return false;return true})},[rows,historyFilter]);
 const historyPages=Math.max(1,Math.ceil(historyRows.length/historyPageSize));
 const currentHistoryPage=Math.min(historyPage,historyPages);
 const visibleHistory=historyRows.slice((currentHistoryPage-1)*historyPageSize,currentHistoryPage*historyPageSize);
 const changeHistoryFilter=(k,v)=>{setHistoryFilter(f=>({...f,[k]:v}));setHistoryPage(1)};
 const setBillTotal=v=>setForm({...form,current_bill_amount:v});
 const changeCustomer=e=>{
  const id=e.target.value;
  setForm({...form,customer_id:id,order_id:'',current_bill_amount:'',cash_amount:'',bank_amount:''});
  loadSummary(id);
  // Default period calendar follows the customer's own billing calendar,
  // same convention as Installments.jsx — user can still toggle it.
  const c=customers.find(x=>String(x.id)===String(id));
  const ct=String(c?.billing_calendar_type||'SOLAR').toUpperCase()==='LUNAR'?'LUNAR':'SOLAR';
  setPeriodCalendarType(ct);
  loadPeriod(id,ct,periodFrom,periodTo,periodFromLunar,periodToLunar);
 };
 const fillOrder=o=>setForm({...form,order_id:o.id,current_bill_amount:o.debt_amount,cash_amount:'',bank_amount:'',payment_method:'CASH',selected_bill_calendar_type:o.calendar_type||'SOLAR',selected_bill_lunar_date_text:o.lunar_date_text||'',selected_bill_date_label:billDateLabel(o)});
 const calcPaymentMethod=(cash,bank)=>{const c=Number(cash||0),b=Number(bank||0);if(c>0&&b>0)return'MIXED';if(b>0)return'BANK_TRANSFER';return'CASH'};
 const changeBank=v=>setForm({...form,bank_amount:v,payment_method:calcPaymentMethod(form.cash_amount,v)});
 const changeCash=v=>setForm({...form,cash_amount:v,payment_method:calcPaymentMethod(v,form.bank_amount)});
 // FEAT (Trả đủ): billTotal (form.current_bill_amount) is already the
 // authoritative current-bill remaining — either autofilled from
 // summary().unpaid_orders (fixed to the same payment_allocations-based
 // figure the backend overpay guard enforces, commit a051bf4) when a bill
 // was picked via "Chọn", or the operator's own manually typed figure when
 // none was. Never a second/stale source, never an extra request here.
 // cash = billTotal - bank (never negative) so cash+bank lands exactly on
 // billTotal — matches the existing "Còn nợ = billTotal-paidTotal" mental
 // model already on this screen; bank is read, never cleared or capped.
 const payFull=()=>changeCash(String(Math.max(0,billTotal-Number(form.bank_amount||0))));
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
 const closeOverpayDialog=()=>setOverpayDialog({open:false,mode:null,message:'',details:null,chosenIds:[]});
 const doSave=async(allocateIds=[])=>{
  const payload=buildPayload(allocateIds);
  let res;
  if(editingPayment){
   res=await api.put('/payments/'+editingPayment.id,payload);
  }else{
   if(!paymentIdemKeyRef.current){
    paymentIdemKeyRef.current=(crypto.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random().toString(36).slice(2)}`);
   }
   res=await api.post('/payments',{...payload,idempotency_key:paymentIdemKeyRef.current});
   // Succeeded — rotate so the NEXT payment gets a fresh key instead of ever
   // being mistaken for a replay of this one. Left intact on throw so a retry
   // of this same attempt reuses it (see ref comment above).
   paymentIdemKeyRef.current=null;
  }
  const allocs=res.data?.old_debt_allocations||[];
  const unused=Number(res.data?.unused_amount||0);
  setForm({...form,cash_amount:'',bank_amount:'',current_bill_amount:'',order_id:''});
  setEditingPayment(null);
  closeOverpayDialog();
  await loadSummary(form.customer_id);
  await loadPayments();
  await loadPeriod(form.customer_id);
  let msg=editingPayment?'Đã sửa phiếu thu và phân bổ lại':'Đã lưu thu tiền';
  if(allocs.length) msg += `\nĐã phân bổ bill khác: ${allocs.map(a=>`${a.order_code}: ${money(a.applied_amount)}`).join(', ')}`;
  if(unused>0) msg += `\nTiền dư chưa phân bổ: ${money(unused)}`;
  alert(msg);
 };
 // FEAT (overpay guard): PaymentAgent.create() is the sole authority on
 // whether an excess-over-current-bill amount is allowed. A business
 // validation error (code PAYMENT_EXCEEDS_AVAILABLE_DEBT /
 // PAYMENT_ALLOCATION_CHOICE_REQUIRED) opens this dialog instead of the
 // generic alert; any other error keeps the previous alert-based handling.
 //
 // BUG FIX: paymentIdemKeyRef is deliberately preserved across a THROWN
 // create() (see its own comment) so a genuine network-level retry of the
 // exact same request dedupes correctly. But these two codes mean the user
 // is about to resubmit a MATERIALLY DIFFERENT request (a chosen
 // allocate_order_ids, or a corrected amount) — reusing the same key made
 // PaymentAgent.create() short-circuit on the idempotency cache
 // (getIdempotentResult() sees the prior FAILED row and throws
 // PAYMENT_PREVIOUS_FAILED with that attempt's stale cached message,
 // *never re-reading the new allocate_order_ids at all*). Confirmed live:
 // resubmitting with the correct allocate_order_ids under the same key
 // reproduced exactly this — the checkbox selection was correct and sent,
 // the backend just never looked at it. Clearing the ref here treats the
 // corrected resubmission as the new, distinct operation it actually is.
 const attemptSave=async(allocateIds=[])=>{
  try{
   await doSave(allocateIds);
  }catch(e){
   const code=e.response?.data?.code;
   const message=e.response?.data?.message||e.message||'Không lưu được phiếu thu.';
   const details=e.response?.data?.details||null;
   if(code==='PAYMENT_EXCEEDS_AVAILABLE_DEBT'){
    paymentIdemKeyRef.current=null;
    setOverpayDialog({open:true,mode:'BLOCK',message,details,chosenIds:[]});
    return;
   }
   if(code==='PAYMENT_ALLOCATION_CHOICE_REQUIRED'){
    paymentIdemKeyRef.current=null;
    setOverpayDialog({open:true,mode:'CHOICE',message,details,chosenIds:overpayDialog.chosenIds||[]});
    return;
   }
   alert(message);
  }
 };
 const save=async()=>{
  if(!form.customer_id||paidTotal<=0)return;
  await attemptSave([]);
 };
 // Click order = allocation order (business rule: operator decides which old
 // bill(s) absorb the excess, not automatic date order) — clicking an
 // already-chosen bill removes it; a later click always appends to the end.
 const toggleChosenBill=id=>setOverpayDialog(d=>({
  ...d,
  chosenIds:d.chosenIds.includes(id)?d.chosenIds.filter(x=>x!==id):[...d.chosenIds,id]
 }));
 // Mirrors the backend's own greedy in-chosen-order allocation
 // (_applyPaymentToOrderAuthoritative loop in PaymentAgent.create()) so the
 // preview always matches what a confirm will actually do.
 const choicePreview=useMemo(()=>{
  const eligible=overpayDialog.details?.eligible_bills||[];
  const byId=new Map(eligible.map(b=>[b.id,b]));
  let left=Number(overpayDialog.details?.surplus||0);
  const rows=[];
  for(const id of (overpayDialog.chosenIds||[])){
   const bill=byId.get(id);
   if(!bill)continue;
   const remaining=Number(bill.remaining||0);
   const applied=Math.min(left,remaining);
   left=Math.max(0,left-applied);
   rows.push({...bill,preview_applied:applied,preview_after:Math.max(0,remaining-applied)});
  }
  return {rows,coveredTotal:Number(overpayDialog.details?.surplus||0)-left,remainingUncovered:left};
 },[overpayDialog.chosenIds,overpayDialog.details]);
 const confirmChoice=async()=>{
  if(choicePreview.remainingUncovered>0.01)return;
  await attemptSave(overpayDialog.chosenIds);
 };
 const editPayment=p=>{
  if(Number(p.is_locked||0)===1||p.locked_at){alert('Phiếu thu đã chốt, không thể sửa');return;}
  if(String(p.status||'').toUpperCase()==='CANCELLED'){alert('Phiếu thu đã hủy');return;}
  setEditingPayment(p);
  setForm(f=>({...f,customer_id:p.customer_id,payment_date:isoDate(p.payment_date),order_id:p.order_id||'',cash_amount:Number(p.cash_amount||0)||'',bank_amount:Number(p.bank_amount||0)||'',current_bill_amount:p.current_bill_amount||'',payment_method:p.payment_method||'CASH'}));
  if(p.customer_id)loadSummary(p.customer_id);
  window.scrollTo({top:0,behavior:'smooth'});
 };
 const cancelEdit=()=>{setEditingPayment(null);setForm(f=>({...f,cash_amount:'',bank_amount:'',current_bill_amount:'',order_id:''}));};
 const changePeriodCalendarType=ct=>{
  setPeriodCalendarType(ct);
  if(ct==='LUNAR'){setPeriodFromLunar(formatLunarDate(periodFrom||today));setPeriodToLunar(formatLunarDate(periodTo||today));}
 };
 const changePeriodFrom=v=>{setPeriodFrom(v);if(periodCalendarType==='LUNAR')setPeriodFromLunar(formatLunarDate(v||today));};
 const changePeriodTo=v=>{setPeriodTo(v);if(periodCalendarType==='LUNAR')setPeriodToLunar(formatLunarDate(v||today));};
 const changePeriodFromLunar=v=>{setPeriodFromLunar(v);const solar=lunarToSolarDate(parseLunarDateText(v));if(solar)setPeriodFrom(solar);};
 const changePeriodToLunar=v=>{setPeriodToLunar(v);const solar=lunarToSolarDate(parseLunarDateText(v));if(solar)setPeriodTo(solar);};
 const runPeriod=()=>loadPeriod(form.customer_id,periodCalendarType,periodFrom,periodTo,periodFromLunar,periodToLunar);
 const cancelPayment=async p=>{
  if(!await window.appConfirm(`Hủy phiếu thu ${p.payment_code}?\nCông nợ sẽ được tính lại.`,{title:'Hủy phiếu thu',confirmText:'Hủy phiếu',variant:'danger'}))return;
  await api.post('/payments/'+p.id+'/cancel',{note:'Hủy phiếu thu nhập sai'});
  await loadPayments(); if(form.customer_id){await loadSummary(form.customer_id);await loadPeriod(form.customer_id);}
  alert('Đã hủy phiếu thu và trả lại công nợ');
 };
 const lockPayment=async p=>{
  if(!await window.appConfirm(`Chốt phiếu thu ${p.payment_code}?\nSau khi chốt sẽ không sửa/xóa được.`,{title:'Chốt phiếu thu',confirmText:'Chốt phiếu thu',variant:'warning'}))return;
  await api.post('/payments/'+p.id+'/lock',{});
  await loadPayments(); if(form.customer_id){await loadSummary(form.customer_id);await loadPeriod(form.customer_id);}
  alert('Đã chốt phiếu thu');
 };
 return <SafePage loading={loading} error={error}>
  <div className="card">
   <h3>{editingPayment?'Sửa phiếu thu':'Thu tiền khách'}</h3>{editingPayment&&<div className="ai-alert warn" style={{marginBottom:12}}>Đang sửa phiếu thu <b>{editingPayment.payment_code}</b>. Khi lưu, hệ thống sẽ xóa phân bổ cũ và phân bổ lại theo ngày xuất hàng cũ → mới. <button className="btn secondary" type="button" onClick={cancelEdit}>Hủy sửa</button></div>}
   <p className="muted">Nhập tiền khách trả ở bên trái, chọn nhanh bill còn nợ ở bên phải. Tiền mặt và chuyển khoản nhập độc lập; nếu tổng trả nhỏ hơn bill thì phần còn lại là còn nợ.</p>
   <div className="form-grid" style={{gridTemplateColumns:'2fr 1fr 1fr'}}><label className="field-label"><span>Khách hàng</span><EnterpriseAutocomplete items={customers} value={customers.find(c=>String(c.id)===String(form.customer_id||''))||null} onChange={item=>changeCustomer({target:{value:item?String(item.id):''}})} placeholder="Tìm khách hàng..." displayField="name" secondaryFields={['customer_code','phone']} searchFields={['name','customer_code','phone','address']} filter={item=>(Number(item.partner_type||2)&2)===2} emptyText="Không tìm thấy khách hàng" getItemKey={item=>item.id} getTooltip={item=>`ID: ${item.id}\nSĐT: ${item.phone||'—'}`}/></label><label className="field-label"><span>Ngày thu</span><input className="input" type="date" value={form.payment_date} onChange={e=>setForm({...form,payment_date:e.target.value})}/></label><label className="field-label"><span>Tổng bill hôm nay</span><MoneyInput placeholder="Ví dụ: 60,000,000" value={form.current_bill_amount||''} onChange={setBillTotal}/></label></div>
   {form.customer_id&&<div className="payment-total-box" style={{marginTop:14,background:'#fff7ed',border:'1px solid #fdba74'}}>
    <div>TỔNG DƯ NỢ HIỆN TẠI</div>
    <b style={{fontSize:22}}>{money(periodData?.current_debt??summary?.current_debt??0)}</b>
   </div>}
   <div className="grid cols-2" style={{alignItems:'start',marginTop:14}}>
    <div className="card" style={{boxShadow:'none',border:'1px solid #fee2e2'}}><h3>Tiền của khách</h3><div className="form-grid"><label className="field-label"><span>Tiền mặt <button type="button" className="btn tiny secondary" style={{marginLeft:6,padding:'1px 8px'}} disabled={billTotal<=0} title="Điền toàn bộ số tiền còn lại của bill vào Tiền mặt" onClick={payFull}>Trả đủ</button></span><MoneyInput placeholder="Ví dụ: 10,000,000" value={form.cash_amount||''} onChange={changeCash}/></label><label className="field-label"><span>Chuyển khoản</span><MoneyInput placeholder="Ví dụ: 5,000,000" value={form.bank_amount||''} onChange={changeBank}/></label></div><div className="payment-total-box"><div>Tổng bill hôm nay</div><b>{money(billTotal)}</b>{form.selected_bill_date_label&&<span>Ngày bill đang thu: <b>{form.selected_bill_date_label}</b></span>}<span>Tiền mặt {money(form.cash_amount)} + chuyển khoản {money(form.bank_amount)} = {money(paidTotal)}</span><span>Còn nợ: {money(remainDebt)}</span></div><div className="actions" style={{marginTop:12}}><button type="button" className="btn" disabled={!form.customer_id||paidTotal<=0} onClick={save}>{editingPayment?'Lưu sửa phiếu thu':'Lưu thu tiền'}</button></div></div>
    <div className="card" style={{boxShadow:'none',border:'1px solid #e5e7eb'}}><h3>Bill còn nợ</h3>{summary?.unpaid_orders?.length?<table className="table"><thead><tr><th>Bill</th><th>Ngày</th><th>Còn nợ</th><th></th></tr></thead><tbody>{summary.unpaid_orders.map(o=><tr key={o.id}><td>{o.order_code}</td><td>{billDateLabel(o)}</td><td><b>{money(o.debt_amount)}</b></td><td><button className="btn secondary" onClick={()=>fillOrder(o)}>Chọn</button></td></tr>)}</tbody></table>:<p className="muted">Khách này chưa có bill còn nợ.</p>}</div>
   </div>
   {form.customer_id&&<div className="card" style={{marginTop:18}}>
    <h3>Đã góp trong kỳ</h3>
    <p className="muted">Chỉ tính các phiếu thu thực tế (không tính lịch góp chưa thu, đã loại phiếu hủy). Đổi loại lịch chỉ đổi cách chọn khoảng ngày, không đổi số liệu công nợ.</p>
    <div className="form-grid" style={{gridTemplateColumns:'auto 1fr 1fr auto',alignItems:'end'}}>
     <label className="field-label"><span>Loại lịch</span>
      <select className="select" value={periodCalendarType} onChange={e=>changePeriodCalendarType(e.target.value)}>
       <option value="SOLAR">Dương lịch</option>
       <option value="LUNAR">Âm lịch</option>
      </select>
     </label>
     {periodCalendarType==='LUNAR'?<>
      <label className="field-label"><span>Từ ngày âm lịch</span><input className="input" value={periodFromLunar} onChange={e=>changePeriodFromLunar(e.target.value)} placeholder="VD: 01/03/2026"/></label>
      <label className="field-label"><span>Đến ngày âm lịch</span><input className="input" value={periodToLunar} onChange={e=>changePeriodToLunar(e.target.value)} placeholder="VD: 30/03/2026"/></label>
     </>:<>
      <label className="field-label"><span>Từ ngày</span><input className="input" type="date" value={periodFrom} onChange={e=>changePeriodFrom(e.target.value)}/></label>
      <label className="field-label"><span>Đến ngày</span><input className="input" type="date" value={periodTo} onChange={e=>changePeriodTo(e.target.value)}/></label>
     </>}
     <button type="button" className="btn" onClick={runPeriod}>Thống kê</button>
    </div>
    {periodError&&<div className="ai-alert danger" style={{marginTop:10}}>{periodError}</div>}
    {periodData&&<>
     <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))',gap:12,marginTop:14}}>
      <div className="payment-total-box" style={{marginTop:0}}><div>Đã góp trong kỳ</div><b>{money(periodData.period_summary.total)}</b></div>
      <div className="payment-total-box" style={{marginTop:0}}><div>Số lần góp</div><b>{periodData.period_summary.payment_count}</b></div>
      <div className="payment-total-box" style={{marginTop:0}}><div>Tiền mặt trong kỳ</div><b>{money(periodData.period_summary.cash_total)}</b></div>
      <div className="payment-total-box" style={{marginTop:0}}><div>Chuyển khoản trong kỳ</div><b>{money(periodData.period_summary.bank_total)}</b></div>
      {periodData.remaining_plan_total!==undefined&&<div className="payment-total-box" style={{marginTop:0}}><div>Còn theo kế hoạch góp</div><b>{money(periodData.remaining_plan_total)}</b></div>}
     </div>
     <table className="table" style={{marginTop:14}}>
      <thead><tr><th>Ngày góp</th><th>Ngày âm tương ứng</th><th>Mã phiếu thu</th><th>Mã bill / phân bổ</th><th>Tiền mặt</th><th>Chuyển khoản</th><th>Tổng góp</th><th>Ghi chú</th></tr></thead>
      <tbody>{periodData.rows.length?periodData.rows.map(r=><tr key={r.payment_id}>
        <td>{ymd(r.payment_date)}</td>
        <td>{r.lunar_date_text} ÂL</td>
        <td>{r.payment_code}</td>
        <td>{r.bill_codes||'—'}</td>
        <td>{money(r.cash_amount)}</td>
        <td>{money(r.bank_amount)}</td>
        <td><b>{money(r.total_amount)}</b></td>
        <td>{r.note}</td>
       </tr>):<tr><td colSpan="8" className="muted" style={{textAlign:'center'}}>Không có phiếu thu nào trong kỳ đã chọn</td></tr>}</tbody>
      {periodData.rows.length>0&&<tfoot><tr>
        <td colSpan="4" style={{textAlign:'right'}}><b>TỔNG</b></td>
        <td><b>{money(periodData.period_summary.cash_total)}</b></td>
        <td><b>{money(periodData.period_summary.bank_total)}</b></td>
        <td><b>{money(periodData.period_summary.total)}</b></td>
        <td></td>
       </tr></tfoot>}
     </table>
    </>}
   </div>}
   <div style={{marginTop:18}}><h3>Lịch sử thu tiền</h3><div className="form-grid" style={{gridTemplateColumns:'1fr 1fr 1.4fr auto',marginBottom:12}}><label className="field-label"><span>Từ ngày</span><input className="input" type="date" value={historyFilter.from} onChange={e=>changeHistoryFilter('from',e.target.value)}/></label><label className="field-label"><span>Đến ngày</span><input className="input" type="date" value={historyFilter.to} onChange={e=>changeHistoryFilter('to',e.target.value)}/></label><label className="field-label"><span>Tên khách hàng</span><input className="input" placeholder="Nhập tên khách" value={historyFilter.customer} onChange={e=>changeHistoryFilter('customer',e.target.value)}/></label><button className="btn secondary" style={{alignSelf:'end'}} onClick={()=>{setHistoryFilter({from:'',to:'',customer:''});setHistoryPage(1)}}>Xóa lọc</button></div><table className="table"><thead><tr><th>Mã thu</th><th>Khách hàng</th><th>Ngày</th><th>Tiền mặt</th><th>Chuyển khoản</th><th>Tổng thu</th><th>Trạng thái</th><th>Thao tác</th></tr></thead><tbody>{visibleHistory.map(p=><tr key={p.id}><td>{p.payment_code}</td><td>{p.customer_name}</td><td>{ymd(p.payment_date)}</td><td>{money(p.cash_amount)}</td><td>{money(p.bank_amount)}</td><td><b>{money(p.amount)}</b></td><td>{String(p.status||'ACTIVE')}{(Number(p.is_locked||0)===1||p.locked_at)?' / Đã chốt':''}</td><td><div style={{display:'flex',flexWrap:'nowrap',gap:6,alignItems:'center',justifyContent:'center'}}><button className="btn secondary" title="Sửa" style={{padding:0,width:32,height:32,display:'inline-flex',alignItems:'center',justifyContent:'center'}} disabled={Number(p.is_locked||0)===1||p.locked_at||String(p.status||'').toUpperCase()==='CANCELLED'} onClick={()=>editPayment(p)}><Pencil size={14}/></button><button className="btn secondary" title="Hủy" style={{padding:0,width:32,height:32,display:'inline-flex',alignItems:'center',justifyContent:'center'}} disabled={Number(p.is_locked||0)===1||p.locked_at||String(p.status||'').toUpperCase()==='CANCELLED'} onClick={()=>cancelPayment(p)}><XCircle size={14}/></button><button className="btn" title="Chốt" style={{padding:0,width:32,height:32,display:'inline-flex',alignItems:'center',justifyContent:'center'}} disabled={Number(p.is_locked||0)===1||p.locked_at||String(p.status||'').toUpperCase()==='CANCELLED'} onClick={()=>lockPayment(p)}><CheckCircle2 size={14}/></button></div></td></tr>)}</tbody></table><div style={{display:'flex',justifyContent:'flex-end',alignItems:'center',gap:8,marginTop:12,flexWrap:'wrap'}}><select className="select" value={historyPageSize} onChange={e=>{setHistoryPageSize(Number(e.target.value));setHistoryPage(1);}} style={{width:'auto'}}><option value={10}>10 / trang</option><option value={20}>20 / trang</option><option value={50}>50 / trang</option><option value={100}>100 / trang</option></select><span className="muted">Trang {currentHistoryPage} / {historyPages}</span><button className="btn secondary" disabled={currentHistoryPage<=1} onClick={()=>setHistoryPage(p=>Math.max(1,p-1))}>Trước</button><button className="btn secondary" disabled={currentHistoryPage>=historyPages} onClick={()=>setHistoryPage(p=>Math.min(historyPages,p+1))}>Sau</button></div></div>
  </div>
  {overpayDialog.open&&overpayDialog.mode==='BLOCK'&&<div className="payment-overpay-overlay">
   <div className="card payment-overpay-dialog">
    <div className="payment-overpay-head">
     <div><h3>Không thể lưu thu tiền</h3><p className="muted" style={{whiteSpace:'pre-line'}}>{overpayDialog.message}</p></div>
     <button className="btn secondary" onClick={closeOverpayDialog}>Đóng</button>
    </div>
    <div className="payment-overpay-summary">
     {overpayDialog.details?.current_bill_remaining!==undefined&&overpayDialog.details?.total_available_debt===undefined&&<>
      <span>Bill còn lại: <b>{money(overpayDialog.details.current_bill_remaining)}</b></span>
      <span>Tiền nhập: <b>{money(overpayDialog.details.entered_amount)}</b></span>
      <span>Tiền dư: <b>{money(overpayDialog.details.surplus)}</b></span>
     </>}
     {overpayDialog.details?.total_available_debt!==undefined&&<>
      <span>Tổng công nợ có thể thanh toán: <b>{money(overpayDialog.details.total_available_debt)}</b></span>
      <span>Tiền nhập: <b>{money(overpayDialog.details.entered_amount)}</b></span>
      <span>Vượt quá: <b>{money(overpayDialog.details.over_amount)}</b></span>
     </>}
    </div>
    <div className="actions" style={{justifyContent:'flex-end',marginTop:12}}>
     <button className="btn" onClick={closeOverpayDialog}>Sửa số tiền</button>
    </div>
   </div>
  </div>}
  {overpayDialog.open&&overpayDialog.mode==='CHOICE'&&<div className="payment-overpay-overlay">
   <div className="card payment-overpay-dialog">
    <div className="payment-overpay-head">
     <div><h3>Chọn bill nhận tiền dư</h3><p className="muted">Bill đang thu đã đủ tiền. Chọn (các) bill khác sẽ nhận phần tiền dư — theo đúng thứ tự bạn chọn.</p></div>
     <button className="btn secondary" onClick={closeOverpayDialog}>Đóng</button>
    </div>
    <div className="payment-overpay-summary">
     <span>Bill đang thu còn lại: <b>{money(overpayDialog.details?.current_bill_remaining)}</b></span>
     <span>Khách đưa: <b>{money(overpayDialog.details?.entered_amount)}</b></span>
     <span>Tiền dư cần phân bổ: <b>{money(overpayDialog.details?.surplus)}</b></span>
     <span>Đã chọn đủ: <b>{money(choicePreview.coveredTotal)}</b>{choicePreview.remainingUncovered>0.01&&<span style={{color:'#b91c1c'}}> (còn thiếu {money(choicePreview.remainingUncovered)})</span>}</span>
    </div>
    <div className="payment-overpay-table-wrap">
     <table className="table payment-overpay-table"><thead><tr><th>Thứ tự</th><th></th><th>Bill</th><th>Ngày xuất hàng</th><th>Còn nợ</th><th>Sẽ nhận</th></tr></thead><tbody>
      {(overpayDialog.details?.eligible_bills||[]).map(b=>{
       const order=overpayDialog.chosenIds.indexOf(b.id);
       const preview=choicePreview.rows.find(r=>r.id===b.id);
       return <tr key={b.id} style={{cursor:'pointer',background:order>=0?'#f0fdf4':undefined}} onClick={()=>toggleChosenBill(b.id)}>
        <td>{order>=0?order+1:''}</td>
        <td><input type="checkbox" checked={order>=0} onChange={()=>toggleChosenBill(b.id)} onClick={e=>e.stopPropagation()}/></td>
        <td>{b.order_code}</td>
        <td>{billDateLabel(b)}</td>
        <td><b>{money(b.remaining)}</b></td>
        <td>{preview?money(preview.preview_applied):''}</td>
       </tr>;
      })}
     </tbody></table>
    </div>
    <div className="actions" style={{justifyContent:'space-between',marginTop:12}}>
     <button className="btn secondary" onClick={closeOverpayDialog}>Hủy</button>
     <button className="btn" disabled={choicePreview.remainingUncovered>0.01||!overpayDialog.chosenIds.length} onClick={confirmChoice}>Xác nhận phân bổ</button>
    </div>
   </div>
  </div>}
 </SafePage>;
}
