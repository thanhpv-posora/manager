import React,{useEffect,useState}from'react';
import api from'../../api/api';
import Dialog from'../../components/common/Dialog';
import {showSuccess,showError,showWarning}from'../../utils/toast';
import {formatQtyTrim}from'../../utils/quantity';

// S9.3R-01 — extracted verbatim from SalesReturns.jsx (Foundation story: pure
// move, no behavior change). REASON_LABELS/REASON_CODES/ymd/isoDate are
// duplicated here rather than shared, since no shared-constants module is
// part of this story's scope — SalesReturns.jsx keeps its own copies for its
// table/print output. Reconciling that duplication is out of scope for
// S9.3R-01. Qty formatting uses the existing shared formatQtyTrim()
// (utils/quantity.js) instead of a local reimplementation, since that
// helper already exists and does the identical job.

const REASON_LABELS={
  WRONG_ITEM:'Giao sai hàng',
  CUSTOMER_CHANGED_MIND:'Khách đổi ý',
  QUALITY_COMPLAINT:'Khiếu nại chất lượng',
  QUANTITY_ERROR:'Sai số lượng',
  PRICE_DISPUTE:'Tranh chấp giá',
  OTHER:'Khác',
};
const REASON_CODES=Object.keys(REASON_LABELS);
// Orders a return may target — matches ReturnAgent.js's ORDER_STATUSES_RETURNABLE
// verbatim (not redefined independently; kept in sync by hand since the value is
// small and stable — see Known Limitations in the story report for why this
// isn't fetched from the backend).
const ORDER_STATUSES_RETURNABLE=['CONFIRMED','DELIVERED'];

