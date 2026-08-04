import React,{useEffect,useState}from'react';
import {Plus,Eye,Printer,Ban,PackageCheck,ClipboardList,Pencil,CheckCircle2,XCircle}from'lucide-react';
import api from'../api/api';
import SafePage from'../components/SafePage';
import Dialog from'../components/common/Dialog';
import {showSuccess,showError,showWarning}from'../utils/toast';
import {formatQtyTrim}from'../utils/quantity';
import NewReturnDialog from'./salesReturns/NewReturnDialog';
import ReturnDetailDialog from'./salesReturns/ReturnDetailDialog';
import ReceiveDialog from'./salesReturns/ReceiveDialog';
import InspectDialog from'./salesReturns/InspectDialog';

// S9.3R — Sales Return UI + Business Workflow.
//
// Scope per the locked FS: Customer requests a return, which is either left
// pending (REQUESTED) or withdrawn (-> CANCELLED). Creation still posts to
// the existing POST /api/orders/:id/returns (unchanged); this page adds the
// search/grid (GET /api/sales-returns), detail (GET /api/sales-returns/:id),
// and the Cancel action (POST .../cancel). There is no approve action or
// APPROVED status — Manager Review is a permission gate on the warehouse
// actions below, not a status.
//
// P1-01 (Production Readiness audit finding C1) — the warehouse-facing
// actions the S9.4 backend already implements (ReturnAgent.js
// receive()/inspect()/complete()/reject()) had no UI to trigger them; a
// return could never actually progress past REQUESTED/CANCELLED through the
// app. This page now wires all four actions in, gated to the same
// ADMIN/STAFF set the backend routes already enforce
// (sales-returns.routes.js:32-35) — CUSTOMER still sees Xem/In only, exactly
// as before. No new status is introduced and no inventory/debt/payment rule
// changes: Receive/Inspect still post nothing to stock (ReturnAgent.js's own
// comments on receive()/inspect() are unchanged), and Complete remains the
// only transition that can trigger a RESTOCK stock movement, via the
// existing InventoryService.in() call inside ReturnAgent.complete() —
// nothing about that call was touched here.

const REASON_LABELS={
  WRONG_ITEM:'Giao sai hàng',
  CUSTOMER_CHANGED_MIND:'Khách đổi ý',
  QUALITY_COMPLAINT:'Khiếu nại chất lượng',
  QUANTITY_ERROR:'Sai số lượng',
  PRICE_DISPUTE:'Tranh chấp giá',
  OTHER:'Khác',
};
const REASON_CODES=Object.keys(REASON_LABELS);
// S9.4: RECEIVED/INSPECTING/COMPLETED/REJECTED are real backend statuses
// (ReturnAgent.js receive()/inspect()/complete()/reject()); P1-01 wires the
// grid/detail actions that drive a return through them (see file header).
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

