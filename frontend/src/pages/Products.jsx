import React,{useEffect,useState}from'react';
import api from'../api/api';
import SafePage from'../components/SafePage';
import MoneyInput from'../components/MoneyInput';
import {moneyVnd}from'../utils/money';
import {showSuccess,showError,showWarning}from'../utils/toast';
import {handlePosInputKeyNavigation}from'../utils/focusNavigation';

const PREF_KEY='product_defaults';
const LOCAL_KEY='meatbiz_product_defaults';

function localDefaults(){
  try{return JSON.parse(localStorage.getItem(LOCAL_KEY)||'{}')}catch{return {}}
}

function buildEmptyForm(d={}){
  return {
    product_code:'',
    name:'',
    category_id:d.category_id||'',
    unit:d.unit||'kg',
    sale_price:0,
    cost_price:0,
    stock_quantity:0,
    low_stock_threshold:5,
    inventory_mode:d.inventory_mode||'STOCK',
    allow_negative_stock:d.allow_negative_stock?1:0,
    is_active:1
  };
}

function pickDefaults(form){
  return {
    category_id:form.category_id||'',
    unit:form.unit||'kg',
    inventory_mode:form.inventory_mode||'STOCK',
    allow_negative_stock:form.allow_negative_stock?1:0
  };
}

