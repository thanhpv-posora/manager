import React,{useEffect,useState}from'react';
import {Plus,Eye,Printer,Ban}from'lucide-react';
import api from'../api/api';
import SafePage from'../components/SafePage';
import Dialog from'../components/common/Dialog';
import {showSuccess,showError,showWarning}from'../utils/toast';
import {formatQtyTrim}from'../utils/quantity';
import NewReturnDialog from'./salesReturns/NewReturnDialog';
import ReturnDetailDialog from'./salesReturns/ReturnDetailDialog';

// S9.3R — Sales Return UI + Business Workflow.
//
// Scope per the locked FS: Customer requests a return, which is either left
// pending (REQUESTED) or withdrawn (-> CANCELLED). Warehouse has NOT
// received the goods yet at any point in this page — there is no inventory
// increase, no inspection, no disposition, no refund/credit-note, no
// debt/payment reversal anywhere in this file. Creation still posts to the
// existing POST /api/orders/:id/returns (unchanged); this page adds the
// search/grid (GET /api/sales-returns), detail (GET /api/sales-returns/:id),
// and the Cancel action (POST .../cancel) that did not exist before this
// story. There is no approve action or APPROVED status — Manager Review is
// a permission gate on a future receive() action, not a status.

const REASON_LABELS={
  WRONG_ITEM:'Giao sai hàng',
  CUSTOMER_CHANGED_MIND:'Khách đổi ý',
  QUALITY_COMPLAINT:'Khiếu nại chất lượng',
  QUANTITY_ERROR:'Sai số lượng',
  PRICE_DISPUTE:'Tranh chấp giá',
  OTHER:'Khác',
};
const REASON_CODES=Object.keys(REASON_LABELS);
// S9.4: RECEIVED/INSPECTING/COMPLETED/REJECTED are now real backend statuses
// (ReturnAgent.js receive()/inspect()/complete()/reject()) — labels/styles
// added so the existing grid/detail view renders them instead of falling back
// to the raw status string. The warehouse-side UI to actually TRIGGER these
// actions (Receive/Inspect/Complete/Reject) is intentionally NOT built here —
// no UI/UX spec exists for that workflow yet; see PR notes.
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
  const canReview=currentUser.role==='ADMIN'||currentUser.role==='STAFF'; // Cancel — matches backend auth(['ADMIN','STAFF'])

  const[rows,setRows]=useState([]);
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState('');
  const[filters,setFilters]=useState({return_code:'',customer:'',status:'',from:'',to:''});

  const[viewDlg,setViewDlg]=useState(null); // { ...return detail } | null
  const[cancelDlg,setCancelDlg]=useState(null); // { id, reason } | null
  const[cancelSaving,setCancelSaving]=useState(false);

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
      setCancelDlg(null);
      await load();
      if(viewDlg&&viewDlg.id===cancelDlg.id)setViewDlg(null);
    }catch(e){ showError(e.response?.data?.message||e.message||'Hủy thất bại'); }
    finally{ setCancelSaving(false); }
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
                    {canReview&&r.status==='REQUESTED'&&(
                      <button type="button" className="btn danger" title="Hủy yêu cầu" onClick={()=>openCancelDlg(r)}><Ban size={14}/></button>
                    )}
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
      canReview={canReview} onCancel={openCancelDlg}/>

    <Dialog open={!!cancelDlg} title={`Hủy yêu cầu trả hàng ${cancelDlg?.return_code||''}`} onClose={()=>setCancelDlg(null)}
      primaryAction={{label:'Hủy yêu cầu',onClick:doCancel}} submitting={cancelSaving}>
      <label className="field-label"><span>Lý do hủy *</span>
        <textarea className="input" rows={3} value={cancelDlg?.reason||''} onChange={e=>setCancelDlg(d=>({...d,reason:e.target.value}))} placeholder="VD: Khách hàng rút yêu cầu"/>
      </label>
    </Dialog>

    <NewReturnDialog open={newDlgOpen} onClose={()=>setNewDlgOpen(false)} onSaved={()=>{setNewDlgOpen(false);load();}}/>
  </SafePage>;
}