function printReturn(ret){
  const w=window.open('','_blank');
  if(!w)return;
  const rows=(ret.items||[]).map(it=>`
    <tr>
      <td>${it.product_name||('#'+it.product_id)}</td>
      <td style="text-align:right">${formatQtyTrim(it.quantity_requested)}</td>
      <td>${it.frozen_unit||''}</td>
    </tr>`).join('');
  // No financial information (no unit price, no amount, no total) and no
  // inventory information (no stock/warehouse column) anywhere in this
  // printable view, per the story's Print requirement.
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"/><title>Yêu cầu trả hàng ${ret.return_code||''}</title>
    <style>
      body{font-family:Arial,sans-serif;padding:24px;color:#111}
      h1{font-size:20px;margin-bottom:4px}
      table{width:100%;border-collapse:collapse;margin-top:16px}
      th,td{border:1px solid #ccc;padding:8px;font-size:13px}
      th{background:#f3f4f6;text-align:left}
      .meta{margin-top:8px;font-size:13px}
      .meta div{margin-bottom:4px}
    </style></head><body>
    <h1>Yêu cầu trả hàng ${ret.return_code||''}</h1>
    <div class="meta">
      <div><b>Khách hàng:</b> ${ret.customer_name||''}</div>
      <div><b>Bill gốc:</b> ${ret.order_code||''}</div>
      <div><b>Trạng thái:</b> ${STATUS_LABELS[ret.status]||ret.status}</div>
      <div><b>Lý do:</b> ${REASON_LABELS[ret.return_reason_code]||ret.return_reason_code||''}${ret.return_reason_note?' — '+ret.return_reason_note:''}</div>
      <div><b>Người tạo:</b> ${ret.created_by_name||''}</div>
      <div><b>Ngày tạo:</b> ${ymd(ret.requested_at||ret.created_at)}</div>
    </div>
    <table><thead><tr><th>Mặt hàng</th><th style="text-align:right">Số lượng trả</th><th>ĐVT</th></tr></thead>
    <tbody>${rows}</tbody></table>
    </body></html>`);
  w.document.close();
  w.focus();
  setTimeout(()=>{w.print();},300);
}

export default function SalesReturns(){
  const currentUser=(()=>{try{return JSON.parse(localStorage.getItem('user')||'{}')}catch{return {}}})();
  // Cancel/Receive/Inspect/Complete/Reject all share the same ADMIN/STAFF gate
  // as the backend routes (sales-returns.routes.js:29-35) — CUSTOMER keeps
  // Xem/In only, matching auth(['ADMIN','STAFF','CUSTOMER']) on the read
  // routes vs auth(['ADMIN','STAFF']) on every mutation route.
  const canReview=currentUser.role==='ADMIN'||currentUser.role==='STAFF';

  const[rows,setRows]=useState([]);
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState('');
  const[filters,setFilters]=useState({return_code:'',customer:'',status:'',from:'',to:''});

  const[viewDlg,setViewDlg]=useState(null); // { ...return detail } | null
  const[cancelDlg,setCancelDlg]=useState(null); // { id, reason } | null
  const[cancelSaving,setCancelSaving]=useState(false);

  const[receiveDlg,setReceiveDlg]=useState(null); // return detail | null
  const[inspectDlg,setInspectDlg]=useState(null); // return detail | null
  const[rejectDlg,setRejectDlg]=useState(null); // { id, return_code, reason } | null
  const[rejectSaving,setRejectSaving]=useState(false);
  const[completingId,setCompletingId]=useState(null); // return id currently completing, disables its button

  const[newDlgOpen,setNewDlgOpen]=useState(false);

  const load=async()=>{
    try{
      setLoading(true);
      const params={};
      if(filters.return_code)params.return_code=filters.return_code;
      if(filters.customer)params.customer=filters.customer;
      if(filters.status)params.status=filters.status;
      if(filters.from)params.from=filters.from;
      if(filters.to)params.to=filters.to;
      const r=await api.get('/sales-returns',{params});
      setRows(r.data||[]);
    }catch(e){setError(e.response?.data?.message||e.message);}
    finally{setLoading(false);}
  };
  useEffect(()=>{load()},[filters.return_code,filters.customer,filters.status,filters.from,filters.to]);

  const changeFilter=(k,v)=>setFilters(f=>({...f,[k]:v}));

  const doOpenView=async(id)=>{
    try{
      const d=(await api.get('/sales-returns/'+id)).data;
      setViewDlg(d);
    }catch(e){ showError(e.response?.data?.message||e.message); }
  };

  // Grid rows (GET /api/sales-returns) carry header fields only, no `items` —
  // the Receive/Inspect/Complete dialogs need per-line data, so a row opened
  // from the grid is upgraded to a full detail first. A row already opened
  // from the detail dialog (which already has `items`) is reused as-is —
  // avoids a redundant refetch when the action is triggered from there.
  const ensureDetail=async(rowOrDetail)=>{
    if(rowOrDetail&&Array.isArray(rowOrDetail.items))return rowOrDetail;
    return (await api.get('/sales-returns/'+rowOrDetail.id)).data;
  };

  // Reloads the grid, and if the detail dialog is open for this same return,
  // refreshes it too — satisfies "reload list / reload detail" for every
  // warehouse action below.
  const refreshAfterAction=async(returnId)=>{
    await load();
    if(viewDlg&&Number(viewDlg.id)===Number(returnId)){
      try{ setViewDlg((await api.get('/sales-returns/'+returnId)).data); }catch(e){ /* keep stale dialog data over a hard failure here */ }
    }
  };

  const openCancelDlg=(row)=>setCancelDlg({id:row.id,return_code:row.return_code,reason:''});
  const doCancel=async()=>{
    if(!cancelDlg||cancelSaving)return;
    const reason=String(cancelDlg.reason||'').trim();
    if(!reason){ showWarning('Vui lòng nhập lý do hủy yêu cầu trả hàng'); return; }
    if(!await window.appConfirm(`Hủy yêu cầu trả hàng ${cancelDlg.return_code}?`,{title:'Hủy trả hàng',confirmText:'Hủy yêu cầu',cancelText:'Đóng',variant:'danger'}))return;
    try{
      setCancelSaving(true);
      await api.post(`/sales-returns/${cancelDlg.id}/cancel`,{reason});
      showSuccess('Đã hủy yêu cầu trả hàng');
      const cancelledId=cancelDlg.id;
      setCancelDlg(null);
      if(viewDlg&&viewDlg.id===cancelledId)setViewDlg(null);
      await refreshAfterAction(cancelledId);
    }catch(e){ showError(e.response?.data?.message||e.message||'Hủy thất bại'); }
    finally{ setCancelSaving(false); }
  };

  // --- P1-01 warehouse actions ------------------------------------------------

  const openReceive=async(rowOrDetail)=>{
    try{ setReceiveDlg(await ensureDetail(rowOrDetail)); }
    catch(e){ showError(e.response?.data?.message||e.message); }
  };
  const openInspect=async(rowOrDetail)=>{
    try{ setInspectDlg(await ensureDetail(rowOrDetail)); }
    catch(e){ showError(e.response?.data?.message||e.message); }
  };

  const doComplete=async(rowOrDetail)=>{
    if(completingId)return;
    let detail;
    try{ detail=await ensureDetail(rowOrDetail); }
    catch(e){ showError(e.response?.data?.message||e.message); return; }

    // Backend rejects Complete unless every line has a decided disposition
    // (RETURN_INSPECTION_INCOMPLETE) — checked client-side first only to give
    // a clearer warning; the backend re-validates this regardless.
    const undecided=(detail.items||[]).some(it=>!['RESTOCK','PROCESS','SCRAP'].includes(it.disposition_type));
    if(undecided){ showWarning('Cần kiểm tra và quyết định phương án xử lý cho tất cả các dòng hàng trước khi hoàn tất'); return; }

    const restockLines=(detail.items||[]).filter(it=>it.disposition_type==='RESTOCK'&&Number(it.return_to_stock_qty)>0);
    const restockText=restockLines.length
      ? restockLines.map(it=>`${it.product_name||('#'+it.product_id)}: +${formatQtyTrim(it.return_to_stock_qty)} ${it.frozen_unit||''}`).join('\n')
      : 'Không có mặt hàng nào được nhập lại kho ở lần hoàn tất này.';
    const confirmMsg=`Hoàn tất trả hàng ${detail.return_code||''}?\n\nTồn kho sẽ được CỘNG THÊM (nhập lại kho) cho các dòng sau:\n${restockText}\n\nHành động này không thể hoàn tác từ giao diện.`;
    if(!await window.appConfirm(confirmMsg,{title:'Hoàn tất trả hàng',confirmText:'Hoàn tất',cancelText:'Đóng',variant:'danger'}))return;

    try{
      setCompletingId(detail.id);
      await api.post(`/sales-returns/${detail.id}/complete`);
      showSuccess('Đã hoàn tất yêu cầu trả hàng');
      await refreshAfterAction(detail.id);
    }catch(e){ showError(e.response?.data?.message||e.message||'Hoàn tất thất bại'); }
    finally{ setCompletingId(null); }
  };

  const openRejectDlg=(rowOrDetail)=>setRejectDlg({id:rowOrDetail.id,return_code:rowOrDetail.return_code,reason:''});
  const doReject=async()=>{
    if(!rejectDlg||rejectSaving)return;
    const reason=String(rejectDlg.reason||'').trim();
    if(!reason){ showWarning('Vui lòng nhập lý do từ chối'); return; }
    if(!await window.appConfirm(`Từ chối yêu cầu trả hàng ${rejectDlg.return_code}? Sẽ không có thay đổi tồn kho/công nợ.`,{title:'Từ chối trả hàng',confirmText:'Từ chối',cancelText:'Đóng',variant:'danger'}))return;
    try{
      setRejectSaving(true);
      await api.post(`/sales-returns/${rejectDlg.id}/reject`,{reason});
      showSuccess('Đã từ chối yêu cầu trả hàng');
      const rejectedId=rejectDlg.id;
      setRejectDlg(null);
      await refreshAfterAction(rejectedId);
    }catch(e){ showError(e.response?.data?.message||e.message||'Từ chối thất bại'); }
    finally{ setRejectSaving(false); }
  };

  const afterReceiveSaved=async()=>{
    const id=receiveDlg?.id;
    setReceiveDlg(null);
    if(id)await refreshAfterAction(id);
  };
  const afterInspectSaved=async()=>{
    const id=inspectDlg?.id;
    setInspectDlg(null);
    if(id)await refreshAfterAction(id);
  };

  // One shared action-cell renderer for both the grid row and the detail
  // dialog footer, so the two never drift on which action is valid for which
  // status. `row` may be either a grid row (header only) or a full detail —
  // both carry id/return_code/status, which is all this needs.
  const renderActions=(row)=>{
    if(!canReview)return null;
    switch(row.status){
      case 'REQUESTED':
        return <>
          <button type="button" className="btn secondary" title="Nhận hàng" onClick={()=>openReceive(row)}><PackageCheck size={14}/></button>
          <button type="button" className="btn danger" title="Hủy yêu cầu" onClick={()=>openCancelDlg(row)}><Ban size={14}/></button>
        </>;
      case 'RECEIVED':
        return <button type="button" className="btn secondary" title="Bắt đầu kiểm tra / Kiểm hàng" onClick={()=>openInspect(row)}><ClipboardList size={14}/></button>;
      case 'INSPECTING':
        return <>
          <button type="button" className="btn secondary" title="Chỉnh kết quả kiểm tra" onClick={()=>openInspect(row)}><Pencil size={14}/></button>
          <button type="button" className="btn" title="Hoàn tất" disabled={completingId===row.id} onClick={()=>doComplete(row)}><CheckCircle2 size={14}/></button>
          <button type="button" className="btn danger" title="Từ chối" onClick={()=>openRejectDlg(row)}><XCircle size={14}/></button>
        </>;
      default:
        return null; // COMPLETED / REJECTED / CANCELLED — read-only, no mutation action
    }
  };

  return <SafePage loading={loading} error={error}>
    <div className="card">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16,flexWrap:'wrap',gap:12}}>
        <h2 style={{margin:0}}>Trả hàng</h2>
        <button type="button" className="btn" onClick={()=>setNewDlgOpen(true)}>
          <Plus size={16}/> Tạo yêu cầu trả hàng
        </button>
      </div>

      <div style={{display:'flex',gap:10,flexWrap:'wrap',marginBottom:16}}>
        <input className="input" style={{maxWidth:160}} placeholder="Mã trả hàng" value={filters.return_code} onChange={e=>changeFilter('return_code',e.target.value)}/>
        <input className="input" style={{maxWidth:200}} placeholder="Khách hàng" value={filters.customer} onChange={e=>changeFilter('customer',e.target.value)}/>
        <select className="select" style={{maxWidth:160}} value={filters.status} onChange={e=>changeFilter('status',e.target.value)}>
          <option value="">Tất cả trạng thái</option>
          {Object.keys(STATUS_LABELS).map(s=><option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
        </select>
        <input type="date" className="input" style={{maxWidth:160}} value={filters.from} onChange={e=>changeFilter('from',e.target.value)}/>
        <input type="date" className="input" style={{maxWidth:160}} value={filters.to} onChange={e=>changeFilter('to',e.target.value)}/>
      </div>

      <div style={{overflowX:'auto'}}>
        <table>
          <thead><tr>
            <th>Mã trả hàng</th><th>Khách hàng</th><th>Bill gốc</th><th>Trạng thái</th>
            <th>Ngày tạo</th><th>Người tạo</th><th style={{textAlign:'right'}}>Tổng SL</th><th>Lý do</th><th></th>
          </tr></thead>
          <tbody>
            {rows.map(r=>(
              <tr key={r.id}>
                <td>{r.return_code}</td>
                <td>{r.customer_name}</td>
                <td>{r.order_code}</td>
                <td><StatusBadge status={r.status}/></td>
                <td>{ymd(r.requested_at)}</td>
                <td>{r.created_by_name||''}</td>
                <td style={{textAlign:'right'}}>{formatQtyTrim(r.total_qty)}</td>
                <td>{REASON_LABELS[r.return_reason_code]||r.return_reason_code}</td>
                <td>
                  <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                    <button type="button" className="btn secondary" title="Xem" onClick={()=>doOpenView(r.id)}><Eye size={14}/></button>
                    <button type="button" className="btn secondary" title="In" onClick={async()=>{const d=(await api.get('/sales-returns/'+r.id)).data;printReturn(d);}}><Printer size={14}/></button>
                    {renderActions(r)}
                  </div>
                </td>
              </tr>
            ))}
            {!rows.length&&<tr><td colSpan={9} style={{textAlign:'center',color:'#6b7280'}}>Chưa có yêu cầu trả hàng nào.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>

    <ReturnDetailDialog detail={viewDlg} onClose={()=>setViewDlg(null)} onPrint={printReturn}
      canReview={canReview} onCancel={openCancelDlg}
      onReceive={openReceive} onInspect={openInspect} onComplete={doComplete} onReject={openRejectDlg}
      completingId={completingId}/>

    <Dialog open={!!cancelDlg} title={`Hủy yêu cầu trả hàng ${cancelDlg?.return_code||''}`} onClose={()=>setCancelDlg(null)}
      primaryAction={{label:'Hủy yêu cầu',onClick:doCancel}} submitting={cancelSaving}>
      <label className="field-label"><span>Lý do hủy *</span>
        <textarea className="input" rows={3} value={cancelDlg?.reason||''} onChange={e=>setCancelDlg(d=>({...d,reason:e.target.value}))} placeholder="VD: Khách hàng rút yêu cầu"/>
      </label>
    </Dialog>

    <Dialog open={!!rejectDlg} title={`Từ chối yêu cầu trả hàng ${rejectDlg?.return_code||''}`} onClose={()=>setRejectDlg(null)}
      primaryAction={{label:'Từ chối',onClick:doReject}} submitting={rejectSaving}>
      <label className="field-label"><span>Lý do từ chối *</span>
        <textarea className="input" rows={3} value={rejectDlg?.reason||''} onChange={e=>setRejectDlg(d=>({...d,reason:e.target.value}))} placeholder="VD: Hàng không đúng như mô tả trả về"/>
      </label>
    </Dialog>

    <ReceiveDialog open={!!receiveDlg} data={receiveDlg} onClose={()=>setReceiveDlg(null)} onSaved={afterReceiveSaved}/>
    <InspectDialog open={!!inspectDlg} data={inspectDlg} onClose={()=>setInspectDlg(null)} onSaved={afterInspectSaved}/>

    <NewReturnDialog open={newDlgOpen} onClose={()=>setNewDlgOpen(false)} onSaved={()=>{setNewDlgOpen(false);load();}}/>
  </SafePage>;
}
