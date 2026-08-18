import React,{useEffect,useMemo,useState}from'react';
import api from'../api/api';
import SafePage from'../components/SafePage';
import Dialog from'../components/common/Dialog';
import EnterpriseAutocomplete from'../components/common/EnterpriseAutocomplete';
import {formatQty}from'../utils/quantity';
import {formatLunarDate}from'../utils/lunarDate';

const money=n=>Number(n||0).toLocaleString('en-US')+'đ';
const qty=(n,unit)=>`${formatQty(n)} ${unit||''}`.trim();
const pct=n=>`${Number(n||0).toLocaleString('en-US',{minimumFractionDigits:1,maximumFractionDigits:1})}%`;
const today=()=>new Date().toISOString().slice(0,10);
const addDays=(d,n)=>{const t=new Date(d+'T00:00:00');t.setDate(t.getDate()+n);return t.toISOString().slice(0,10)};
const monthStart=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`};
const PAYMENT_LABEL={UNPAID:'Chưa thanh toán',PARTIAL:'Trả một phần',PAID:'Đã thanh toán'};
// Display-only — informational lunar equivalent next to the solar date filter.
// Never feeds the report query: from_date/to_date sent to the backend always
// stay the solar orders.order_date values the user picked.
const lunarOf=solarIso=>{try{return formatLunarDate(solarIso)}catch(e){return ''}};

export default function ProductQuantityReport(){
 const[from,setFrom]=useState(today());
 const[to,setTo]=useState(today());
 const[salesFlow,setSalesFlow]=useState('ALL');
 const[customerId,setCustomerId]=useState('');
 const[customers,setCustomers]=useState([]);
 const[data,setData]=useState(null);
 const[loading,setLoading]=useState(false);
 const[error,setError]=useState('');
 const[sort,setSort]=useState({key:'quantity',dir:'desc'});
 const[drill,setDrill]=useState(null); // {product_id,product_name,unit}
 const[drillData,setDrillData]=useState(null);
 const[drillLoading,setDrillLoading]=useState(false);

 useEffect(()=>{api.get('/customers').then(r=>setCustomers(r.data||[])).catch(()=>{})},[]);
 const selectedCustomer=customers.find(c=>String(c.id)===String(customerId))||null;

 const load=async(f=from,t=to,flow=salesFlow,cust=customerId)=>{
  setLoading(true);setError('');
  try{
   const params={from_date:f,to_date:t,sales_flow:flow};
   if(cust)params.customer_id=cust;
   setData((await api.get('/reports/product-quantity',{params})).data);
  }catch(e){setError(e.response?.data?.message||e.message)}
  finally{setLoading(false)}
 };
 useEffect(()=>{load()},[]);

 const quickRange=(f,t)=>{setFrom(f);setTo(t);load(f,t)};
 const quickToday=()=>quickRange(today(),today());
 const quickYesterday=()=>{const y=addDays(today(),-1);quickRange(y,y)};
 const quick7d=()=>quickRange(addDays(today(),-6),today());
 const quickMonth=()=>quickRange(monthStart(),today());
 const quickTodayCarcass=()=>{setSalesFlow('CARCASS_POS');quickRange(today(),today())};

 const items=useMemo(()=>{
  const list=(data?.items||[]).slice();
  const {key,dir}=sort;
  list.sort((a,b)=>{
   const va=a[key],vb=b[key];
   const cmp=typeof va==='number'?va-vb:String(va||'').localeCompare(String(vb||''));
   return dir==='asc'?cmp:-cmp;
  });
  return list;
 },[data,sort]);

 const toggleSort=key=>setSort(s=>s.key===key?{key,dir:s.dir==='asc'?'desc':'asc'}:{key,dir:'desc'});

 const openDrill=async(row)=>{
  setDrill(row);setDrillData(null);setDrillLoading(true);
  try{
   const params={from_date:from,to_date:to,sales_flow:salesFlow};
   if(customerId)params.customer_id=customerId;
   setDrillData((await api.get(`/reports/product-quantity/${row.product_id}/details`,{params})).data);
  }catch(e){setError(e.response?.data?.message||e.message)}
  finally{setDrillLoading(false)}
 };

 const totalLine=data?.single_unit
  ?`Tổng sản lượng: ${qty(data.total_quantity,data.single_unit)}`
  :(data?.totals_by_unit?.length
     ?`Tổng sản lượng: ${data.totals_by_unit.map(u=>qty(u.quantity,u.unit)).join(' + ')}`
     :'Tổng sản lượng: 0');

 return <>
 <SafePage loading={loading} error={error}><div className="grid">
  <div className="card">
   <h3>Báo cáo sản lượng</h3>
   <p className="muted">Theo dõi số lượng bán theo từng mặt hàng</p>
   <div className="actions" style={{alignItems:'flex-start'}}>
    <div style={{display:'flex',flexDirection:'column',gap:2}}>
     <span className="muted" style={{fontSize:12}}>Từ ngày</span>
     <input className="input" style={{width:160}} type="date" value={from} onChange={e=>setFrom(e.target.value)}/>
     <span className="muted" style={{fontSize:11}}>Âm lịch: {lunarOf(from)}</span>
    </div>
    <div style={{display:'flex',flexDirection:'column',gap:2}}>
     <span className="muted" style={{fontSize:12}}>Đến ngày</span>
     <input className="input" style={{width:160}} type="date" value={to} onChange={e=>setTo(e.target.value)}/>
     <span className="muted" style={{fontSize:11}}>Âm lịch: {lunarOf(to)}</span>
    </div>
    <div style={{display:'flex',flexDirection:'column',gap:2}}>
     <span className="muted" style={{fontSize:12}}>Luồng bán</span>
     <select className="select" style={{width:160}} value={salesFlow} onChange={e=>setSalesFlow(e.target.value)}>
      <option value="ALL">Tất cả</option>
      <option value="CARCASS_POS">Bò Xô</option>
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
     {selectedCustomer&&<span className="muted" style={{fontSize:11}}>Tính bill: {selectedCustomer.billing_calendar_type==='LUNAR'?'Âm lịch':'Dương lịch'}</span>}
    </div>
    <button className="btn" onClick={()=>load()} style={{marginTop:20}}>Xem báo cáo</button>
   </div>
   <div className="actions" style={{marginTop:8}}>
    <button className="btn secondary" onClick={quickToday}>Hôm nay</button>
    <button className="btn secondary" onClick={quickYesterday}>Hôm qua</button>
    <button className="btn secondary" onClick={quick7d}>7 ngày</button>
    <button className="btn secondary" onClick={quickMonth}>Tháng này</button>
    <button className="btn" onClick={quickTodayCarcass}>Hôm nay + Bò Xô</button>
   </div>
  </div>

  <div className="grid grid-4">
   <div className="stat-card"><span>Tổng số bill hợp lệ</span><b>{data?.total_bills??0}</b></div>
   <div className="stat-card"><span>Tổng sản lượng</span><b>{totalLine.replace('Tổng sản lượng: ','')}</b></div>
   <div className="stat-card"><span>Số mặt hàng phát sinh</span><b>{data?.product_count??0}</b></div>
   <div className="stat-card"><span>Mặt hàng cao nhất</span><b>{data?.top_product?`${data.top_product.product_name} (${qty(data.top_product.quantity,data.top_product.unit)})`:'—'}</b></div>
  </div>

  <div className="card">
   <table className="table">
    <thead><tr>
     <th>STT</th>
     <th>Mã hàng</th>
     <th style={{cursor:'pointer'}} onClick={()=>toggleSort('product_name')}>Mặt hàng</th>
     <th>ĐVT</th>
     <th style={{cursor:'pointer'}} onClick={()=>toggleSort('quantity')}>Số lượng</th>
     <th style={{cursor:'pointer'}} onClick={()=>toggleSort('percentage')}>Tỷ lệ</th>
    </tr></thead>
    <tbody>
     {items.map((r,i)=>
      <tr key={r.product_id+'-'+r.unit} style={{cursor:'pointer'}} onClick={()=>openDrill(r)} title="Xem chi tiết">
       <td>{i+1}</td>
       <td>{r.product_code}</td>
       <td><b>{r.product_name}</b></td>
       <td>{r.unit}</td>
       <td>{formatQty(r.quantity)}</td>
       <td>{pct(r.percentage)}</td>
      </tr>
     )}
     {!items.length&&<tr><td colSpan={6} className="muted" style={{textAlign:'center'}}>Không có dữ liệu</td></tr>}
    </tbody>
    {!!items.length&&<tfoot><tr>
     <td colSpan={4}><b>TỔNG</b></td>
     <td colSpan={2}><b>{totalLine.replace('Tổng sản lượng: ','')}</b></td>
    </tr></tfoot>}
   </table>
  </div>
 </div>
 </SafePage>

 <Dialog open={!!drill} title={drill?`Chi tiết: ${drill.product_name}`:''} maxWidth={900} onClose={()=>{setDrill(null);setDrillData(null)}}>
  {drillLoading&&<p className="muted">Đang tải...</p>}
  {drillData&&<>
   <p className="muted">Tổng số lượng: <b>{qty(drillData.quantity,drill?.unit)}</b> — phải khớp với dòng tổng hợp ở bảng chính.</p>
   <table className="table">
    <thead><tr><th>Ngày xuất hàng</th><th>Mã bill</th><th>Khách hàng</th><th>Số lượng</th><th>Đơn giá</th><th>Thành tiền</th><th>Trạng thái thanh toán</th></tr></thead>
    <tbody>
     {drillData.rows.map((r,i)=><tr key={i}>
      <td>{String(r.order_date).slice(0,10)}</td>
      <td>{r.order_code}</td>
      <td>{r.customer_name}</td>
      <td>{qty(r.quantity,r.unit)}</td>
      <td>{money(r.sale_price)}</td>
      <td>{money(r.total_price)}</td>
      <td>{PAYMENT_LABEL[r.payment_status]||r.payment_status}</td>
     </tr>)}
     {!drillData.rows.length&&<tr><td colSpan={7} className="muted" style={{textAlign:'center'}}>Không có dữ liệu</td></tr>}
    </tbody>
   </table>
  </>}
 </Dialog>
 </>
}
