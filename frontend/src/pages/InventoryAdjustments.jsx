import React,{useEffect,useState}from'react';
import api from'../api/api';
import SafePage from'../components/SafePage';
import {showSuccess,showError,showWarning}from'../utils/toast';
import {formatQty}from'../utils/quantity';

// S6.6 — standalone Inventory Adjustment. Admin only. Simple by design: one
// form (product, direction, quantity, reason, remark) + a history list of past
// adjustments. No edit/delete — matches "No Reversal" (see backend route).

const REASON_OPTIONS=[
  {value:'BROKEN',label:'Hỏng/Vỡ'},
  {value:'LOST',label:'Mất hàng'},
  {value:'EXPIRED',label:'Hết hạn'},
  {value:'FOUND',label:'Tìm thấy thừa'},
  {value:'STOCK_COUNT',label:'Kiểm kê'},
  {value:'OTHER',label:'Khác'},
];
const REASON_LABEL=Object.fromEntries(REASON_OPTIONS.map(r=>[r.value,r.label]));

const EMPTY_FORM={product_id:'',direction:'INCREASE',quantity:'',reason:'BROKEN',remark:''};

export default function InventoryAdjustments(){
  const[products,setProducts]=useState([]);
  const[productFilter,setProductFilter]=useState('');
  const[form,setForm]=useState(EMPTY_FORM);
  const[saving,setSaving]=useState(false);
  const[history,setHistory]=useState([]);
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState('');

  const loadProducts=async()=>{
    const r=await api.get('/products');
    setProducts((r.data||[]).filter(p=>String(p.inventory_mode||'')==='TRACK_STOCK'));
  };
  const loadHistory=async()=>{
    const r=await api.get('/inventory-adjustments',{params:{limit:100}});
    setHistory(r.data||[]);
  };

  useEffect(()=>{
    (async()=>{
      try{await Promise.all([loadProducts(),loadHistory()]);}
      catch(e){setError(e.response?.data?.message||e.message);}
      finally{setLoading(false);}
    })();
  },[]);

  const reset=()=>setForm(EMPTY_FORM);

  const save=async()=>{
    if(!form.product_id)return showWarning('Chọn mặt hàng cần điều chỉnh');
    const qty=Number(form.quantity);
    if(!(qty>0))return showWarning('Nhập số lượng điều chỉnh lớn hơn 0');
    if(!form.reason)return showWarning('Chọn lý do điều chỉnh');
    try{
      setSaving(true);
      const r=await api.post('/inventory-adjustments',{
        product_id:form.product_id,
        direction:form.direction,
        quantity:qty,
        reason:form.reason,
        remark:form.remark||null,
      });
      showSuccess(`Đã tạo phiếu ${r.data.adjustment_code}. Tồn kho sau điều chỉnh: ${formatQty(r.data.balance_after)}`);
      reset();
      await Promise.all([loadProducts(),loadHistory()]);
    }catch(e){
      showError(e.response?.data?.message||e.message||'Không thể tạo phiếu điều chỉnh');
    }finally{setSaving(false);}
  };

  const filteredProducts=(()=>{
    const q=productFilter.trim().toLowerCase();
    if(!q)return products;
    return products.filter(p=>String(p.name+' '+(p.product_code||'')).toLowerCase().includes(q));
  })();

  return <SafePage loading={loading} error={error}>
    <div className="card">
      <h3>Điều chỉnh tồn kho</h3>
      <p className="muted">Chỉ áp dụng cho mặt hàng có quản lý tồn kho (TRACK_STOCK). Dùng khi hàng hỏng/vỡ, mất, hết hạn, tìm thấy thừa, hoặc sau khi kiểm kê thực tế — độc lập với việc sửa bill.</p>
      <div className="form-grid">
        <input className="input" placeholder="Tìm mặt hàng..." value={productFilter} onChange={e=>setProductFilter(e.target.value)}/>
        <select className="select" value={form.product_id} onChange={e=>setForm({...form,product_id:e.target.value})}>
          <option value="">Chọn mặt hàng *</option>
          {filteredProducts.map(p=><option key={p.id} value={p.id}>{p.name} ({p.product_code}) — tồn: {formatQty(p.stock_quantity)}</option>)}
        </select>
        <select className="select" value={form.direction} onChange={e=>setForm({...form,direction:e.target.value})}>
          <option value="INCREASE">Tăng</option>
          <option value="DECREASE">Giảm</option>
        </select>
        <input className="input" type="number" min={0} step="0.001" placeholder="Số lượng điều chỉnh *" value={form.quantity} onChange={e=>setForm({...form,quantity:e.target.value})}/>
        <select className="select" value={form.reason} onChange={e=>setForm({...form,reason:e.target.value})}>
          {REASON_OPTIONS.map(r=><option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
        <input className="input" placeholder="Ghi chú (tùy chọn)" value={form.remark} onChange={e=>setForm({...form,remark:e.target.value})}/>
      </div>
      <div className="actions" style={{marginTop:12}}>
        <button className="btn" onClick={save} disabled={saving}>{saving?'Đang lưu...':'Tạo phiếu điều chỉnh'}</button>
        <button className="btn secondary" onClick={reset}>Làm mới</button>
      </div>
    </div>

    <div className="card">
      <h3>Lịch sử điều chỉnh</h3>
      <table className="table">
        <thead><tr><th>Số phiếu</th><th>Mặt hàng</th><th>Loại</th><th>Số lượng</th><th>Lý do</th><th>Ghi chú</th><th>Người tạo</th><th>Thời gian</th></tr></thead>
        <tbody>
          {history.map(h=><tr key={h.id}>
            <td><b>{h.adjustment_code}</b></td>
            <td>{h.product_name||`#${h.product_id}`}{h.product_code&&<div className="muted" style={{fontSize:11}}>{h.product_code}</div>}</td>
            <td>{h.direction==='INCREASE'?<span className="pill ok">Tăng</span>:<span className="pill warn">Giảm</span>}</td>
            <td>{formatQty(h.quantity)}</td>
            <td>{REASON_LABEL[h.reason]||h.reason}</td>
            <td>{h.remark||'—'}</td>
            <td>{h.created_by_name||'—'}</td>
            <td>{String(h.created_at||'').slice(0,16).replace('T',' ')}</td>
          </tr>)}
          {!history.length&&<tr><td colSpan={8} className="muted" style={{textAlign:'center',padding:24}}>Chưa có phiếu điều chỉnh nào</td></tr>}
        </tbody>
      </table>
    </div>
  </SafePage>;
}
