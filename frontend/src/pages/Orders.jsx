import React,{useEffect,useMemo,useState}from'react';
import api from'../api/api';
import SafePage from'../components/SafePage';
const parseMoney=v=>Number(String(v??'').replace(/[^0-9.-]/g,'')||0);
const money=n=>parseMoney(n).toLocaleString('en-US')+'đ';
const moneyInput=v=>String(v??'')===''?'':parseMoney(v).toLocaleString('en-US');
const pageSize=15;
const isoDate=v=>String(v||'').slice(0,10);
const ymd=v=>{
 const raw=isoDate(v);
 const m=raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
 return m?`${m[3]}/${m[2]}/${m[1]}`:raw;
};
const billDateLabel=o=>{
 const ct=String(o?.calendar_type||'SOLAR').toUpperCase();
 const lunar=String(o?.lunar_date_text||'').trim();
 if(ct==='LUNAR'&&lunar)return `${lunar} ÂL / ${ymd(o?.order_date)} DL`;
 return ymd(o?.order_date);
};
const billDisplayTotal=o=>{
 if(o?.items?.length){
  const lineTotal=o.items.reduce((sum,i)=>sum+Number(i.quantity||0)*parseMoney(i.sale_price),0);
  return lineTotal+Number(o?.installment_amount||0);
 }
 return Number(o?.total_amount||0);
};

function Pager({page,totalPages,total,onChange,label='dòng'}){
 const current=Math.min(Math.max(1,page),totalPages||1);
 const pages=[];
 const start=Math.max(1,current-2),end=Math.min(totalPages,start+4);
 for(let i=start;i<=end;i++)pages.push(i);
 return <div className="pager-bar">
  <div className="muted">Tổng {total} {label} • Trang {current}/{totalPages}</div>
  <div className="pager-actions">
   <button className="btn secondary" disabled={current<=1} onClick={()=>onChange(1)}>Đầu</button>
   <button className="btn secondary" disabled={current<=1} onClick={()=>onChange(current-1)}>‹</button>
   {pages.map(p=><button key={p} className={p===current?'btn':'btn secondary'} onClick={()=>onChange(p)}>{p}</button>)}
   <button className="btn secondary" disabled={current>=totalPages} onClick={()=>onChange(current+1)}>›</button>
   <button className="btn secondary" disabled={current>=totalPages} onClick={()=>onChange(totalPages)}>Cuối</button>
  </div>
 </div>;
}

