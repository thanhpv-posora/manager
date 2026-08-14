import React,{useEffect,useMemo,useState}from'react';
import {Pencil,Save,Trash2,XCircle}from'lucide-react';
import api from'../api/api';
import SafePage from'../components/SafePage';
import MoneyInput from'../components/MoneyInput';
import EnterpriseAutocomplete from'../components/common/EnterpriseAutocomplete';
import {formatLunarDate,solarToLunar}from'../utils/lunarDate';

const money=n=>Number(n||0).toLocaleString('en-US')+'đ';
const ymd=v=>{const raw=String(v||'').slice(0,10);const m=raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);return m?`${m[3]}/${m[2]}/${m[1]}`:raw};

function parseLunarText(text){
 const m=String(text||'').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
 if(!m)return null;
 return {day:Number(m[1]),month:Number(m[2]),year:Number(m[3])};
}
function solarDateParts(dateText){
 const m=String(dateText||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
 if(m)return {day:Number(m[3]),month:Number(m[2]),year:Number(m[1])};
 const d=dateText?new Date(dateText):new Date();
 return {day:d.getDate(),month:d.getMonth()+1,year:d.getFullYear()};
}
function toIsoDate(d){
 const y=d.getFullYear();
 const m=String(d.getMonth()+1).padStart(2,'0');
 const day=String(d.getDate()).padStart(2,'0');
 return `${y}-${m}-${day}`;
}
function lunarToSolarDate(lunar){
 if(!lunar)return '';
 const start=new Date(lunar.year-1,0,1);
 const end=new Date(lunar.year+1,11,31);
 for(let d=new Date(start);d<=end;d.setDate(d.getDate()+1)){
  const iso=toIsoDate(d);
  const l=solarToLunar(iso);
  if(l.day===lunar.day&&l.month===lunar.month&&l.year===lunar.year)return iso;
 }
 return '';
}

export default function Installments(){
 const today=new Date().toISOString().slice(0,10);
 const[customers,setCustomers]=useState([]);
 const[rows,setRows]=useState([]);
 const[configDate,setConfigDate]=useState(today);
 const[calendarType,setCalendarType]=useState('SOLAR');
 const[lunarDateText,setLunarDateText]=useState(formatLunarDate(today).replace(/^ÂL\s*/,''));
 const[customerId,setCustomerId]=useState('');
 const[statsCustomerId,setStatsCustomerId]=useState('');
 const[amount,setAmount]=useState('');
 const[active,setActive]=useState(true);
 const[editing,setEditing]=useState({});
 const[loading,setLoading]=useState(true);
 const[error,setError]=useState('');
 const[msg,setMsg]=useState('');
 const[stats,setStats]=useState({day_total:0,month_total:0,year_total:0});
 const[statsFrom,setStatsFrom]=useState(today);
 const[statsTo,setStatsTo]=useState(today);
 const[statsCalendarType,setStatsCalendarType]=useState('SOLAR');
 const[statsFromLunar,setStatsFromLunar]=useState(formatLunarDate(today).replace(/^ÂL\s*/,''));
 const[statsToLunar,setStatsToLunar]=useState(formatLunarDate(today).replace(/^ÂL\s*/,''));
 const[rangeStats,setRangeStats]=useState({total:0,rows:[]});
 const[showDateDialog,setShowDateDialog]=useState(false);
 const[draftSolarDate,setDraftSolarDate]=useState(today);
 const[draftLunarDateText,setDraftLunarDateText]=useState('');

 // feat(debt): customer debt MANAGEMENT summary — final confirmed formula:
 // current_total_debt = opening_debt - total_contribution + total_outstanding.
 // total_contribution = SUM(orders.installment_amount) on valid bills (counted
 // at bill creation, whether or not paid yet — NOT payments.installment_amount).
 // total_outstanding = SUM(MAX(0,total_amount-paid_amount)) on the same bills.
 // A reporting view on top of the existing Góp bill feature, bound to the
 // same statsCustomerId selection above. Never writes to debt_transactions/
 // orders/payments.
 const currentUser=useMemo(()=>{try{return JSON.parse(localStorage.getItem('user')||'{}')}catch(e){return {}}},[]);
 const isAdmin=currentUser?.role==='ADMIN';
 const[openingDebt,setOpeningDebt]=useState(null);
 const[mgmtSummary,setMgmtSummary]=useState(null);
 const[mgmtError,setMgmtError]=useState('');
 const[mgmtAsOfCalendarType,setMgmtAsOfCalendarType]=useState('SOLAR');
 const[mgmtAsOfDate,setMgmtAsOfDate]=useState(today);
 const[mgmtAsOfLunar,setMgmtAsOfLunar]=useState(formatLunarDate(today).replace(/^ÂL\s*/,''));
 const[mgmtDrilldown,setMgmtDrilldown]=useState(''); // '', 'contribution', 'outstanding'
 const[showOpeningDebtModal,setShowOpeningDebtModal]=useState(false);
 const[openingDebtForm,setOpeningDebtForm]=useState({amount:'',calendar_type:'SOLAR',date:today,lunar_date_text:'',note:''});

 const selectedPeriod=useMemo(()=>{
  if(calendarType==='LUNAR'){
   const parsed=parseLunarText(lunarDateText);
   const l=parsed||solarToLunar(configDate||today);
   return {day:l.day,month:l.month,year:l.year,calendar_type:'LUNAR',label:`${String(l.day).padStart(2,'0')}/${String(l.month).padStart(2,'0')}/${l.year} (âm lịch)`,periodLabel:`Tháng ${String(l.month).padStart(2,'0')}/${l.year} âm lịch`,shortLabel:`${String(l.month).padStart(2,'0')}/${l.year} ÂL`};
  }
  const d=solarDateParts(configDate||today);
  return {day:d.day,month:d.month,year:d.year,calendar_type:'SOLAR',label:`${String(d.day).padStart(2,'0')}/${String(d.month).padStart(2,'0')}/${d.year} (dương lịch)`,periodLabel:`Tháng ${String(d.month).padStart(2,'0')}/${d.year} dương lịch`,shortLabel:`${String(d.month).padStart(2,'0')}/${d.year} DL`};
 },[calendarType,lunarDateText,configDate,today]);

 const selectedStatsCustomer=useMemo(()=>customers.find(c=>String(c.id)===String(statsCustomerId))||null,[customers,statsCustomerId]);
 const statsCalendarLabel=statsCalendarType==='LUNAR'?'Âm lịch':'Dương lịch';
 const statsFromLabel=statsCalendarType==='LUNAR'?'Từ ngày âm lịch':'Từ ngày dương lịch';
 const statsToLabel=statsCalendarType==='LUNAR'?'Đến ngày âm lịch':'Đến ngày dương lịch';
 const statsFromValue=statsCalendarType==='LUNAR'?statsFromLunar:statsFrom;
 const statsToValue=statsCalendarType==='LUNAR'?statsToLunar:statsTo;

 // Auto-set stats calendar type from selected stats customer
 useEffect(()=>{
  if(!statsCustomerId){setStatsCalendarType('SOLAR');return;}
  const c=customers.find(x=>String(x.id)===String(statsCustomerId));
  const ct=String(c?.billing_calendar_type||'SOLAR').toUpperCase()==='LUNAR'?'LUNAR':'SOLAR';
  setStatsCalendarType(ct);
  if(ct==='LUNAR'){
   setStatsFromLunar(formatLunarDate(statsFrom||today).replace(/^ÂL\s*/,''));
   setStatsToLunar(formatLunarDate(statsTo||today).replace(/^ÂL\s*/,''));
  }
 },[statsCustomerId,customers]);

 // feat(debt): opening-debt management summary — bound to statsCustomerId
 // (the same customer picker as the "Thống kê tổng tiền góp bill" card
 // above). Also default the as-of calendar to the customer's own billing
 // calendar, same convention as the rest of this page.
 useEffect(()=>{
  if(!statsCustomerId){setMgmtAsOfCalendarType('SOLAR');return;}
  const c=customers.find(x=>String(x.id)===String(statsCustomerId));
  const ct=String(c?.billing_calendar_type||'SOLAR').toUpperCase()==='LUNAR'?'LUNAR':'SOLAR';
  setMgmtAsOfCalendarType(ct);
  if(ct==='LUNAR')setMgmtAsOfLunar(formatLunarDate(mgmtAsOfDate||today).replace(/^ÂL\s*/,''));
 },[statsCustomerId,customers]);

 const loadOpeningDebt=async id=>{
  if(!id){setOpeningDebt(null);return}
  try{setOpeningDebt((await api.get('/installments/opening-debt/'+id)).data)}catch(e){/* view-only failure, non-blocking */}
 };
 const loadMgmtSummary=async(id=statsCustomerId,ct=mgmtAsOfCalendarType,d=mgmtAsOfDate,dl=mgmtAsOfLunar)=>{
  if(!id){setMgmtSummary(null);return}
  try{
   setMgmtError('');
   const params=ct==='LUNAR'?{as_of_calendar_type:'LUNAR',as_of_lunar_date_text:dl}:{as_of_calendar_type:'SOLAR',as_of_date:d};
   setMgmtSummary((await api.get('/installments/opening-debt/'+id+'/summary',{params})).data);
  }catch(e){setMgmtError(e.response?.data?.message||e.message);setMgmtSummary(null)}
 };
 useEffect(()=>{
  if(!statsCustomerId)return;
  setMgmtDrilldown('');
  loadOpeningDebt(statsCustomerId);
  loadMgmtSummary(statsCustomerId);
 },[statsCustomerId]);

 const changeMgmtAsOfDate=v=>{setMgmtAsOfDate(v);if(mgmtAsOfCalendarType==='LUNAR')setMgmtAsOfLunar(formatLunarDate(v||today).replace(/^ÂL\s*/,''));};
 const changeMgmtAsOfLunar=v=>{setMgmtAsOfLunar(v);const solar=lunarToSolarDate(parseLunarText(v));if(solar)setMgmtAsOfDate(solar);};
 const runMgmtSummary=()=>loadMgmtSummary(statsCustomerId,mgmtAsOfCalendarType,mgmtAsOfDate,mgmtAsOfLunar);

 const openOpeningDebtModal=()=>{
  setOpeningDebtForm(openingDebt
   ?{amount:Number(openingDebt.opening_debt_amount||0),calendar_type:'SOLAR',date:String(openingDebt.effective_date||today).slice(0,10),lunar_date_text:openingDebt.lunar_date_text||'',note:openingDebt.note||''}
   :{amount:'',calendar_type:'SOLAR',date:today,lunar_date_text:'',note:''});
  setShowOpeningDebtModal(true);
 };
 const saveOpeningDebt=async()=>{
  if(!statsCustomerId)return alert('Chọn khách hàng trước');
  if(Number(openingDebtForm.amount||0)<0)return alert('Nợ tổng ban đầu không được âm');
  const payload=openingDebtForm.calendar_type==='LUNAR'
   ?{opening_debt_amount:Number(openingDebtForm.amount||0),effective_calendar_type:'LUNAR',effective_lunar_date_text:openingDebtForm.lunar_date_text,note:openingDebtForm.note}
   :{opening_debt_amount:Number(openingDebtForm.amount||0),effective_calendar_type:'SOLAR',effective_date:openingDebtForm.date,note:openingDebtForm.note};
  await api.put('/installments/opening-debt/'+statsCustomerId,payload);
  setShowOpeningDebtModal(false);
  await loadOpeningDebt(statsCustomerId);
  await runMgmtSummary();
 };

 // Auto-derive calendar type from selected customer's billing_calendar_type
 // User does not manually choose calendar type — it follows the customer setting.
 useEffect(()=>{
  if(!customerId||!customers.length)return;
  const c=customers.find(x=>String(x.id)===String(customerId));
  if(!c)return;
  const ct=String(c.billing_calendar_type||'SOLAR').toUpperCase()==='LUNAR'?'LUNAR':'SOLAR';
  setCalendarType(ct);
  if(ct==='LUNAR')setLunarDateText(formatLunarDate(configDate||today).replace(/^ÂL\s*/,''));
 },[customerId,customers]);

 const changeStatsFrom=v=>{
  setStatsFrom(v);
  if(statsCalendarType==='LUNAR')setStatsFromLunar(formatLunarDate(v||today).replace(/^ÂL\s*/,''));
 };
 const changeStatsTo=v=>{
  setStatsTo(v);
  if(statsCalendarType==='LUNAR')setStatsToLunar(formatLunarDate(v||today).replace(/^ÂL\s*/,''));
 };
 const changeStatsFromLunar=v=>{
  setStatsFromLunar(v);
  const solar=lunarToSolarDate(parseLunarText(v));
  if(solar)setStatsFrom(solar);
 };
 const changeStatsToLunar=v=>{
  setStatsToLunar(v);
  const solar=lunarToSolarDate(parseLunarText(v));
  if(solar)setStatsTo(solar);
 };

 const load=async(period=selectedPeriod,ct=calendarType)=>{
  try{
   setLoading(true);
   const [c,r,st]=await Promise.all([
    api.get('/customers'),
    api.get('/installments/monthly'),
    api.get('/installments/monthly/stats',{params:{date:statsFrom||configDate,calendar_type:statsCalendarType,lunar_date_text:statsCalendarType==='LUNAR'?statsFromLunar:'',customer_id:statsCustomerId||undefined}})
   ]);
   // partner_type is a bitmask: 1=supplier 2=customer 3=both
   const isCustomerPartner=x=>(Number(x.partner_type||2)&2)===2;
   const cs=(c.data||[]).filter(isCustomerPartner);
   setCustomers(cs);
   setRows(r.data||[]);
   setStats(st.data||{day_total:0,month_total:0,year_total:0});
   setEditing({});
  }catch(e){setError(e.response?.data?.message||e.message)}
  finally{setLoading(false)}
 };
 useEffect(()=>{load(selectedPeriod,calendarType)},[selectedPeriod.day,selectedPeriod.month,selectedPeriod.year,calendarType,configDate,lunarDateText]);

 const runRangeStats=async()=>{
  try{
   const params={from_date:statsFrom,to_date:statsTo,calendar_type:statsCalendarType,from_lunar_date_text:statsCalendarType==='LUNAR'?statsFromLunar:'',to_lunar_date_text:statsCalendarType==='LUNAR'?statsToLunar:'',customer_id:statsCustomerId||undefined};
   const [r,st]=await Promise.all([
    api.get('/installments/monthly/stats-range',{params}),
    api.get('/installments/monthly/stats',{params:{date:statsFrom,calendar_type:statsCalendarType,lunar_date_text:statsCalendarType==='LUNAR'?statsFromLunar:'',customer_id:statsCustomerId||undefined}})
   ]);
   setRangeStats(r.data||{total:0,rows:[]});
   setStats(st.data||{day_total:0,month_total:0,year_total:0});
  }catch(e){
   alert(e.response?.data?.message||e.message||'Không thống kê được');
  }
 };

 const printRangeStats=()=>{
  const total=Number(rangeStats.total||0);
  const rowsHtml=(rangeStats.rows||[]).map(x=>`<tr>
    <td>${String(x.payment_date||'')}</td>
    <td class="right">${x.payment_count||0}</td>
    <td class="right"><b>${money(x.installment_total)}</b></td>
  </tr>`).join('');
  const html=`<!doctype html><html><head><meta charset="utf-8"><title>Thống kê góp bill</title><style>
body{font-family:Arial;margin:24px;color:#111}
table{width:100%;border-collapse:collapse;margin-top:12px}
td,th{border:1px solid #ddd;padding:8px}
th{background:#1A73E8;color:white}
.right{text-align:right}
.total{text-align:right;font-size:22px;font-weight:900;margin-top:14px}
.meta{margin:6px 0;color:#555}
@media print{button{display:none}}
</style></head><body>
<button type="button" onclick="window.print()">In phiếu</button>
<h2>Thống kê tổng tiền góp bill</h2>
<p class="meta">Khách hàng: <b>${selectedStatsCustomer?.name||'Tất cả khách hàng'}</b></p>
<p class="meta">Loại lịch: <b>${statsCalendarLabel}</b></p>
<p class="meta">Từ ngày <b>${statsCalendarType==='LUNAR'?statsFromLunar:statsFrom}</b> đến <b>${statsCalendarType==='LUNAR'?statsToLunar:statsTo}</b></p>
<table>
  <thead><tr><th>Ngày</th><th>Số phiếu</th><th>Tổng góp bill</th></tr></thead>
  <tbody>${rowsHtml||`<tr><td colspan="3" class="right">Không có dữ liệu</td></tr>`}</tbody>
</table>
<div class="total">TỔNG GÓP BILL: ${money(total)}</div>
</body></html>`;
  const w=window.open('','_blank');
  if(!w)return alert('Trình duyệt đang chặn popup in phiếu');
  w.document.write(html);
  w.document.close();
  w.focus();
 };

 const changeConfigDate=v=>{
  setConfigDate(v);
  if(calendarType==='LUNAR')setLunarDateText(formatLunarDate(v||today).replace(/^ÂL\s*/,''));
 };
 const changeLunarDateText=v=>{
  setLunarDateText(v);
  const parsed=parseLunarText(v);
  const solar=lunarToSolarDate(parsed);
  if(solar)setConfigDate(solar);
 };

 const save=async()=>{
  if(!customerId)return alert('Chọn khách hàng');
  if(Number(amount||0)<=0)return alert('Nhập số tiền góp/ngày');
  await api.post('/installments/monthly/apply',{
   customer_id:customerId,
   config_date:configDate,
   lunar_date_text:calendarType==='LUNAR'?lunarDateText:'',
   day:selectedPeriod.day,
   month:selectedPeriod.month,
   year:selectedPeriod.year,
   calendar_type:calendarType,
   installment_amount:Number(amount||0),
   status:active?'ACTIVE':'INACTIVE'
  });
  setMsg(`Đã lưu góp bill cho ${selectedPeriod.label}`);
  setAmount('');
  setActive(true);
  await load(selectedPeriod,calendarType);
 };

 const startEdit=row=>setEditing(prev=>({...prev,[row.id]:{amount:Number(row.installment_amount||0),active:row.status==='ACTIVE'}}));
 const cancelEdit=id=>setEditing(prev=>{const n={...prev};delete n[id];return n;});
 const saveEdit=async(row)=>{
  const e=editing[row.id]||{};
  await api.put(`/installments/monthly/${row.id}`,{installment_amount:Number(e.amount||0),status:e.active?'ACTIVE':'INACTIVE'});
  await load(selectedPeriod,calendarType);
 };
 const softDelete=async(row)=>{
  if(!await window.appConfirm(`Xóa mềm cấu hình góp bill của ${row.customer_name}?`,{title:'Xóa cấu hình góp bill',confirmText:'Xóa',variant:'danger'}))return;
  await api.delete(`/installments/monthly/${row.id}`);
  await load(selectedPeriod,calendarType);
 };

 return <SafePage loading={loading} error={error}>

  {/* Lưu cấu hình góp bill */}
  <div className="card">
   <h3>Lưu cấu hình góp bill</h3>
   {msg&&<div className="toast success" style={{position:'static',marginBottom:12}}>{msg}</div>}
   <div className="form-grid">
    <label className="field-label">
     <span>Khách hàng</span>
     <EnterpriseAutocomplete items={customers} value={customers.find(c=>String(c.id)===String(customerId))||null} onChange={item=>setCustomerId(item?String(item.id):'')} placeholder="Tìm khách hàng..." displayField="name" secondaryFields={['customer_code','phone']} searchFields={['name','customer_code','phone','address']} filter={item=>(Number(item.partner_type||2)&2)===2} emptyText="Không tìm thấy khách hàng" getItemKey={item=>item.id}/>
    </label>
    <label className="field-label">
     <span>Ngày góp bill</span>
     <button type="button" className="installment-date-btn" onClick={()=>{setDraftSolarDate(configDate);setDraftLunarDateText(lunarDateText);setShowDateDialog(true);}}>
      {selectedPeriod.label}
     </button>
    </label>
    <label className="field-label">
     <span>Số tiền góp/ngày</span>
     <MoneyInput placeholder="3,000,000" value={amount} onChange={setAmount}/>
    </label>
    <label className="check-line" style={{alignSelf:'end'}}>
     <input type="checkbox" checked={active} onChange={e=>setActive(e.target.checked)}/>
     <span>Active</span>
    </label>
    <div style={{alignSelf:'end'}}>
     <button type="button" className="btn" onClick={save}>Lưu lại</button>
    </div>
   </div>
  </div>

  {/* Date dialog — calendar type driven by customer.billing_calendar_type */}
  {showDateDialog&&<div className="installment-date-overlay" onClick={()=>setShowDateDialog(false)}>
   <div className="installment-date-dialog" onClick={e=>e.stopPropagation()}>
    <div className="installment-date-dialog-head">
     <b>{calendarType==='LUNAR'?'Chọn ngày âm lịch':'Chọn ngày dương lịch'}</b>
     <span className="muted" style={{fontSize:13,fontWeight:400}}>{customerId?'Theo lịch của khách hàng đã chọn':'Mặc định dương lịch'}</span>
    </div>
    <div className="installment-date-dialog-body">
     {calendarType==='SOLAR'
      ?<label className="field-label"><span>Ngày dương lịch</span><input className="input" type="date" value={draftSolarDate} onChange={e=>setDraftSolarDate(e.target.value)} autoFocus/></label>
      :<label className="field-label"><span>Ngày âm lịch</span><input className="input" value={draftLunarDateText} onChange={e=>setDraftLunarDateText(e.target.value)} placeholder="VD: 07/05/2026" autoFocus/></label>
     }
     <div className="installment-date-dialog-preview">
      <span>Ngày đang chọn:</span><b>{(()=>{
       if(calendarType==='SOLAR'){const d=solarDateParts(draftSolarDate||today);return `${String(d.day).padStart(2,'0')}/${String(d.month).padStart(2,'0')}/${d.year} (dương lịch)`;}
       const p=parseLunarText(draftLunarDateText);const l=p||solarToLunar(draftSolarDate||today);return `${String(l.day).padStart(2,'0')}/${String(l.month).padStart(2,'0')}/${l.year} (âm lịch)`;
      })()}</b>
     </div>
    </div>
    <div className="installment-date-dialog-actions">
     <button className="btn" onClick={()=>{if(calendarType==='SOLAR'){changeConfigDate(draftSolarDate);}else{changeLunarDateText(draftLunarDateText);}setShowDateDialog(false);}}>Xác nhận</button>
     <button className="btn secondary" onClick={()=>setShowDateDialog(false)}>Đóng</button>
    </div>
   </div>
  </div>}

  {/* Tổng quan quản lý công nợ — Nợ tổng ban đầu / Đã góp / Nợ mới / Còn nợ */}
  <div className="card">
   <h3>Tổng quan công nợ khách hàng</h3>
   <p className="muted">Nợ tổng ban đầu do ADMIN xác nhận thủ công. Tổng tiền góp nợ là số tiền góp nợ/ngày đã gắn vào bill hợp lệ (tính ngay khi tạo bill, kể cả bill chưa thu đủ). Tổng bill còn nợ là số tiền còn phải thu trên các bill đó (đã gồm cả phần góp nợ/ngày của bill).</p>
   <div className="form-grid" style={{gridTemplateColumns:'1.3fr 1fr 1fr auto'}}>
    <label className="field-label"><span>Khách hàng</span>
     <EnterpriseAutocomplete items={customers} value={customers.find(c=>String(c.id)===String(statsCustomerId))||null} onChange={item=>setStatsCustomerId(item?String(item.id):'')} placeholder="Tìm khách hàng..." displayField="name" secondaryFields={['customer_code','phone']} searchFields={['name','customer_code','phone','address']} filter={item=>(Number(item.partner_type||2)&2)===2} emptyText="Không tìm thấy khách hàng" getItemKey={item=>item.id}/>
    </label>
    <label className="field-label"><span>Loại lịch đến thời điểm</span>
     <select className="select" value={mgmtAsOfCalendarType} onChange={e=>setMgmtAsOfCalendarType(e.target.value)}>
      <option value="SOLAR">Dương lịch</option>
      <option value="LUNAR">Âm lịch</option>
     </select>
    </label>
    {mgmtAsOfCalendarType==='LUNAR'
     ?<label className="field-label"><span>Đến ngày âm lịch</span><input className="input" value={mgmtAsOfLunar} onChange={e=>changeMgmtAsOfLunar(e.target.value)} placeholder="VD: 31/07/2026"/></label>
     :<label className="field-label"><span>Đến ngày</span><input className="input" type="date" value={mgmtAsOfDate} onChange={e=>changeMgmtAsOfDate(e.target.value)}/></label>}
    <div style={{display:'flex',gap:8,alignSelf:'end'}}>
     <button type="button" className="btn" onClick={runMgmtSummary} disabled={!statsCustomerId}>Xem</button>
     {isAdmin&&<button type="button" className="btn secondary" onClick={openOpeningDebtModal} disabled={!statsCustomerId}>Cài đặt nợ gốc</button>}
    </div>
   </div>
   {!statsCustomerId&&<p className="muted">Chọn khách hàng để xem tổng quan công nợ.</p>}
   {mgmtError&&<div className="ai-alert danger">{mgmtError}</div>}
   {mgmtSummary&&<>
    {!mgmtSummary.opening_debt&&<div className="ai-alert warn" style={{marginTop:10}}>Khách hàng này chưa được cấu hình Nợ tổng ban đầu. Đang tính với nợ gốc = 0.{isAdmin?' Bấm "Cài đặt nợ gốc" để nhập.':' Liên hệ ADMIN để nhập nợ gốc ban đầu.'}</div>}
    {mgmtSummary.opening_debt&&!mgmtSummary.opening_applicable&&<div className="ai-alert warn" style={{marginTop:10}}>Thời điểm đang chọn trước ngày hiệu lực nợ gốc (<b>{ymd(mgmtSummary.opening_debt.effective_date)}</b>). Nợ gốc ban đầu chưa áp dụng, đang tính với nợ gốc = 0.</div>}
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(200px,1fr))',gap:12,marginTop:14}}>
     <div className="payment-total-box" style={{marginTop:0}}><div>Nợ tổng ban đầu</div><b>{money(mgmtSummary.opening_debt_amount)}</b></div>
     <div className="payment-total-box" style={{marginTop:0,cursor:'pointer'}} onClick={()=>setMgmtDrilldown(d=>d==='contribution'?'':'contribution')}><div>(-) Tổng tiền góp nợ</div><b>-{money(mgmtSummary.total_contribution)}</b><span style={{fontSize:12,fontWeight:600,color:'#1A73E8'}}>{mgmtDrilldown==='contribution'?'Ẩn chi tiết ▲':'Xem chi tiết ▼'}</span></div>
     <div className="payment-total-box" style={{marginTop:0,cursor:'pointer'}} onClick={()=>setMgmtDrilldown(d=>d==='outstanding'?'':'outstanding')}><div>(+) Tổng bill còn nợ</div><b>+{money(mgmtSummary.total_outstanding)}</b><span style={{fontSize:12,fontWeight:600,color:'#1A73E8'}}>{mgmtDrilldown==='outstanding'?'Ẩn chi tiết ▲':'Xem chi tiết ▼'}</span></div>
     <div className="payment-total-box" style={{marginTop:0,background:'#fff7ed',border:'1px solid #fdba74'}}><div>TỔNG NỢ HIỆN TẠI</div><b style={{fontSize:26}}>{money(mgmtSummary.current_total_debt)}</b></div>
    </div>
    <div className="muted" style={{marginTop:10}}>
     Đến thời điểm <b>{mgmtSummary.as_of_calendar_type==='LUNAR'?`${mgmtSummary.as_of_lunar_date_text} ÂL (${ymd(mgmtSummary.as_of_date)} DL)`:ymd(mgmtSummary.as_of_date)}</b>
     {mgmtSummary.opening_debt?.effective_date&&<> · Hiệu lực từ <b>{ymd(mgmtSummary.opening_debt.effective_date)}</b></>}
    </div>
    {!mgmtSummary.reconciliation?.matches&&<div className="ai-alert danger" style={{marginTop:10}}>
     Cảnh báo: công thức đối chiếu (Nợ gốc + Tổng hàng hoá − Tổng đã thu = <b>{money(mgmtSummary.reconciliation?.formula_result)}</b>) không khớp với TỔNG NỢ HIỆN TẠI (<b>{money(mgmtSummary.current_total_debt)}</b>), lệch <b>{money(mgmtSummary.reconciliation?.difference)}</b>. Vui lòng báo kỹ thuật kiểm tra trước khi dùng số liệu này.
    </div>}
    {Math.abs(mgmtSummary.ledger_difference||0)>=1&&<div className="ai-alert warn" style={{marginTop:10}}>
     Số liệu quản lý này khác với công nợ theo sổ cái hệ thống (<b>{money(mgmtSummary.ledger_current_debt)}</b>) một khoản <b>{money(mgmtSummary.ledger_difference)}</b>.
     Đây là chênh lệch do sổ cái không có khái niệm "nợ gốc ban đầu"; số liệu kế toán ở nơi khác trong hệ thống không bị thay đổi.
    </div>}
    {mgmtDrilldown==='contribution'&&<div style={{marginTop:14}}>
     <h4 style={{margin:'0 0 8px'}}>Chi tiết Tổng tiền góp nợ ({mgmtSummary.contribution_bills.length} bill)</h4>
     <div className="installment-table-wrap">
      <table className="table"><thead><tr><th>Ngày bill</th><th>Mã bill</th><th>Tiền hàng</th><th>Góp/ngày</th><th>Tổng bill</th><th>Trạng thái</th></tr></thead>
       <tbody>{mgmtSummary.contribution_bills.map(b=><tr key={b.order_id}><td>{ymd(b.order_date)}</td><td>{b.order_code}</td><td>{money(b.goods_amount)}</td><td>{money(b.contribution_amount)}</td><td><b>{money(b.bill_total)}</b></td><td>{b.payment_status}</td></tr>)}</tbody>
      </table>
     </div>
    </div>}
    {mgmtDrilldown==='outstanding'&&<div style={{marginTop:14}}>
     <h4 style={{margin:'0 0 8px'}}>Chi tiết Tổng bill còn nợ ({mgmtSummary.outstanding_bills.length} bill)</h4>
     <div className="installment-table-wrap">
      <table className="table"><thead><tr><th>Ngày bill</th><th>Mã bill</th><th>Tiền hàng</th><th>Góp/ngày</th><th>Tổng bill</th><th>Đã trả</th><th>Còn nợ</th></tr></thead>
       <tbody>{mgmtSummary.outstanding_bills.length?mgmtSummary.outstanding_bills.map(b=><tr key={b.order_id}><td>{ymd(b.order_date)}</td><td>{b.order_code}</td><td>{money(b.goods_amount)}</td><td>{money(b.contribution_amount)}</td><td>{money(b.bill_total)}</td><td>{money(b.paid_amount)}</td><td><b>{money(b.remaining_amount)}</b></td></tr>):<tr><td colSpan="7" className="muted" style={{textAlign:'center'}}>Không có bill còn nợ trong khoảng đang chọn</td></tr>}</tbody>
      </table>
     </div>
    </div>}
   </>}
  </div>

  {/* Cài đặt nợ gốc ban đầu — ADMIN only */}
  {showOpeningDebtModal&&<div className="installment-date-overlay" onClick={()=>setShowOpeningDebtModal(false)}>
   <div className="installment-date-dialog" onClick={e=>e.stopPropagation()}>
    <div className="installment-date-dialog-head">
     <b>Cài đặt nợ tổng ban đầu</b>
     <span className="muted" style={{fontSize:13,fontWeight:400}}>{selectedStatsCustomer?.name||''}</span>
    </div>
    <div className="installment-date-dialog-body">
     <label className="field-label"><span>Nợ tổng ban đầu</span><MoneyInput placeholder="1,000,000,000" value={openingDebtForm.amount} onChange={v=>setOpeningDebtForm(f=>({...f,amount:v}))}/></label>
     <label className="field-label"><span>Loại lịch ngày hiệu lực</span>
      <select className="select" value={openingDebtForm.calendar_type} onChange={e=>setOpeningDebtForm(f=>({...f,calendar_type:e.target.value}))}>
       <option value="SOLAR">Dương lịch</option>
       <option value="LUNAR">Âm lịch</option>
      </select>
     </label>
     {openingDebtForm.calendar_type==='LUNAR'
      ?<label className="field-label"><span>Ngày hiệu lực (âm lịch)</span><input className="input" value={openingDebtForm.lunar_date_text} onChange={e=>setOpeningDebtForm(f=>({...f,lunar_date_text:e.target.value}))} placeholder="VD: 30/11/2023"/></label>
      :<label className="field-label"><span>Ngày hiệu lực</span><input className="input" type="date" value={openingDebtForm.date} onChange={e=>setOpeningDebtForm(f=>({...f,date:e.target.value}))}/></label>}
     <label className="field-label"><span>Ghi chú</span><input className="input" value={openingDebtForm.note} onChange={e=>setOpeningDebtForm(f=>({...f,note:e.target.value}))} placeholder="VD: Chốt sổ công nợ cuối 2023"/></label>
     {openingDebt&&<p className="muted">Giá trị hiện tại: <b>{money(openingDebt.opening_debt_amount)}</b>, hiệu lực từ {ymd(openingDebt.effective_date)}. Lưu lại sẽ ghi đè và lưu vết giá trị cũ vào nhật ký.</p>}
    </div>
    <div className="installment-date-dialog-actions">
     <button className="btn" onClick={saveOpeningDebt}>Lưu</button>
     <button className="btn secondary" onClick={()=>setShowOpeningDebtModal(false)}>Đóng</button>
    </div>
   </div>
  </div>}

  {/* Thống kê */}
  <div className="card">
   <h3>Thống kê tổng tiền góp bill thực tế</h3>
   <p className="muted">Chọn khách hàng trước. Khoảng thời gian sẽ tự chạy theo loại lịch tính bill của khách; không hiển thị lẫn lộn âm/dương.</p>
   <div className="form-grid" style={{gridTemplateColumns:'1.3fr 1fr 1fr auto auto',alignItems:'end'}}>
    <label className="field-label"><span>Khách hàng thống kê</span>
     <EnterpriseAutocomplete items={customers} value={customers.find(c=>String(c.id)===String(statsCustomerId))||null} onChange={item=>setStatsCustomerId(item?String(item.id):'')} placeholder="Tất cả khách hàng..." displayField="name" secondaryFields={['customer_code','phone']} searchFields={['name','customer_code','phone','address']} filter={item=>(Number(item.partner_type||2)&2)===2} emptyText="Không tìm thấy khách hàng" getItemKey={item=>item.id}/>
    </label>
    {statsCalendarType==='LUNAR'?<>
     <label className="field-label"><span>{statsFromLabel}</span><input className="input" value={statsFromLunar} onChange={e=>changeStatsFromLunar(e.target.value)} placeholder="VD: 01/03/2026"/></label>
     <label className="field-label"><span>{statsToLabel}</span><input className="input" value={statsToLunar} onChange={e=>changeStatsToLunar(e.target.value)} placeholder="VD: 30/03/2026"/></label>
    </>:<>
     <label className="field-label"><span>{statsFromLabel}</span><input className="input" type="date" value={statsFrom} onChange={e=>changeStatsFrom(e.target.value)}/></label>
     <label className="field-label"><span>{statsToLabel}</span><input className="input" type="date" value={statsTo} onChange={e=>changeStatsTo(e.target.value)}/></label>
    </>}
    <button type="button" className="btn" onClick={runRangeStats}>Thống kê</button>
    <button type="button" className="btn secondary" onClick={printRangeStats}>In phiếu</button>
   </div>
   <div className="muted" style={{marginTop:8}}>Loại lịch thống kê: <b>{statsCalendarLabel}</b>{selectedStatsCustomer?` theo khách ${selectedStatsCustomer.name}`:' (tất cả khách hàng)'}. Khoảng đang chọn: <b>{statsFromValue}</b> đến <b>{statsToValue}</b>.</div>
   {(rangeStats.rows||[]).length>0&&<>
    <table className="table" style={{marginTop:12}}>
     <thead><tr><th>Ngày</th><th>Số phiếu</th><th>Tổng góp bill</th></tr></thead>
     <tbody>{rangeStats.rows.map((r,i)=><tr key={i}><td>{String(r.payment_date||'')}</td><td>{r.payment_count}</td><td><b>{money(r.installment_total)}</b></td></tr>)}</tbody>
     <tfoot><tr><td colSpan="2" style={{textAlign:'right'}}><b>TỔNG GÓP BILL</b></td><td><b>{money(rangeStats.total)}</b></td></tr></tfoot>
    </table>
   </>}
  </div>

  {/* Danh sách cấu hình */}
  <div className="card">
   <h3>Danh sách cấu hình tất cả các ngày áp dụng</h3>
   <div className="installment-table-wrap">
    <table className="table installment-table">
     <thead><tr><th>Khách hàng</th><th>Ngày áp dụng</th><th>Loại lịch</th><th>Số tiền góp/ngày</th><th>Trạng thái</th><th>Thao tác</th></tr></thead>
     <tbody>{rows.map(r=>{
      const e=editing[r.id];
      const isEditing=!!e;
      const day=String(r.installment_day||1).padStart(2,'0');
      const month=String(r.installment_month).padStart(2,'0');
      return <tr key={r.id} className={r.status==='INACTIVE'?'muted-row':''}>
       <td><b>{r.customer_name}</b><br/><span className="muted">{r.phone||''}</span></td>
       <td>{day}/{month}/{r.installment_year}</td>
       <td>{r.calendar_type==='LUNAR'?'Âm lịch':'Dương lịch'}</td>
       <td>{isEditing?<MoneyInput value={e.amount} onChange={v=>setEditing(prev=>({...prev,[r.id]:{...prev[r.id],amount:v}}))}/>:<b>{money(r.installment_amount)}</b>}</td>
       <td>{isEditing?<label className="check-line"><input type="checkbox" checked={!!e.active} onChange={ev=>setEditing(prev=>({...prev,[r.id]:{...prev[r.id],active:ev.target.checked}}))}/><span>Active</span></label>:<span className={r.status==='ACTIVE'?'status active':'status inactive'}>{r.status==='ACTIVE'?'Active':'Inactive'}</span>}</td>
       <td><div className="row-actions">
        {isEditing?<>
         <button type="button" className="btn" title="Lưu" style={{padding:0,width:32,height:32,display:'inline-flex',alignItems:'center',justifyContent:'center'}} onClick={()=>saveEdit(r)}><Save size={14}/></button>
         <button type="button" className="btn secondary" title="Hủy" style={{padding:0,width:32,height:32,display:'inline-flex',alignItems:'center',justifyContent:'center'}} onClick={()=>cancelEdit(r.id)}><XCircle size={14}/></button>
        </>:<>
         <button type="button" className="btn secondary" title="Sửa" style={{padding:0,width:32,height:32,display:'inline-flex',alignItems:'center',justifyContent:'center'}} onClick={()=>startEdit(r)}><Pencil size={14}/></button>
         <button type="button" className="btn danger" title="Xóa mềm" style={{padding:0,width:32,height:32,display:'inline-flex',alignItems:'center',justifyContent:'center'}} onClick={()=>softDelete(r)}><Trash2 size={14}/></button>
        </>}
       </div></td>
      </tr>
     })}</tbody>
    </table>
   </div>
  </div>
 </SafePage>
}