const isoDate=v=>String(v||'').slice(0,10);
const ymd=v=>{
  const raw=isoDate(v);
  const m=raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m?`${m[3]}/${m[2]}/${m[1]}`:raw;
};
// New Return — Customer -> Completed Orders only -> Order items -> Save.
// Three steps inside one Dialog, matching the story's business flow exactly.
export default function NewReturnDialog({open,onClose,onSaved}){
  const[step,setStep]=useState(1);
  const[customers,setCustomers]=useState([]);
  const[customerId,setCustomerId]=useState('');
  const[orders,setOrders]=useState([]);
  const[orderId,setOrderId]=useState('');
  const[orderDetail,setOrderDetail]=useState(null);
  const[remainingByItem,setRemainingByItem]=useState({});
  const[lines,setLines]=useState({}); // order_item_id -> qty string
  const[reasonCode,setReasonCode]=useState('');
  const[reasonNote,setReasonNote]=useState('');
  const[saving,setSaving]=useState(false);
  const[loadingOrders,setLoadingOrders]=useState(false);

  const reset=()=>{
    setStep(1);setCustomerId('');setOrders([]);setOrderId('');setOrderDetail(null);
    setRemainingByItem({});setLines({});setReasonCode('');setReasonNote('');
  };
  useEffect(()=>{ if(open){ reset(); api.get('/partners',{params:{role:'customer'}}).then(r=>setCustomers(r.data||[])).catch(()=>setCustomers([])); } },[open]);

  const pickCustomer=async(id)=>{
    setCustomerId(id);
    setOrders([]);setOrderId('');setOrderDetail(null);
    if(!id)return;
    try{
      setLoadingOrders(true);
      const all=(await api.get('/orders')).data||[];
      const completed=all.filter(o=>String(o.customer_id)===String(id)&&ORDER_STATUSES_RETURNABLE.includes(String(o.status||'').toUpperCase()));
      setOrders(completed);
    }catch(e){ showError(e.response?.data?.message||e.message); }
    finally{ setLoadingOrders(false); }
  };

  const pickOrder=async(id)=>{
    setOrderId(id);
    setOrderDetail(null);setLines({});setRemainingByItem({});
    if(!id)return;
    try{
      const [detail,existingReturns]=await Promise.all([
        api.get('/orders/'+id),
        api.get('/orders/'+id+'/returns'),
      ]);
      const items=detail.data?.items||[];
      // Remaining returnable qty per line = original quantity - sum already
      // requested across every non-cancelled return already on this order.
      // Mirrors ReturnAgent.create()'s own server-side check — this is a
      // client-side convenience preview only; the backend is still the
      // authority and re-checks this exact invariant on save.
      const alreadyByItem={};
      for(const ret of (existingReturns.data?.returns||[])){
        if(ret.status==='CANCELLED')continue;
        for(const it of (ret.items||[])){
          alreadyByItem[it.order_item_id]=(alreadyByItem[it.order_item_id]||0)+Number(it.quantity_requested||0);
        }
      }
      const remaining={};
      for(const it of items) remaining[it.id]=Number(it.quantity||0)-Number(alreadyByItem[it.id]||0);
      setOrderDetail(detail.data);
      setRemainingByItem(remaining);
      setStep(3);
    }catch(e){ showError(e.response?.data?.message||e.message); }
  };

  const setLineQty=(itemId,v)=>setLines(l=>({...l,[itemId]:v}));

  const save=async()=>{
    if(!reasonCode){ showWarning('Vui lòng chọn lý do trả hàng'); return; }
    const items=Object.entries(lines)
      .map(([order_item_id,qty])=>({order_item_id:Number(order_item_id),quantity_requested:Number(qty)}))
      .filter(l=>l.quantity_requested>0);
    if(!items.length){ showWarning('Vui lòng nhập số lượng trả cho ít nhất một mặt hàng'); return; }
    for(const l of items){
      const remaining=Number(remainingByItem[l.order_item_id]||0);
      if(l.quantity_requested>remaining+0.0001){
        showWarning(`Số lượng trả vượt quá số lượng còn lại có thể trả (${formatQtyTrim(remaining)})`);
        return;
      }
    }
    try{
      setSaving(true);
      await api.post(`/orders/${orderId}/returns`,{return_reason_code:reasonCode,return_reason_note:reasonNote,items});
      showSuccess('Đã tạo yêu cầu trả hàng');
      onSaved();
    }catch(e){ showError(e.response?.data?.message||e.message||'Tạo yêu cầu trả hàng thất bại'); }
    finally{ setSaving(false); }
  };

  return <Dialog open={open} title="Tạo yêu cầu trả hàng" onClose={onClose} maxWidth={760}
    footer={step===3?<>
      <button type="button" className="btn secondary" onClick={onClose} disabled={saving}>Hủy</button>
      <button type="button" className="btn" onClick={save} disabled={saving}>{saving?'Đang lưu...':'Lưu'}</button>
    </>:undefined}>
    {step===1&&<>
      <label className="field-label"><span>Khách hàng *</span>
        <select className="select" value={customerId} onChange={e=>pickCustomer(e.target.value)}>
          <option value="">-- Chọn khách hàng --</option>
          {customers.map(c=><option key={c.id} value={c.id}>{c.name}{c.customer_code?` (${c.customer_code})`:''}</option>)}
        </select>
      </label>
      {customerId&&<div style={{marginTop:16}}>
        <h3 style={{marginBottom:8}}>Bill đã hoàn tất</h3>
        {loadingOrders&&<div>Đang tải...</div>}
        {!loadingOrders&&!orders.length&&<div style={{color:'#6b7280'}}>Khách hàng này chưa có bill nào đã giao/hoàn tất.</div>}
        {!!orders.length&&<table>
          <thead><tr><th>Mã bill</th><th>Ngày</th><th>Trạng thái</th><th></th></tr></thead>
          <tbody>
            {orders.map(o=>(
              <tr key={o.id}>
                <td>{o.order_code}</td><td>{ymd(o.order_date)}</td><td>{o.status}</td>
                <td><button type="button" className="btn secondary" onClick={()=>pickOrder(o.id)}>Chọn</button></td>
              </tr>
            ))}
          </tbody>
        </table>}
      </div>}
    </>}

    {step===3&&orderDetail&&<>
      <div style={{marginBottom:12}}><b>Bill:</b> {orderDetail.order_code} — <b>Khách hàng:</b> {orderDetail.customer_name}</div>
      <table>
        <thead><tr><th>Mặt hàng</th><th style={{textAlign:'right'}}>SL đã giao</th><th style={{textAlign:'right'}}>Còn có thể trả</th><th style={{textAlign:'right'}}>SL trả</th></tr></thead>
        <tbody>
          {(orderDetail.items||[]).map(it=>{
            const remaining=Number(remainingByItem[it.id]||0);
            return <tr key={it.id}>
              <td>{it.product_name}</td>
              <td style={{textAlign:'right'}}>{formatQtyTrim(it.quantity)}</td>
              <td style={{textAlign:'right'}}>{formatQtyTrim(remaining)}</td>
              <td style={{textAlign:'right'}}>
                <input className="input" style={{maxWidth:100,textAlign:'right'}} type="number" min={0} max={remaining} step="0.001"
                  disabled={remaining<=0}
                  value={lines[it.id]||''} onChange={e=>setLineQty(it.id,e.target.value)}/>
              </td>
            </tr>;
          })}
        </tbody>
      </table>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginTop:16}}>
        <label className="field-label"><span>Lý do trả hàng *</span>
          <select className="select" value={reasonCode} onChange={e=>setReasonCode(e.target.value)}>
            <option value="">-- Chọn lý do --</option>
            {REASON_CODES.map(c=><option key={c} value={c}>{REASON_LABELS[c]}</option>)}
          </select>
        </label>
        <label className="field-label"><span>Ghi chú</span>
          <input className="input" value={reasonNote} onChange={e=>setReasonNote(e.target.value)}/>
        </label>
      </div>
    </>}
  </Dialog>;
}
