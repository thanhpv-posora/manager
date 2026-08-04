import React,{useState}from'react';
import {Printer}from'lucide-react';
import Dialog from'../../components/common/Dialog';
import {formatQtyTrim}from'../../utils/quantity';
import {computeReturnFinalization}from'./returnFinalization';

// S9.3R-01 — extracted verbatim from SalesReturns.jsx (was named ViewDialog
// there; renamed to match this file's name).
// REASON_LABELS/STATUS_LABELS/STATUS_STYLE/ymd/isoDate are duplicated here
// rather than shared, since no shared-constants module is part of this
// story's scope — SalesReturns.jsx keeps its own copies for its table/print
// output. Reconciling that duplication is out of scope for S9.3R-01. Qty
// formatting uses the existing shared formatQtyTrim() (utils/quantity.js)
// instead of a local reimplementation, since that helper already exists
// and does the identical job.
//
// P1-01 (Production Readiness audit finding C1) — this dialog now also
// renders the S9.4 warehouse header/line fields (already returned by
// ReturnAgent.get(), extended additively in the same story to include
// received_by_name/completed_by_name/inspector_name) and the
// Receive/Inspect/Complete/Reject action buttons, mirroring exactly the same
// status-gated set SalesReturns.jsx's grid row already renders — both read
// from the same `detail.status`, so there is exactly one place
// (SalesReturns.jsx's action handlers) that decides what each action does;
// this file only decides when to show the button.

const REASON_LABELS={
  WRONG_ITEM:'Giao sai hàng',
  CUSTOMER_CHANGED_MIND:'Khách đổi ý',
  QUALITY_COMPLAINT:'Khiếu nại chất lượng',
  QUANTITY_ERROR:'Sai số lượng',
  PRICE_DISPUTE:'Tranh chấp giá',
  OTHER:'Khác',
};
// S9.4: kept in sync with SalesReturns.jsx's copy of the same map — see that
// file's comment for why RECEIVED/INSPECTING/COMPLETED/REJECTED exist now.
const STATUS_LABELS={REQUESTED:'Yêu cầu',CANCELLED:'Đã hủy',RECEIVED:'Đã nhận hàng',INSPECTING:'Đang kiểm tra',COMPLETED:'Hoàn tất',REJECTED:'Từ chối'};
const STATUS_STYLE={
  REQUESTED:{background:'#FEF3C7',color:'#92400E'},
  CANCELLED:{background:'#FEE2E2',color:'#991B1B'},
  RECEIVED:{background:'#DBEAFE',color:'#1E40AF'},
  INSPECTING:{background:'#EDE9FE',color:'#5B21B6'},
  COMPLETED:{background:'#D1FAE5',color:'#065F46'},
  REJECTED:{background:'#FEE2E2',color:'#991B1B'},
};
// P1-01: disposition labels for the per-line warehouse result — same 3-value
// closed set InspectDialog.jsx submits (ReturnAgent.js's DISPOSITIONS const).
const DISPOSITION_LABELS={RESTOCK:'Nhập lại kho',PROCESS:'Chuyển xử lý',SCRAP:'Tiêu hủy'};

