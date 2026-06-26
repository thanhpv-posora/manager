import React,{useEffect,useMemo,useState}from'react';
import {Pencil,Save,Trash2,XCircle}from'lucide-react';
import api from'../api/api';
import SafePage from'../components/SafePage';
import MoneyInput from'../components/MoneyInput';
import EnterpriseAutocomplete from'../components/common/EnterpriseAutocomplete';
import {formatLunarDate,solarToLunar}from'../utils/lunarDate';

const money=n=>Number(n||0).toLocaleString('en-US')+'đ';

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
