import React,{useEffect,useState}from'react';
import api from'../../api/api';
import Dialog from'../../components/common/Dialog';
import {showSuccess,showError,showWarning}from'../../utils/toast';
import {formatQtyTrim}from'../../utils/quantity';

// P1-01 — Sales Return Warehouse UI: Inspection step.
// Makes POST /api/sales-returns/:id/inspect (ReturnAgent.inspect(), S9.4)
// reachable — both the first inspection call (RECEIVED -> INSPECTING) and any
// repeat call ("Chỉnh kết quả kiểm tra", INSPECTING -> INSPECTING, locked
// rule #3: inspection can be performed multiple times before completion).
// No inventory/debt/payment effect happens here — that only ever happens on
// Complete, per ReturnAgent.complete()'s own comment — so this dialog carries
// no stock warning.
//
// `data` shape: { id, return_code, items:[{ id, product_id, product_name,
// quantity_requested, quantity_received, frozen_unit, disposition_type,
// disposition_reason_note, inspections:[{accepted_qty,rejected_qty,...}] }] }
// — same items array the GET /api/sales-returns/:id detail response already
// returns (ReturnAgent.get()/list()), so no shape translation is needed by
// the caller.
const DISPOSITIONS=['RESTOCK','PROCESS','SCRAP'];
const DISPOSITION_LABELS={RESTOCK:'Nhập lại kho',PROCESS:'Chuyển xử lý',SCRAP:'Tiêu hủy'};

function initialRowState(item){
  const inspections=item.inspections||[];
  const latest=inspections.length?inspections[inspections.length-1]:null;
  return {
    accepted_qty:String(latest?Number(latest.accepted_qty||0):0),
    rejected_qty:String(latest?Number(latest.rejected_qty||0):0),
    disposition:item.disposition_type||'',
    note:item.disposition_reason_note||'',
  };
}

export default function InspectDialog({open,data,onClose,onSaved}){
  const[rows,setRows]=useState({}); // return_item_id -> {accepted_qty,rejected_qty,disposition,note}
  const[saving,setSaving]=useState(false);

  useEffect(()=>{
    if(!open||!data)return;
    const init={};
    for(const it of data.items||[]) init[it.id]=initialRowState(it);
    setRows(init);
  },[open,data]);

  if(!data)return null;

  const setRow=(itemId,patch)=>setRows(r=>({...r,[itemId]:{...r[itemId],...patch}}));

  const save=async()=>{
    if(saving)return;
    const items=data.items||[];
    const payload=[];
    const seen=new Set();
    for(const it of items){
      const row=rows[it.id]||initialRowState(it);
      if(seen.has(it.id)){ showWarning('Dòng hàng bị trùng lặp trong yêu cầu kiểm tra'); return; }
      seen.add(it.id);

      const acceptedQty=Number(row.accepted_qty);
      const rejectedQty=Number(row.rejected_qty);
      if(!Number.isFinite(acceptedQty)||!Number.isFinite(rejectedQty)){
        showWarning(`Số lượng kiểm tra không hợp lệ cho dòng "${it.product_name||('#'+it.product_id)}"`);
        return;
      }
      if(acceptedQty<0||rejectedQty<0){
        showWarning(`Số lượng kiểm tra không được âm ở dòng "${it.product_name||('#'+it.product_id)}"`);
        return;
      }
      const receivedQty=Number(it.quantity_received||0);
      if(acceptedQty+rejectedQty>receivedQty+0.0001){
        showWarning(`Tổng số lượng kiểm tra (${formatQtyTrim(acceptedQty+rejectedQty)}) vượt quá số lượng đã nhận (${formatQtyTrim(receivedQty)}) của dòng "${it.product_name||('#'+it.product_id)}"`);
        return;
      }
      if(acceptedQty>0&&!DISPOSITIONS.includes(row.disposition)){
        showWarning(`Vui lòng chọn phương án xử lý cho dòng "${it.product_name||('#'+it.product_id)}"`);
        return;
      }
      payload.push({
        return_item_id:it.id,
        accepted_qty:acceptedQty,
        rejected_qty:rejectedQty,
        // A disposition is required by the backend on every submitted line
        // (ReturnAgent.inspect() validates DISPOSITIONS.includes(line.disposition)
        // unconditionally), even when accepted_qty is 0 for this line — default
        // to RESTOCK in that case since it has no real effect (complete() only
        // moves stock for return_to_stock_qty, which stays 0 when accepted_qty=0).
        disposition:row.disposition||'RESTOCK',
        note:row.note||null,
      });
    }
    if(!payload.length){ showWarning('Không có dòng hàng nào để kiểm tra'); return; }
    try{
      setSaving(true);
      await api.post(`/sales-returns/${data.id}/inspect`,{items:payload});
      showSuccess('Đã ghi nhận kết quả kiểm tra');
      onSaved();
    }catch(e){ showError(e.response?.data?.message||e.message||'Ghi nhận kiểm tra thất bại'); }
    finally{ setSaving(false); }
  };

  return <Dialog open={open} title={`Kiểm hàng trả ${data.return_code||''}`} onClose={onClose} maxWidth={880}
    primaryAction={{label:'Lưu kết quả kiểm tra',onClick:save,loadingLabel:'Đang lưu...'}} submitting={saving}>
    <table>
      <thead><tr>
        <th>Mặt hàng</th>
        <th style={{textAlign:'right'}}>SL yêu cầu</th>
        <th style={{textAlign:'right'}}>SL đã nhận</th>
        <th style={{textAlign:'right'}}>SL đạt</th>
        <th style={{textAlign:'right'}}>SL loại</th>
        <th>Phương án xử lý</th>
        <th>Ghi chú</th>
      </tr></thead>
      <tbody>
        {(data.items||[]).map(it=>{
          const row=rows[it.id]||initialRowState(it);
          return <tr key={it.id}>
            <td>{it.product_name||('#'+it.product_id)}</td>
            <td style={{textAlign:'right'}}>{formatQtyTrim(it.quantity_requested)}</td>
            <td style={{textAlign:'right'}}>{formatQtyTrim(it.quantity_received)}</td>
            <td style={{textAlign:'right'}}>
              <input className="input" style={{maxWidth:90,textAlign:'right'}} type="number" min={0} step="0.001"
                value={row.accepted_qty} onChange={e=>setRow(it.id,{accepted_qty:e.target.value})}/>
            </td>
            <td style={{textAlign:'right'}}>
              <input className="input" style={{maxWidth:90,textAlign:'right'}} type="number" min={0} step="0.001"
                value={row.rejected_qty} onChange={e=>setRow(it.id,{rejected_qty:e.target.value})}/>
            </td>
            <td>
              <select className="select" style={{minWidth:140}} value={row.disposition} onChange={e=>setRow(it.id,{disposition:e.target.value})}>
                <option value="">-- Chọn --</option>
                {DISPOSITIONS.map(d=><option key={d} value={d}>{DISPOSITION_LABELS[d]}</option>)}
              </select>
            </td>
            <td><input className="input" style={{minWidth:140}} value={row.note} onChange={e=>setRow(it.id,{note:e.target.value})}/></td>
          </tr>;
        })}
        {!(data.items||[]).length&&<tr><td colSpan={7} style={{textAlign:'center',color:'#6b7280'}}>Không có dòng hàng.</td></tr>}
      </tbody>
    </table>
    <div style={{marginTop:12,color:'#6b7280',fontSize:13}}>
      Có thể kiểm tra lại nhiều lần trước khi hoàn tất. Việc nhập lại kho chỉ xảy ra khi bấm "Hoàn tất".
    </div>
  </Dialog>;
}