export default function Products(){
  const[rows,setRows]=useState([]);
  const[categories,setCategories]=useState([]);
  const[defaults,setDefaults]=useState(localDefaults());
  const[form,setForm]=useState(()=>buildEmptyForm(localDefaults()));
  const[editing,setEditing]=useState(null);
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState('');
  const[productSearch,setProductSearch]=useState('');
  const[gridEdits,setGridEdits]=useState({});
  const[pendingDelete,setPendingDelete]=useState(null);
  const[deleteReason,setDeleteReason]=useState('');
  const[deleting,setDeleting]=useState(false);

  const saveDefaults=async(nextDefaults)=>{
    setDefaults(nextDefaults);
    localStorage.setItem(LOCAL_KEY,JSON.stringify(nextDefaults));
    try{await api.post('/preferences/'+PREF_KEY,nextDefaults)}catch(e){}
  };

  const loadDefaults=async()=>{
    try{
      const r=await api.get('/preferences/'+PREF_KEY);
      const d=Object.keys(r.data||{}).length?r.data:localDefaults();
      setDefaults(d);
      localStorage.setItem(LOCAL_KEY,JSON.stringify(d));
      if(!editing)setForm(f=>({...buildEmptyForm(d),product_code:f.product_code||'',name:f.name||''}));
      return d;
    }catch{
      return localDefaults();
    }
  };

  const updateForm=(patch,remember=false)=>{
    const nf={...form,...patch};
    setForm(nf);
    if(remember) saveDefaults(pickDefaults(nf));
  };

  const load=async()=>{
    try{
      const [p,c]=await Promise.all([api.get('/products'),api.get('/products/categories')]);
      setRows(p.data||[]);
      setCategories(c.data||[]);
      await loadDefaults();
    }catch(e){setError(e.response?.data?.message||e.message)}
    finally{setLoading(false)}
  };

  useEffect(()=>{load()},[]);

  const reset=()=>{
    setEditing(null);
    setForm(buildEmptyForm(defaults));
  };

  const save=async()=>{
    if(!String(form.name||'').trim()){
      showWarning('Nhập tên mặt hàng');
      return;
    }
    try{
      await saveDefaults(pickDefaults(form));
      if(editing) await api.put('/products/'+editing,form);
      else await api.post('/products',form);
      showSuccess(editing?'Đã sửa mặt hàng':'Đã thêm mặt hàng');
      reset();
      await load();
    }catch(e){
      showError(e.response?.data?.message||e.message||'Lưu mặt hàng thất bại');
    }
  };

  const edit=x=>{
    setEditing(x.id);
    setForm({...buildEmptyForm(defaults),...x,is_active:x.is_active?1:0,allow_negative_stock:x.allow_negative_stock?1:0});
  };

  const remove=x=>{
    setPendingDelete(x);
    setDeleteReason('');
  };

  const closeDeleteDialog=()=>{
    if(deleting)return;
    setPendingDelete(null);
    setDeleteReason('');
  };

  const confirmDeleteProduct=async()=>{
    if(!pendingDelete)return;
    const reason=String(deleteReason||'').trim();
    if(!reason){
      showWarning('Vui lòng nhập lý do xóa mặt hàng');
      return;
    }
    try{
      setDeleting(true);
      await api.delete('/products/'+pendingDelete.id,{data:{reason}});
      showSuccess('Đã xóa mềm mặt hàng');
      setPendingDelete(null);
      setDeleteReason('');
      await load();
    }catch(e){
      const msg=e.response?.data?.message||e.message||'Không thể xóa mặt hàng';
      showWarning(msg);
    }finally{
      setDeleting(false);
    }
  };

  const rowValue=(x,key)=>{
    const edited=gridEdits[x.id]||{};
    if(Object.prototype.hasOwnProperty.call(edited,key))return edited[key];
    if(key==='sale_price')return x.sale_price??x.default_sale_price??x.price??0;
    if(key==='cost_price')return x.cost_price??x.default_purchase_price??0;
    return x[key]??'';
  };

  const updateGrid=(id,patch)=>setGridEdits(prev=>({...prev,[id]:{...(prev[id]||{}),...patch}}));

  const saveGridRow=async(x)=>{
    const edited=gridEdits[x.id]||{};
    const payload={
      ...x,
      ...edited,
      default_sale_price:edited.sale_price??x.default_sale_price??x.sale_price??x.price??0,
      default_purchase_price:edited.cost_price??x.default_purchase_price??x.cost_price??0,
      sale_price:edited.sale_price??x.sale_price??x.default_sale_price??x.price??0,
      cost_price:edited.cost_price??x.cost_price??x.default_purchase_price??0
    };
    try{
      await api.put('/products/'+x.id,payload);
      showSuccess('Đã lưu mặt hàng trên lưới');
      setGridEdits(prev=>{const n={...prev};delete n[x.id];return n;});
      await load();
    }catch(e){
      showError(e.response?.data?.message||e.message||'Lưu mặt hàng thất bại');
    }
  };

  const filteredRows=rows.filter(x=>{
    const q=String(productSearch||'').trim().toLowerCase();
    if(!q)return true;
    return [
      x.product_code,
      x.name,
      x.category_name,
      x.unit,
      x.inventory_mode,
      x.sale_price,
      x.price
    ].some(v=>String(v||'').toLowerCase().includes(q));
  });

  return <SafePage loading={loading} error={error}>
    <div className="grid cols-2">
      <div className="card">
        <h3>{editing?'Sửa mặt hàng':'Thêm mặt hàng'}</h3>
        <p className="muted">Hệ thống nhớ mặc định theo user: nhóm hàng, đơn vị, kiểu tồn kho, âm kho.</p>
        <div className="form-grid">
          <label className="field-label"><span>Mã hàng</span><input className="input" placeholder="Ví dụ: BO0001" value={form.product_code||''} onChange={e=>updateForm({product_code:e.target.value})}/></label>
          <label className="field-label"><span>Tên mặt hàng</span><input className="input" placeholder="Ví dụ: Búp bò, Sườn bò, Vụn..." value={form.name||''} onChange={e=>updateForm({name:e.target.value})}/></label>

          <label className="field-label"><span>Nhóm hàng</span><select className="select" value={form.category_id||''} onChange={e=>updateForm({category_id:e.target.value},true)}>
            <option value="">Chọn nhóm hàng</option>
            {categories.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
          </select></label>

          <label className="field-label"><span>Đơn vị tính</span><input className="input" placeholder="kg / con / cái" value={form.unit||'kg'} onChange={e=>updateForm({unit:e.target.value},true)}/></label>

          <label className="field-label"><span>Giá bán mặc định</span><MoneyInput placeholder="Ví dụ: 120,000" value={form.sale_price??''} onChange={v=>updateForm({sale_price:v})} data-pos-nav="true" onKeyDown={handlePosInputKeyNavigation}/></label>
          <label className="field-label"><span>Giá vốn / giá nhập</span><MoneyInput placeholder="Ví dụ: 90,000" value={form.cost_price??''} onChange={v=>updateForm({cost_price:v})} data-pos-nav="true" onKeyDown={handlePosInputKeyNavigation}/></label>

          <label className="field-label"><span>Tồn kho ban đầu</span><input className="input" placeholder="Ví dụ: 0" value={form.stock_quantity??''} onChange={e=>updateForm({stock_quantity:e.target.value})} inputMode="decimal" data-pos-nav="true" onKeyDown={handlePosInputKeyNavigation}/></label>
          <label className="field-label"><span>Ngưỡng cảnh báo tồn thấp</span><input className="input" placeholder="Ví dụ: 5" value={form.low_stock_threshold??''} onChange={e=>updateForm({low_stock_threshold:e.target.value})} inputMode="decimal" data-pos-nav="true" onKeyDown={handlePosInputKeyNavigation}/></label>

          <label className="field-label"><span>Kiểu quản tồn kho</span><select className="select" value={form.inventory_mode||'STOCK'} onChange={e=>updateForm({inventory_mode:e.target.value},true)}>
            <option value="STOCK">Quản tồn kho chuẩn: gà/vịt/thịt đông lạnh</option>
            <option value="NON_STOCK">Không quản tồn từng mã: bò xô/nguyên con</option>
            <option value="CARCASS_PART">Phần pha lóc từ bò xô: đùi/búp/nạm...</option>
          </select></label>

          <label className="field-label"><span>Quy tắc âm kho / kiểm tồn</span><select className="select" value={Number(form.allow_negative_stock||0)} onChange={e=>updateForm({allow_negative_stock:Number(e.target.value)},true)}>
            <option value={0}>Không cho âm kho</option>
            <option value={1}>Cho phép không kiểm tồn</option>
          </select></label>
        </div>
        <div className="actions" style={{marginTop:12}}>
          <button className="btn" onClick={save}>{editing?'Lưu sửa':'Thêm hàng'}</button>
          <button className="btn secondary" onClick={reset}>Làm mới</button>
        </div>
        <p className="muted" style={{marginTop:12}}>
          Mặc định hiện tại: nhóm={defaults.category_id||'chưa chọn'}, đơn vị={defaults.unit||'kg'}, mode={defaults.inventory_mode||'STOCK'}, âm kho={defaults.allow_negative_stock? 'có':'không'}
        </p>
      </div>

      <div className="card">
        <h3>Agent gợi ý</h3>
        <p className="muted">Khi nhập nhiều mặt hàng cùng nhóm, chỉ cần chọn nhóm/mode một lần. Các lần sau hệ thống tự dùng lại.</p>
      </div>
    </div>

    <div className="card">
      <div className="product-list-head">
        <div>
          <h3>Danh sách mặt hàng</h3>
          <p className="muted">Tìm theo mã, tên mặt hàng, nhóm hàng, đơn vị, mode hoặc giá.</p>
        </div>
        <input
          className="input product-search-input"
          placeholder="Tìm kiếm mặt hàng..."
          value={productSearch}
          onChange={e=>setProductSearch(e.target.value)}
        />
      </div>
      <table className="table product-inline-table">
        <thead><tr><th>Mã</th><th>Tên</th><th>Nhóm</th><th>ĐVT</th><th>Giá bán</th><th>Mode</th><th></th></tr></thead>
        <tbody>{filteredRows.map(x=><tr key={x.id}>
          <td>{x.product_code}</td>
          <td><input className="input" value={rowValue(x,'name')} onChange={e=>updateGrid(x.id,{name:e.target.value})}/></td>
          <td>
            <select className="select" value={rowValue(x,'category_id')} onChange={e=>updateGrid(x.id,{category_id:e.target.value})}>
              <option value="">Chọn nhóm</option>
              {categories.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </td>
          <td><input className="input" value={rowValue(x,'unit')} onChange={e=>updateGrid(x.id,{unit:e.target.value})}/></td>
          <td><MoneyInput value={rowValue(x,'sale_price')} onChange={v=>updateGrid(x.id,{sale_price:v})} data-pos-nav="true" onKeyDown={handlePosInputKeyNavigation}/></td>
          <td>
            <select className="select" value={rowValue(x,'inventory_mode')} onChange={e=>updateGrid(x.id,{inventory_mode:e.target.value,allow_negative_stock:e.target.value==='STOCK'?0:1})}>
              <option value="STOCK">STOCK</option>
              <option value="NON_STOCK">NON_STOCK</option>
              <option value="CARCASS_PART">CARCASS_PART</option>
            </select>
          </td>
          <td>
            <button className="btn secondary" onClick={()=>saveGridRow(x)} disabled={!gridEdits[x.id]}>Lưu</button>{' '}
            <button className="btn danger" onClick={()=>remove(x)}>Xóa</button>
          </td>
        </tr>)}
        {!filteredRows.length&&<tr><td colSpan="7" className="muted">Không tìm thấy mặt hàng phù hợp.</td></tr>}
        </tbody>
      </table>
    </div>


    {pendingDelete&&<div className="app-dialog-backdrop" role="dialog" aria-modal="true">
      <div className="app-dialog app-dialog-danger">
        <div className="app-dialog-head">
          <div className="app-dialog-icon">⚠️</div>
          <div className="app-dialog-title">Xóa mềm mặt hàng</div>
        </div>
        <div className="app-dialog-message">
          Bạn đang xóa mềm mặt hàng <b>{pendingDelete.name||pendingDelete.product_name||pendingDelete.product_code||('#'+pendingDelete.id)}</b>.<br/>
          Mặt hàng sẽ không bị xóa khỏi dữ liệu lịch sử, nhưng sẽ không còn dùng để tạo bill mới.
        </div>
        <label className="field-label" style={{marginTop:8}}>
          <span>Lý do xóa</span>
          <textarea
            className="input"
            autoFocus
            rows={3}
            placeholder="Ví dụ: nhập nhầm, không còn kinh doanh mặt hàng này..."
            value={deleteReason}
            onChange={e=>setDeleteReason(e.target.value)}
            onKeyDown={e=>{if(e.key==='Escape')closeDeleteDialog();}}
            style={{resize:'vertical',minHeight:88}}
          />
        </label>
        <div className="app-dialog-actions" style={{marginTop:18}}>
          <button className="app-dialog-btn app-dialog-btn-cancel" onClick={closeDeleteDialog} disabled={deleting}>Hủy</button>
          <button className="app-dialog-btn app-dialog-btn-confirm danger" onClick={confirmDeleteProduct} disabled={deleting}>{deleting?'Đang xóa...':'Xóa mặt hàng'}</button>
        </div>
      </div>
    </div>}

  </SafePage>
}
