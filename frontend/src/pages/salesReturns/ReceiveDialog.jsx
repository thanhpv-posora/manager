import React,{useEffect,useState}from'react';
import api from'../../api/api';
import Dialog from'../../components/common/Dialog';
import {showSuccess,showError,showWarning}from'../../utils/toast';
import {formatQtyTrim}from'../../utils/quantity';

// P1-01 — Sales Return Warehouse UI: Receive step (REQUESTED -> RECEIVED).
// Makes POST /api/sales-returns/:id/receive (ReturnAgent.receive(), already
// implemented backend-side, S9.4) reachable from the app. No inventory
// movement happens on this step — only quantity_received is recorded — so
// this dialog carries no stock/financial warning, matching ReturnAgent.js's
// own comment on receive().
//
// `data` shape: { id, return_code, items:[{ id, product_id, product_name,
// quantity_requested, frozen_unit }] } — the caller (SalesReturns.jsx) passes
// the freshly-fetched GET /api/sales-returns/:id detail's own `items` array,
// so return_item_id (sales_return_items.id) always belongs to this return by
// construction; no separate ownership check is needed client-side.
export default function ReceiveDialog({open,data,onClose,onSaved}){
  const[qtyByItem,setQtyByItem]=useState({});
  const[saving,setSaving]=useState(false);

  useEffect(()=>{
    if(!open||!data)return;
    const init={};
    for(const it of data.items||[]) init[it.id]=String(it.quantity_requested??'');
    setQtyByItem(init);
  },[open,data]);

  if(!data)return null;

  const setQty=(itemId,v)=>setQtyByItem(m=>({...m,[itemId]:v}));

  const save=async()=>{
    if(saving)return;
    const items=data.items||[];
    const payload=[];
    for(const it of items){
      const raw=qtyByItem[it.id];
      const receivedQty=Number(raw);
      if(raw===''||raw===undefined||!Number.isFinite(receivedQty)||receivedQty<0){
        showWarning(`Số lượng thực nhận không hợp lệ cho dòng "${it.product_name||('#'+it.product_id)}"`);
        return;
      }
      if(receivedQty>Number(it.quantity_requested)+0.0001){
        showWarning(`Số lượng thực nhận (${formatQtyTrim(receivedQty)}) vượt quá số lượng yêu cầu trả (${formatQtyTrim(it.quantity_requested)}) của dòng "${it.product_name||('#'+it.product_id)}"`);
        return;
      }
      payload.push({return_item_id:it.id,received_qty:receivedQty});
    }
    if(!payload.length){ showWarning('Không có dòng hàng nào để nhận'); return; }
    try{
      setSaving(true);
      await api.post(`/sales-returns/${data.id}/receive`,{items:payload});
      showSuccess('Đã xác nhận nhận hàng trả');
      onSaved();
    }catch(e){ showError(e.response?.data?.message||e.message||'Nhận hàng thất bại'); }
    finally{ setSaving(false); }
  };

  return <Dialog open={open} title={`Nhận hàng trả ${data.return_code||''}`} onClose={onClose} maxWidth={720}
    primaryAction={{label:'Xác nhận nhận hàng',onClick:save,loadingLabel:'Đang lưu...'}} submitting={saving}>
    <table>
      <thead><tr>
        <th>Mặt hàng</th>
        <th style={{textAlign:'right'}}>SL yêu cầu trả</th>
        <th>ĐVT</th>
        <th style={{textAlign:'right'}}>SL thực nhận</th>
      </tr></thead>
      <tbody>
        {(data.items||[]).map(it=>(
          <tr key={it.id}>
            <td>{it.product_name||('#'+it.product_id)}</td>
            <td style={{textAlign:'right'}}>{formatQtyTrim(it.quantity_requested)}</td>
            <td>{it.frozen_unit}</td>
            <td style={{textAlign:'right'}}>
              <input className="input" style={{maxWidth:110,textAlign:'right'}} type="number" min={0}
                max={it.quantity_requested} step="0.001"
                value={qtyByItem[it.id]??''} onChange={e=>setQty(it.id,e.target.value)}/>
            </td>
          </tr>
        ))}
        {!(data.items||[]).length&&<tr><td colSpan={4} style={{textAlign:'center',color:'#6b7280'}}>Không có dòng hàng.</td></tr>}
      </tbody>
    </table>
    <div style={{marginTop:12,color:'#6b7280',fontSize:13}}>
      Bước này chỉ ghi nhận số lượng thực nhận tại kho. Chưa cập nhật tồn kho, chưa ảnh hưởng công nợ/thanh toán.
    </div>
  </Dialog>;
}
