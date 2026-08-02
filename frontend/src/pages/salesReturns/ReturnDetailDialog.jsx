import React from'react';
import {Printer}from'lucide-react';
import Dialog from'../../components/common/Dialog';
import {formatQtyTrim}from'../../utils/quantity';

// S9.3R-01 — extracted verbatim from SalesReturns.jsx (was named ViewDialog
// there; renamed to match this file's name). The Approve button, APPROVED
// status label/style, and onApprove/approvingId props have been removed:
// there is no backend /approve route (removed per the locked FS — Manager
// Review is a permission gate on a future receive() action, not a status),
// so an Approve button here would be a dead UI action.
// REASON_LABELS/STATUS_LABELS/STATUS_STYLE/ymd/isoDate are duplicated here
// rather than shared, since no shared-constants module is part of this
// story's scope — SalesReturns.jsx keeps its own copies for its table/print
// output. Reconciling that duplication is out of scope for S9.3R-01. Qty
// formatting uses the existing shared formatQtyTrim() (utils/quantity.js)
// instead of a local reimplementation, since that helper already exists
// and does the identical job.

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

const isoDate=v=>String(v||'').slice(0,10);
const ymd=v=>{
  const raw=isoDate(v);
  const m=raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m?`${m[3]}/${m[2]}/${m[1]}`:raw;
};
function StatusBadge({status}){
  const style=STATUS_STYLE[status]||{background:'#E5E7EB',color:'#374151'};
  return <span style={{...style,padding:'3px 10px',borderRadius:999,fontWeight:700,fontSize:12}}>{STATUS_LABELS[status]||status}</span>;
}

export default function ReturnDetailDialog({detail,onClose,onPrint,canReview,onCancel}){
  if(!detail)return null;
  return <Dialog open={!!detail} title={`Yêu cầu trả hàng ${detail.return_code}`} onClose={onClose} maxWidth={700}
    footer={<>
      <button type="button" className="btn secondary" onClick={onClose}>Đóng</button>
      <button type="button" className="btn secondary" onClick={()=>onPrint(detail)}><Printer size={14}/> In</button>
      {canReview&&detail.status==='REQUESTED'&&<button type="button" className="btn danger" onClick={()=>onCancel(detail)}>Hủy yêu cầu</button>}
    </>}>
    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:16}}>
      <div><b>Khách hàng:</b> {detail.customer_name}</div>
      <div><b>Bill gốc:</b> {detail.order_code}</div>
      <div><b>Trạng thái:</b> <StatusBadge status={detail.status}/></div>
      <div><b>Người tạo:</b> {detail.created_by_name}</div>
      <div><b>Ngày tạo:</b> {ymd(detail.requested_at)}</div>
      <div><b>Lý do:</b> {REASON_LABELS[detail.return_reason_code]||detail.return_reason_code}</div>
    </div>
    {detail.return_reason_note&&<div style={{marginBottom:16}}><b>Ghi chú:</b> {detail.return_reason_note}</div>}
    <table>
      <thead><tr><th>Mặt hàng</th><th style={{textAlign:'right'}}>Số lượng trả</th><th>ĐVT</th></tr></thead>
      <tbody>
        {(detail.items||[]).map(it=>(
          <tr key={it.id}><td>{it.product_name||('#'+it.product_id)}</td><td style={{textAlign:'right'}}>{formatQtyTrim(it.quantity_requested)}</td><td>{it.frozen_unit}</td></tr>
        ))}
      </tbody>
    </table>
  </Dialog>;
}
