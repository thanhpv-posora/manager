import React,{useEffect,useMemo,useState}from'react';
import api from'../api/api';
import SafePage from'../components/SafePage';
import EnterpriseAutocomplete from'../components/common/EnterpriseAutocomplete';

const money=n=>Number(n||0).toLocaleString('en-US')+'đ';
// Compact "5tr"/"800k" form for the small debt line inside a cell — this
// page's own presentational helper, not a shared util (nowhere else in the
// app needs a triệu-abbreviated money string).
const shortMoney=n=>{
 const v=Number(n||0);
 if(v>=1000000)return `${Math.round(v/100000)/10}tr`;
 if(v>=1000)return `${Math.round(v/1000)}k`;
 return String(Math.round(v));
};
const today=()=>new Date().toISOString().slice(0,10);
const addDays=(d,n)=>{const t=new Date(d+'T00:00:00');t.setDate(t.getDate()+n);return t.toISOString().slice(0,10)};

const STATUS_LABEL={
 NO_BILL:'Không có bill',
 UNSETTLED:'Chưa tính tiền',
 PRICED_WITH_DEBT:'Đã tính - Còn nợ',
 PRICED_PAID:'Đã tính - Hết nợ',
};

// Solar primary/secondary date text for one cell, driven by the customer
// row's own billing_calendar_type — never the same solar header for every
// customer (S1D calendar authority: customers.billing_calendar_type).
function cellDateText(col,calendarType){
 const solarLabel=col.date.slice(8,10)+'/'+col.date.slice(5,7);
 return calendarType==='LUNAR'
  ?{primary:col.lunar_label,secondary:`${solarLabel} DL`}
  :{primary:solarLabel,secondary:`${col.lunar_label} ÂL`};
}

function cellStyle(status,cell){
 if(status==='NO_BILL')return {background:'#f8fafc'};
 if(status==='UNSETTLED')return {background:'#fee2e2'};
 if(status==='PRICED_PAID')return {background:'#dcfce7'};
 // PRICED_WITH_DEBT: proportional green/red split by outstanding/total —
 // a clean linear-gradient rather than a second legend entry.
 const total=Number(cell.total_amount||0);
 const debtRatio=total>0?Math.min(1,Math.max(0,Number(cell.outstanding_amount||0)/total)):1;
 const pct=Math.round(debtRatio*100);
 return {background:`linear-gradient(90deg, #fee2e2 0%, #fee2e2 ${pct}%, #dcfce7 ${pct}%, #dcfce7 100%)`};
}

function cellTooltip(customerName,col,cell){
 return [
  `${customerName} — ${col.date}`,
  `Trạng thái: ${STATUS_LABEL[cell.status]||cell.status}`,
  `Số bill: ${cell.valid_bill_count}`,
  `Tổng tiền: ${money(cell.total_amount)}`,
  `Đã thu: ${money(cell.paid_amount)}`,
  `Còn nợ: ${money(cell.outstanding_amount)}`,
 ].join('\n');
}