export default function Orders(){
 const[rows,setRows]=useState([]),[detail,setDetail]=useState(null),[qr,setQr]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
 const[productOptions,setProductOptions]=useState([]);
 const[addLine,setAddLine]=useState({product_id:'',product_name:'',quantity:'',sale_price:'',unit:'kg'});
 const[addOpen,setAddOpen]=useState(false);
 const[toast,setToast]=useState(null);
 const[ saving,setSaving]=useState(false);
 const[filters,setFilters]=useState({from:'',to:'',customer:''});
 const[paymentReportRows,setPaymentReportRows]=useState([]);
 const[page,setPage]=useState(1);
 const base=import.meta.env.VITE_API_URL||(typeof window !== 'undefined' ? `${window.location.origin}/api` : '/api');
 const load=async()=>{try{setRows((await api.get('/orders')).data||[])}catch(e){setError(e.response?.data?.message||e.message)}finally{setLoading(false)}};
 useEffect(()=>{load()},[]);
 const loadPaymentReport=async()=>{
  try{
   const params={};
   if(filters.from)params.from=filters.from;
   if(filters.to)params.to=filters.to;
   if(filters.customer)params.customer=filters.customer;
   setPaymentReportRows((await api.get('/payments',{params})).data||[]);
  }catch(e){setPaymentReportRows([])}
 };
 useEffect(()=>{loadPaymentReport()},[filters.from,filters.to,filters.customer]);
 const filtered=useMemo(()=>{
  const name=String(filters.customer||'').trim().toLowerCase();
  return (rows||[]).filter(o=>{
   const d=isoDate(o.order_date);
   if(filters.from&&d<filters.from)return false;
   if(filters.to&&d>filters.to)return false;
   if(name&&!String(o.customer_name||'').toLowerCase().includes(name))return false;
   return true;
  });
 },[rows,filters]);
 const totalPages=Math.max(1,Math.ceil(filtered.length/pageSize));
 const currentPage=Math.min(page,totalPages);
 const pageRows=filtered.slice((currentPage-1)*pageSize,currentPage*pageSize);
 const changeFilter=(k,v)=>{setFilters(f=>({...f,[k]:v}));setPage(1)};
 const open=async id=>{const d=(await api.get('/orders/'+id)).data;const q=(await api.get('/orders/'+id+'/qrcode')).data;setDetail(d);setQr(q);setAddLine({product_id:'',product_name:'',quantity:'',sale_price:'',unit:'kg'})};
 const getToken=async order=>{let token=qr?.token;if(!token||detail?.id!==order.id){token=(await api.get('/orders/'+order.id+'/qrcode')).data.token}return token};
 const print=async order=>{const token=await getToken(order);window.open(base+'/orders/public/'+encodeURIComponent(token)+'/print','_blank')};
 const printK80=async order=>{const token=await getToken(order);window.open(base+'/orders/public/'+encodeURIComponent(token)+'/k80','_blank')};
 const isLocked=o=>Number(o?.is_locked||0)===1||!!o?.locked_at;
 const lockOrder=async o=>{if(!await window.appConfirm(`Chốt sổ bill ${o.order_code}?\nSau khi chốt sẽ không sửa/thêm hàng.`,{title:'Chốt sổ bill',confirmText:'Chốt bill',variant:'warning'}))return;await api.post('/orders/'+o.id+'/lock',{});await load();if(detail?.id===o.id)await refreshDetail();showToast('success','Đã chốt bill','Bill chỉ còn xem/in.');};
 const refreshDetail=async()=>{const d=(await api.get('/orders/'+detail.id)).data;setDetail(d);load()};
 const showToast=(type,title,message)=>{setToast({type,title,message});setTimeout(()=>setToast(null),2600)};
 const focusBillInput=(row,col)=>{setTimeout(()=>document.querySelector(`[data-bill-input="${row}-${col}"]`)?.focus(),0)};
 const handleBillKeyDown=(row,col,e)=>{
  const key=e.key;
  if(!['Enter','ArrowDown','ArrowUp','ArrowLeft','ArrowRight'].includes(key))return;
  e.preventDefault();
  const maxRow=(detail?.items?.length||1)-1;
  let nr=row,nc=col;
  if(key==='Enter'||key==='ArrowDown') nr=Math.min(maxRow,row+1);
  if(key==='ArrowUp') nr=Math.max(0,row-1);
  if(key==='ArrowRight') nc=Math.min(1,col+1);
  if(key==='ArrowLeft') nc=Math.max(0,col-1);
  focusBillInput(nr,nc);
 };
 const handleAddKeyDown=e=>{if(e.key==='Enter'){e.preventDefault();addItem();}};
 const saveAllItems=async()=>{
  if(!detail||saving)return;
  try{
   setSaving(true);
   for(const item of detail.items||[]){
    await api.put(`/orders/${detail.id}/items/${item.id}`,{quantity:Number(item.quantity||0),sale_price:parseMoney(item.sale_price)});
   }
   await refreshDetail();
   showToast('success','Lưu thành công','Bill đã được cập nhật.');
  }catch(e){showToast('error','Lưu thất bại',e.response?.data?.message||e.message||'Không lưu được bill.');}
  finally{setSaving(false)}
 };
 useEffect(()=>{
  if(!detail?.customer_id){setProductOptions([]);return;}
  api.get('/products/customer/'+detail.customer_id).then(r=>setProductOptions(r.data?.products||[])).catch(()=>setProductOptions([]));
 },[detail?.customer_id]);
 const selectAddProduct=id=>{
  const p=productOptions.find(x=>String(x.product_id)===String(id));
  if(!p){setAddLine(a=>({...a,product_id:'',product_name:id}));return;}
  setAddLine(a=>({...a,product_id:p.product_id,product_name:p.product_name,unit:p.unit||'kg',sale_price:p.sale_price||p.default_sale_price||''}));
 };
 const addItem=async()=>{
  if(!detail)return;
  try{
   const payload={...addLine,quantity:Number(addLine.quantity||0),sale_price:parseMoney(addLine.sale_price)};
   if(!payload.product_id) delete payload.product_id;
   await api.post(`/orders/${detail.id}/items`,payload);
   setAddLine({product_id:'',product_name:'',quantity:'',sale_price:'',unit:'kg'});
   await refreshDetail();
   showToast('success','Đã thêm mặt hàng','Mặt hàng đã được thêm vào bill.');
   setAddOpen(false);
  }catch(e){showToast('error','Thêm thất bại',e.response?.data?.message||e.message||'Không thêm được mặt hàng.')}
 };
 const closeDetail=()=>{setDetail(null);setQr(null);setProductOptions([])};
 const statusText=o=>String(o?.payment_status||'')==='PAID'?'Đã thanh toán':(Number(o?.debt_amount||0)>0?'Còn nợ':String(o?.payment_status||''));
 const orderCreatedDate=o=>ymd(o?.created_at||o?.order_date);
 const billCalendarLabel=o=>String(o?.calendar_type||'SOLAR').toUpperCase()==='LUNAR'?'Âm lịch':'Dương lịch';
 const reportRows=filtered;
 const reportTotals=reportRows.reduce((a,o)=>({
  bills:a.bills+1,
  total:a.total+Number(o.total_amount||0),
  paid:a.paid+Number(o.paid_amount||0),
  debt:a.debt+Number(o.debt_amount||0)
 }),{bills:0,total:0,paid:0,debt:0});
 const customerSummaryRows=Object.values(reportRows.reduce((m,o)=>{
  const key=o.customer_id||o.customer_name||'unknown';
  if(!m[key])m[key]={customer_id:key,customer_name:o.customer_name||'Không rõ khách',calendar_type:o.calendar_type||'SOLAR',bills:0,total:0,paid:0,debt:0};
  m[key].bills+=1;
  m[key].total+=Number(o.total_amount||0);
  m[key].paid+=Number(o.paid_amount||0);
  m[key].debt+=Number(o.debt_amount||0);
  return m;
 },{}));
 const receiptRows=paymentReportRows||[];
 const receiptTotals=receiptRows.reduce((a,p)=>({
  receipts:a.receipts+1,
  cash:a.cash+Number(p.cash_amount||0),
  bank:a.bank+Number(p.bank_amount||0),
  total:a.total+Number(p.amount||0),
  allocated:a.allocated+Number(p.allocated_total||p.amount||0)
 }),{receipts:0,cash:0,bank:0,total:0,allocated:0});
 const paymentDateLabel=p=>ymd(p.payment_date||p.created_at);
 const allocationText=p=>String(p.allocation_text||'').trim()||'Chưa phân bổ';
 const printReportHtml=(title,tableHtml)=>{
  const w=window.open('','_blank');
  if(!w)return;
  const range=`Từ ngày ${filters.from||'...'} đến ${filters.to||'...'}${filters.customer?' | Khách: '+filters.customer:''}`;
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
   @page{size:A4 landscape;margin:10mm}body{font-family:Arial,sans-serif;color:#111;font-size:11px}h2{text-align:center;margin:4px 0 8px}.meta{display:flex;justify-content:space-between;margin-bottom:8px}.company{font-weight:700}.subtitle{text-align:center;margin-bottom:10px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #333;padding:4px;text-align:right;vertical-align:middle}th{background:#f1f1f1;text-align:center}td.left{text-align:left}td.center{text-align:center}tfoot td{font-weight:700;background:#f7f7f7}.sign{display:flex;justify-content:space-around;margin-top:36px;text-align:center;font-weight:700}.sign small{display:block;font-weight:400;margin-top:6px}</style></head><body>
   <div class="meta"><div><div class="company">CÔNG TY TNHH MEATBIZ</div><div>Địa chỉ: ................................................</div><div>ĐT: ................................................</div></div><div>Ngày in: ${new Date().toLocaleDateString('vi-VN')}</div></div>
   <h2>${title}</h2><div class="subtitle">${range}</div>${tableHtml}<div class="sign"><div>Người lập biểu<small>(Ký, họ tên)</small></div><div>Kế toán<small>(Ký, họ tên)</small></div><div>Giám đốc<small>(Ký, họ tên)</small></div></div>
   <script>window.onload=()=>setTimeout(()=>window.print(),200)</script></body></html>`);
  w.document.close();
 };
 const printCustomerDetail=()=>{
  const body=reportRows.map((o,i)=>`<tr><td class="center">${i+1}</td><td class="center">${orderCreatedDate(o)}</td><td class="center">${billDateLabel(o)}</td><td class="center">${billCalendarLabel(o)}</td><td class="left">${o.order_code||''}</td><td class="left">${o.customer_name||''}</td><td>${money(o.total_amount)}</td><td>${money(o.paid_amount)}</td><td>${money(o.debt_amount)}</td><td class="center">${statusText(o)}</td></tr>`).join('');
  const html=`<table><thead><tr><th>STT</th><th>Ngày lập phiếu</th><th>Ngày xuất hàng</th><th>Loại lịch</th><th>Mã bill</th><th>Khách hàng</th><th>Tổng tiền hàng</th><th>Đã thu</th><th>Còn nợ</th><th>Trạng thái</th></tr></thead><tbody>${body}</tbody><tfoot><tr><td colspan="6" class="center">TỔNG CỘNG</td><td>${money(reportTotals.total)}</td><td>${money(reportTotals.paid)}</td><td>${money(reportTotals.debt)}</td><td class="center">${reportTotals.bills} bill</td></tr></tfoot></table>`;
  printReportHtml('THỐNG KÊ CHI TIẾT BILL BÁN HÀNG THEO KHÁCH HÀNG',html);
 };
 const printCustomerSummary=()=>{
  const body=customerSummaryRows.map((r,i)=>`<tr><td class="center">${i+1}</td><td class="left">${r.customer_name}</td><td class="center">${String(r.calendar_type||'SOLAR').toUpperCase()==='LUNAR'?'Âm lịch':'Dương lịch'}</td><td>${r.bills}</td><td>${money(r.total)}</td><td>${money(r.paid)}</td><td>${money(r.debt)}</td></tr>`).join('');
  const html=`<table><thead><tr><th>STT</th><th>Khách hàng</th><th>Loại lịch tính</th><th>Số bill</th><th>Tổng tiền hàng</th><th>Tổng đã thu</th><th>Tổng còn nợ</th></tr></thead><tbody>${body}</tbody><tfoot><tr><td colspan="3" class="center">TỔNG CỘNG</td><td>${reportTotals.bills}</td><td>${money(reportTotals.total)}</td><td>${money(reportTotals.paid)}</td><td>${money(reportTotals.debt)}</td></tr></tfoot></table>`;
  printReportHtml('THỐNG KÊ TỔNG HỢP BILL BÁN HÀNG THEO KHÁCH HÀNG',html);
 };
 const printPaymentHistory=()=>{
  const body=receiptRows.map((p,i)=>`<tr><td class="center">${i+1}</td><td class="center">${paymentDateLabel(p)}</td><td class="left">${p.payment_code||''}</td><td class="left">${p.customer_name||''}</td><td>${money(p.cash_amount)}</td><td>${money(p.bank_amount)}</td><td>${money(p.amount)}</td><td class="left">${allocationText(p)}</td><td class="left">${p.note||''}</td></tr>`).join('');
  const html=`<table><thead><tr><th>STT</th><th>Ngày thu</th><th>Phiếu thu</th><th>Khách hàng</th><th>Tiền mặt</th><th>Chuyển khoản</th><th>Tổng khách đưa</th><th>Phân bổ vào bill</th><th>Ghi chú</th></tr></thead><tbody>${body}</tbody><tfoot><tr><td colspan="4" class="center">TỔNG CỘNG</td><td>${money(receiptTotals.cash)}</td><td>${money(receiptTotals.bank)}</td><td>${money(receiptTotals.total)}</td><td colspan="2">${receiptTotals.receipts} phiếu thu</td></tr></tfoot></table>`;
  printReportHtml('LỊCH SỬ THU TIỀN THEO KHÁCH HÀNG',html);
 };
 return <SafePage loading={loading} error={error}>
  <div className="orders-page orders-page-full">
   <div className="card">
    <div className="section-head"><h3>Bill bán hàng</h3><span className="muted">15 bill/trang</span></div>
    <div className="filter-row">
     <label className="field-label"><span>Từ ngày</span><input className="input" type="date" value={filters.from} onChange={e=>changeFilter('from',e.target.value)}/></label>
     <label className="field-label"><span>Đến ngày</span><input className="input" type="date" value={filters.to} onChange={e=>changeFilter('to',e.target.value)}/></label>
     <label className="field-label"><span>Tên khách hàng</span><input className="input" placeholder="Nhập tên khách" value={filters.customer} onChange={e=>changeFilter('customer',e.target.value)}/></label>
     <button className="btn secondary" onClick={()=>{setFilters({from:'',to:'',customer:''});setPage(1)}}>Xóa lọc</button>
    </div>
    <Pager page={currentPage} totalPages={totalPages} total={filtered.length} label="bill" onChange={setPage}/>
    <div className="table-wrap"><table className="table orders-table"><thead><tr><th>Thao tác</th><th>Ngày</th><th>Khách hàng</th><th>Tổng</th><th>Trạng thái</th><th>Bill</th></tr></thead><tbody>{pageRows.map(o=><tr key={o.id}><td><div className="row-actions bill-actions"><button className="btn secondary" onClick={()=>open(o.id)}>Xem</button><button className="btn" onClick={()=>print(o)}>In A4</button><button className="btn secondary" onClick={()=>printK80(o)}>K80</button><button className="btn secondary" disabled={isLocked(o)} onClick={()=>lockOrder(o)}>{isLocked(o)?'Đã chốt':'Chốt'}</button></div></td><td>{billDateLabel(o)}</td><td>{o.customer_name}</td><td>{money(o.total_amount)}</td><td>{o.payment_status}{isLocked(o)?' / Đã chốt':''}</td><td><b>{o.order_code}</b></td></tr>)}</tbody></table></div>
    <Pager page={currentPage} totalPages={totalPages} total={filtered.length} label="bill" onChange={setPage}/>
   </div>

   <div className="card customer-bill-report-card">
    <div className="section-head"><h3>Thống kê bill bán hàng theo khách hàng</h3><div className="row-actions"><button className="btn secondary" onClick={printCustomerDetail}>In chi tiết</button><button className="btn" onClick={printCustomerSummary}>In tổng hợp</button></div></div>
    <p className="muted">Dùng bộ lọc phía trên. Báo cáo có cả Ngày lập phiếu và Ngày xuất hàng theo lịch âm/dương của khách hàng.</p>
    <div className="summary-grid">
     <div><span>Số bill</span><b>{reportTotals.bills}</b></div>
     <div><span>Tổng tiền hàng</span><b>{money(reportTotals.total)}</b></div>
     <div><span>Đã thu</span><b>{money(reportTotals.paid)}</b></div>
     <div><span>Còn nợ</span><b>{money(reportTotals.debt)}</b></div>
    </div>
    <div className="section-head" style={{marginTop:16}}><h3>Lịch sử thu tiền thực tế</h3><button className="btn secondary" onClick={printPaymentHistory}>In lịch sử thu tiền</button></div>
    <p className="muted">Phần này thể hiện mỗi lần bạn hàng đưa bao nhiêu tiền mặt/chuyển khoản. Cột phân bổ cho biết số tiền đó được trừ vào bill nào.</p>
    <div className="summary-grid">
     <div><span>Số phiếu thu</span><b>{receiptTotals.receipts}</b></div>
     <div><span>Tổng tiền mặt</span><b>{money(receiptTotals.cash)}</b></div>
     <div><span>Tổng chuyển khoản</span><b>{money(receiptTotals.bank)}</b></div>
     <div><span>Tổng khách đưa</span><b>{money(receiptTotals.total)}</b></div>
    </div>
    <div className="table-wrap"><table className="table compact"><thead><tr><th>Ngày thu</th><th>Phiếu thu</th><th>Khách hàng</th><th>Tiền mặt</th><th>Chuyển khoản</th><th>Tổng khách đưa</th><th>Phân bổ vào bill</th></tr></thead><tbody>{receiptRows.map(p=><tr key={p.id}><td>{paymentDateLabel(p)}</td><td>{p.payment_code}</td><td>{p.customer_name}</td><td>{money(p.cash_amount)}</td><td>{money(p.bank_amount)}</td><td>{money(p.amount)}</td><td>{allocationText(p)}</td></tr>)}</tbody><tfoot><tr><td colSpan="3">Tổng cộng</td><td>{money(receiptTotals.cash)}</td><td>{money(receiptTotals.bank)}</td><td>{money(receiptTotals.total)}</td><td>{receiptTotals.receipts} phiếu thu</td></tr></tfoot></table></div>
    <div className="table-wrap"><table className="table compact"><thead><tr><th>Ngày lập</th><th>Ngày xuất hàng</th><th>Bill</th><th>Khách hàng</th><th>Tổng</th><th>Đã thu</th><th>Còn nợ</th><th>Trạng thái</th></tr></thead><tbody>{reportRows.map(o=><tr key={o.id}><td>{orderCreatedDate(o)}</td><td><b>{billDateLabel(o)}</b><br/><span className="muted">{billCalendarLabel(o)}</span></td><td>{o.order_code}</td><td>{o.customer_name}</td><td>{money(o.total_amount)}</td><td>{money(o.paid_amount)}</td><td>{money(o.debt_amount)}</td><td>{statusText(o)}</td></tr>)}</tbody><tfoot><tr><td colSpan="4">Tổng cộng</td><td>{money(reportTotals.total)}</td><td>{money(reportTotals.paid)}</td><td>{money(reportTotals.debt)}</td><td>{reportTotals.bills} bill</td></tr></tfoot></table></div>
    <h3 style={{marginTop:16}}>Tổng hợp theo khách hàng</h3>
    <div className="table-wrap"><table className="table compact"><thead><tr><th>Khách hàng</th><th>Loại lịch</th><th>Số bill</th><th>Tổng tiền</th><th>Đã thu</th><th>Còn nợ</th></tr></thead><tbody>{customerSummaryRows.map(r=><tr key={r.customer_id}><td>{r.customer_name}</td><td>{String(r.calendar_type||'SOLAR').toUpperCase()==='LUNAR'?'Âm lịch':'Dương lịch'}</td><td>{r.bills}</td><td>{money(r.total)}</td><td>{money(r.paid)}</td><td>{money(r.debt)}</td></tr>)}</tbody><tfoot><tr><td colSpan="2">Tổng cộng</td><td>{reportTotals.bills}</td><td>{money(reportTotals.total)}</td><td>{money(reportTotals.paid)}</td><td>{money(reportTotals.debt)}</td></tr></tfoot></table></div>
   </div>
   {detail&&<div className="bill-edit-overlay"><div className="card detail-card bill-edit-panel bill-edit-wide bill-edit-compact">
    <div className="bill-edit-shell">
     <div className="bill-edit-head">
      <div className="bill-edit-title"><span className="eyebrow">Sửa bill bán hàng</span><h2>{detail.order_code}</h2><p>{detail.customer_name} - {detail.phone}</p></div>
      <div className="bill-edit-head-actions"><button className="btn" onClick={()=>print(detail)}>In A4 + QR</button><button className="btn secondary" onClick={()=>printK80(detail)}>In nhiệt K80</button><button className="btn secondary" onClick={closeDetail}>Đóng</button></div>
      {qr&&<img src={qr.qrcode} className="bill-qr"/>}
     </div>

     <div className="bill-edit-body">
      <div className="table-wrap bill-edit-table-wrap">
       <table className="table bill-edit-table">
        <thead><tr><th>Hàng</th><th>SL</th><th>Giá</th><th>Tiền</th></tr></thead>
        <tbody>{detail.items.map((i,idx)=><tr key={i.id}>
         <td>{i.product_name}</td>
         <td><input data-bill-input={`${idx}-0`} inputMode="decimal" className="input" value={i.quantity} onKeyDown={e=>handleBillKeyDown(idx,0,e)} onChange={e=>setDetail({...detail,items:detail.items.map(x=>x.id===i.id?{...x,quantity:e.target.value}:x)})}/></td>
         <td><input data-bill-input={`${idx}-1`} inputMode="numeric" className="input" value={moneyInput(i.sale_price)} onKeyDown={e=>handleBillKeyDown(idx,1,e)} onChange={e=>setDetail({...detail,items:detail.items.map(x=>x.id===i.id?{...x,sale_price:e.target.value}:x)})}/></td>
         <td><b>{money(Number(i.quantity||0)*parseMoney(i.sale_price))}</b></td>
        </tr>)}</tbody>
       </table>
      </div>
      <div className="bill-keyboard-help">Nhấn Enter để xuống dòng. Dùng ↑ ↓ để lên/xuống, ← → để chuyển giữa SL và Giá.</div>

      <div className={`bill-add-item bill-add-collapsible ${addOpen?'open':'collapsed'}`}>
       <button type="button" className="bill-add-toggle" onClick={()=>setAddOpen(v=>!v)}>
        <span>{addOpen?'▾':'▸'} Thêm mặt hàng thiếu</span><span>{addOpen?'Thu gọn':'Mở thêm'}</span>
       </button>
       {addOpen&&<div className="bill-add-inner">
        <div className="bill-add-grid bill-add-grid-compact">
         <label className="field-label"><span>Hàng có sẵn</span><select className="input" value={addLine.product_id} onKeyDown={handleAddKeyDown} onChange={e=>selectAddProduct(e.target.value)}><option value="">-- Hàng mới / tự nhập tên --</option>{productOptions.map(p=><option key={p.product_id} value={p.product_id}>{p.product_name} - {money(p.sale_price||p.default_sale_price||0)}</option>)}</select></label>
         <label className="field-label"><span>Tên hàng mới</span><input className="input" value={addLine.product_name} onKeyDown={handleAddKeyDown} onChange={e=>setAddLine(a=>({...a,product_id:'',product_name:e.target.value}))} placeholder="Nhập tên hàng mới"/></label>
         <label className="field-label"><span>SL</span><input inputMode="decimal" className="input" value={addLine.quantity} onKeyDown={handleAddKeyDown} onChange={e=>setAddLine(a=>({...a,quantity:e.target.value}))}/></label>
         <label className="field-label"><span>Giá</span><input inputMode="numeric" className="input" value={moneyInput(addLine.sale_price)} onKeyDown={handleAddKeyDown} onChange={e=>setAddLine(a=>({...a,sale_price:e.target.value}))}/></label>
         <button className="btn" onClick={addItem}>+ Thêm</button>
        </div>
        <p className="muted">Hàng có sẵn tự lấy giá riêng của khách nếu có. Hàng mới cho nhập giá linh động và tự thêm vào danh mục.</p>
       </div>}
      </div>

      {detail.old_debts&&detail.old_debts.length>0&&<div className="bill-old-debts"><h3>Những bill chưa thanh toán</h3><div className="table-wrap"><table className="table"><tbody>{detail.old_debts.map(d=><tr key={d.id}><td>{billDateLabel(d)}</td><td>{d.order_code}</td><td>{money(d.debt_amount)}</td></tr>)}</tbody></table></div><h3>Tổng nợ cũ: {money(detail.old_debt_total)}</h3></div>}
     </div>

     <div className="bill-edit-footer"><h3>Tổng bill này: {money(billDisplayTotal(detail))}</h3><div className="actions"><button className="btn secondary" onClick={closeDetail}>Hủy</button><button className="btn" disabled={saving} onClick={saveAllItems}>{saving?'Đang lưu...':'Lưu thay đổi'}</button></div></div>
    </div>
    {toast&&<div className={`bill-toast ${toast.type}`}><b>{toast.title}</b><span>{toast.message}</span><button onClick={()=>setToast(null)}>×</button></div>}
   </div></div>}  </div>
 </SafePage>;
}