const isoDate=v=>String(v||'').slice(0,10);
const ymd=v=>{
  const raw=isoDate(v);
  const m=raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m?`${m[3]}/${m[2]}/${m[1]}`:raw;
};
const dt=v=>{
  if(!v)return'';
  const d=new Date(v);
  if(Number.isNaN(d.getTime()))return String(v);
  return `${ymd(v)} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
};
function StatusBadge({status}){
  const style=STATUS_STYLE[status]||{background:'#E5E7EB',color:'#374151'};
  return <span style={{...style,padding:'3px 10px',borderRadius:999,fontWeight:700,fontSize:12}}>{STATUS_LABELS[status]||status}</span>;
}

// Per-line warehouse result block — only rendered once the line has ever been
// received (quantity_received present) or inspected, so a plain REQUESTED
// return's detail view stays exactly as before (no empty warehouse columns).
function LineWarehouseInfo({item}){
  const[showHistory,setShowHistory]=useState(false);
  const inspections=item.inspections||[];
  const hasReceived=Number(item.quantity_received||0)>0||inspections.length>0||!!item.disposition_type;
  if(!hasReceived)return null;
  const latest=inspections.length?inspections[inspections.length-1]:null;
  return <div style={{marginTop:4,fontSize:12,color:'#374151'}}>
    <div style={{display:'flex',flexWrap:'wrap',gap:'4px 14px'}}>
      <span>SL nhận: <b>{formatQtyTrim(item.quantity_received)}</b></span>
      {latest&&<span>SL đạt: <b>{formatQtyTrim(latest.accepted_qty)}</b></span>}
      {latest&&<span>SL loại: <b>{formatQtyTrim(latest.rejected_qty)}</b></span>}
      {item.disposition_type&&<span>Xử lý: <b>{DISPOSITION_LABELS[item.disposition_type]||item.disposition_type}</b></span>}
    </div>
    {/* P1-01A FIX5: inspection_note (this inspection event's own remark) and
        disposition_reason_note (why this disposition was chosen) are
        different fields now — shown separately rather than conflated. */}
    {latest?.inspection_note&&<div style={{color:'#6b7280'}}>Ghi chú kiểm tra: {latest.inspection_note}</div>}
    {item.disposition_reason_note&&<div style={{color:'#6b7280'}}>Lý do phân loại: {item.disposition_reason_note}</div>}
    {latest&&<div style={{color:'#6b7280'}}>Kiểm tra gần nhất: {latest.inspector_name||''} — {dt(latest.inspected_at)}</div>}
    {inspections.length>1&&(
      <div style={{marginTop:2}}>
        <button type="button" className="btn secondary" style={{padding:'2px 8px',fontSize:11}} onClick={()=>setShowHistory(s=>!s)}>
          {showHistory?'Ẩn lịch sử kiểm tra':`Xem lịch sử kiểm tra (${inspections.length})`}
        </button>
        {showHistory&&<ul style={{margin:'4px 0 0',paddingLeft:16}}>
          {inspections.map((insp,i)=>(
            <li key={insp.id||i}>
              Đạt {formatQtyTrim(insp.accepted_qty)} / Loại {formatQtyTrim(insp.rejected_qty)} — {insp.inspector_name||''} — {dt(insp.inspected_at)}
              {insp.inspection_note?` — ${insp.inspection_note}`:''}
            </li>
          ))}
        </ul>}
      </div>
    )}
  </div>;
}

export default function ReturnDetailDialog({detail,onClose,onPrint,canReview,onCancel,onReceive,onInspect,onComplete,onReject,completingId}){
  if(!detail)return null;
  const status=detail.status;
  // P1-01A FIX6: the detail dialog always has `items` loaded (GET
  // /api/sales-returns/:id), so the final-state formula can be computed
  // directly here — no extra fetch needed, unlike the grid row (see
  // SalesReturns.jsx's ensureDetail()+precheck pattern for that case).
  // Backend remains authoritative; this only decides which of Hoàn tất/Từ
  // chối to offer.
  const finalization=status==='INSPECTING'?computeReturnFinalization(detail.items||[]):null;
  return <Dialog open={!!detail} title={`Yêu cầu trả hàng ${detail.return_code}`} onClose={onClose} maxWidth={760}
    footer={<>
      <button type="button" className="btn secondary" onClick={onClose}>Đóng</button>
      <button type="button" className="btn secondary" onClick={()=>onPrint(detail)}><Printer size={14}/> In</button>
      {canReview&&status==='REQUESTED'&&<>
        <button type="button" className="btn secondary" onClick={()=>onReceive(detail)}>Nhận hàng</button>
        <button type="button" className="btn danger" onClick={()=>onCancel(detail)}>Hủy yêu cầu</button>
      </>}
      {canReview&&status==='RECEIVED'&&
        <button type="button" className="btn secondary" onClick={()=>onInspect(detail)}>Bắt đầu kiểm tra / Kiểm hàng</button>}
      {canReview&&status==='INSPECTING'&&<>
        <button type="button" className="btn secondary" onClick={()=>onInspect(detail)}>Chỉnh kết quả kiểm tra</button>
        {finalization?.canComplete&&
          <button type="button" className="btn" disabled={completingId===detail.id} onClick={()=>onComplete(detail)}>Hoàn tất</button>}
        {finalization?.canReject&&
          <button type="button" className="btn danger" onClick={()=>onReject(detail)}>Từ chối</button>}
      </>}
    </>}>
    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:16}}>
      <div><b>Khách hàng:</b> {detail.customer_name}</div>
      <div><b>Bill gốc:</b> {detail.order_code}</div>
      <div><b>Trạng thái:</b> <StatusBadge status={detail.status}/></div>
      <div><b>Người tạo:</b> {detail.created_by_name}</div>
      <div><b>Ngày tạo:</b> {ymd(detail.requested_at)}</div>
      <div><b>Lý do:</b> {REASON_LABELS[detail.return_reason_code]||detail.return_reason_code}</div>
      {detail.received_at&&<div><b>Nhận hàng lúc:</b> {dt(detail.received_at)}{detail.received_by_name?` — ${detail.received_by_name}`:''}</div>}
      {detail.completed_at&&<div><b>Hoàn tất lúc:</b> {dt(detail.completed_at)}{detail.completed_by_name?` — ${detail.completed_by_name}`:''}</div>}
      {detail.rejected_at&&<div><b>Từ chối lúc:</b> {dt(detail.rejected_at)}</div>}
    </div>
    {detail.return_reason_note&&<div style={{marginBottom:16}}><b>Ghi chú:</b> {detail.return_reason_note}</div>}
    <table>
      <thead><tr><th>Mặt hàng</th><th style={{textAlign:'right'}}>Số lượng trả</th><th>ĐVT</th></tr></thead>
      <tbody>
        {(detail.items||[]).map(it=>(
          <tr key={it.id}>
            <td>
              {it.product_name||('#'+it.product_id)}
              <LineWarehouseInfo item={it}/>
            </td>
            <td style={{textAlign:'right',verticalAlign:'top'}}>{formatQtyTrim(it.quantity_requested)}</td>
            <td style={{verticalAlign:'top'}}>{it.frozen_unit}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </Dialog>;
}