export default function CustomerBillingMatrix(){
 const[from,setFrom]=useState(addDays(today(),-13));
 const[to,setTo]=useState(today());
 const[salesFlow,setSalesFlow]=useState('ALL');
 const[customerId,setCustomerId]=useState('');
 const[status,setStatus]=useState('ALL');
 const[customers,setCustomers]=useState([]);
 const[data,setData]=useState(null);
 const[loading,setLoading]=useState(false);
 const[error,setError]=useState('');

 // Plain existing /customers list — same datasource every other filter
 // picker on this page uses (ProductQuantityReport.jsx, PriceMatrix.jsx).
 // No matrix/bill/payment data is ever joined into this call or its shape.
 useEffect(()=>{api.get('/customers').then(r=>setCustomers(r.data||[])).catch(()=>{})},[]);
 const selectedCustomer=customers.find(c=>String(c.id)===String(customerId))||null;

 // One dedicated report call for the whole grid — never one request per
 // customer or per cell. Re-fires only on explicit "Lọc", not per keystroke.
 const load=async()=>{
  setLoading(true);setError('');
  try{
   const params={from,to,sales_flow:salesFlow,status};
   if(customerId)params.customer_id=customerId;
   setData((await api.get('/reports/customer-billing-matrix',{params})).data);
  }catch(e){setError(e.response?.data?.message||e.message)}
  finally{setLoading(false)}
 };
 useEffect(()=>{load()},[]);

 const reset=()=>{
  setFrom(addDays(today(),-13));setTo(today());setSalesFlow('ALL');setCustomerId('');setStatus('ALL');
  setTimeout(load,0);
 };

 const dateColumns=data?.date_columns||[];
 const rows=data?.customers||[];
 const summary=data?.summary||{customers:0,no_bill_days:0,unsettled_days:0,paid_days:0,debt_days:0};

 return <SafePage loading={false} error={error}><div className="grid">
  <div className="card">
   <h3>Theo dõi tính tiền khách hàng</h3>
   <p className="muted">Theo dõi tình trạng tính tiền và công nợ theo ngày</p>
   <div className="actions" style={{alignItems:'flex-start',flexWrap:'wrap'}}>
    <div style={{display:'flex',flexDirection:'column',gap:2}}>
     <span className="muted" style={{fontSize:12}}>Từ ngày</span>
     <input className="input" style={{width:160}} type="date" value={from} onChange={e=>setFrom(e.target.value)}/>
    </div>
    <div style={{display:'flex',flexDirection:'column',gap:2}}>
     <span className="muted" style={{fontSize:12}}>Đến ngày</span>
     <input className="input" style={{width:160}} type="date" value={to} onChange={e=>setTo(e.target.value)}/>
    </div>
    <div style={{display:'flex',flexDirection:'column',gap:2}}>
     <span className="muted" style={{fontSize:12}}>Luồng bán hàng</span>
     <select className="select" style={{width:160}} value={salesFlow} onChange={e=>setSalesFlow(e.target.value)}>
      <option value="ALL">Tất cả</option>
      <option value="CARCASS_POS">Bò xô</option>
      <option value="INVENTORY_SALE">Kho</option>
     </select>
    </div>
    <div style={{display:'flex',flexDirection:'column',gap:2,minWidth:220}}>
     <span className="muted" style={{fontSize:12}}>Khách hàng</span>
     <EnterpriseAutocomplete
      items={customers}
      value={selectedCustomer}
      onChange={item=>setCustomerId(item?String(item.id):'')}
      placeholder="Tất cả khách hàng"
      displayField="name"
      secondaryFields={['customer_code','phone']}
      searchFields={['name','customer_code','phone','address']}
      filter={item=>(Number(item.partner_type||2)&2)===2}
      emptyText="Không tìm thấy khách hàng"
      getItemKey={item=>item.id}
      getTooltip={item=>`ID: ${item.id}\nSĐT: ${item.phone||'—'}`}
     />
    </div>
    <div style={{display:'flex',flexDirection:'column',gap:2}}>
     <span className="muted" style={{fontSize:12}}>Trạng thái</span>
     <select className="select" style={{width:190}} value={status} onChange={e=>setStatus(e.target.value)}>
      <option value="ALL">Tất cả</option>
      <option value="NO_BILL">Không có bill</option>
      <option value="UNSETTLED">Chưa tính tiền</option>
      <option value="PRICED_WITH_DEBT">Đã tính - Còn nợ</option>
      <option value="PRICED_PAID">Đã tính - Hết nợ</option>
     </select>
    </div>
    <button className="btn" onClick={load} style={{marginTop:20}}>Lọc</button>
    <button className="btn secondary" onClick={reset} style={{marginTop:20}}>Đặt lại</button>
   </div>
  </div>

  <div className="card">
   <div className="billing-matrix-legend">
    <span><i className="billing-matrix-swatch" style={{background:'#f8fafc',border:'1px solid #e2e8f0'}}/>Không có bill</span>
    <span><i className="billing-matrix-swatch" style={{background:'#fee2e2'}}/>Chưa tính tiền</span>
    <span><i className="billing-matrix-swatch" style={{background:'#dcfce7'}}/>Đã tính - Hết nợ</span>
    <span><i className="billing-matrix-swatch" style={{background:'linear-gradient(90deg,#fee2e2 0%,#fee2e2 50%,#dcfce7 50%,#dcfce7 100%)'}}/>Đã tính - Còn nợ</span>
   </div>
  </div>

  <div className="billing-matrix-summary">
   <div className="billing-matrix-stat"><span>Khách hàng</span><b>{summary.customers}</b></div>
   <div className="billing-matrix-stat"><span>Không có bill</span><b>{summary.no_bill_days} ngày</b></div>
   <div className="billing-matrix-stat"><span>Chưa tính tiền</span><b>{summary.unsettled_days} ngày</b></div>
   <div className="billing-matrix-stat"><span>Đã tính - Hết nợ</span><b>{summary.paid_days} ngày</b></div>
   <div className="billing-matrix-stat"><span>Đã tính - Còn nợ</span><b>{summary.debt_days} ngày</b></div>
  </div>

  <div className="card">
   {loading&&<p className="notice">Đang tải ma trận...</p>}
   {!loading&&<div className="billing-matrix-wrap">
    <table className="billing-matrix-table">
     <thead>
      <tr>
       <th className="billing-matrix-sticky-col billing-matrix-head-col">Khách hàng</th>
       {dateColumns.map(col=><th key={col.date} className="billing-matrix-date-head">{col.date.slice(8,10)}/{col.date.slice(5,7)}</th>)}
      </tr>
     </thead>
     <tbody>
      {rows.map(row=>
       <tr key={row.customer_id}>
        <td className="billing-matrix-sticky-col billing-matrix-head-col">
         <b>{row.customer_name}</b>
         <div className="muted" style={{fontSize:11}}>Lịch: {row.calendar_type==='LUNAR'?'Âm lịch':'Dương lịch'}</div>
        </td>
        {dateColumns.map(col=>{
         const cell=row.days[col.date];
         const d=cellDateText(col,row.calendar_type);
         return <td key={col.date} className="billing-matrix-cell" style={cellStyle(cell.status,cell)} title={cellTooltip(row.customer_name,col,cell)}>
          <div className="billing-matrix-primary-date">{d.primary}</div>
          <div className="billing-matrix-secondary-date">{d.secondary}</div>
          {cell.status==='UNSETTLED'&&<div className="billing-matrix-tag">Chưa tính</div>}
          {cell.status==='PRICED_WITH_DEBT'&&<div className="billing-matrix-tag">Nợ {shortMoney(cell.outstanding_amount)}</div>}
         </td>;
        })}
       </tr>
      )}
      {!rows.length&&<tr><td colSpan={dateColumns.length+1} className="muted" style={{textAlign:'center',padding:16}}>Không có dữ liệu</td></tr>}
     </tbody>
    </table>
   </div>}
  </div>
 </div></SafePage>;
}
