import React,{useEffect,useRef,useState}from'react';
import {Save,Trash2,Plus}from'lucide-react';
import api from'../api/api';
import SafePage from'../components/SafePage';
import MoneyInput from'../components/MoneyInput';
import {moneyVnd}from'../utils/money';
import {showSuccess,showError,showWarning}from'../utils/toast';
import {handlePosInputKeyNavigation}from'../utils/focusNavigation';

const PREF_KEY='product_defaults';
const LOCAL_KEY='meatbiz_product_defaults';
const ADD_NEW_CATEGORY_OPTION='__add_new_category__';
const MANAGE_CATEGORY_OPTION='__manage_category__';

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
    allow_negative_stock:d.allow_negative_stock?1:0,
    is_active:1
  };
}

function pickDefaults(form){
  return {
    category_id:form.category_id||'',
    unit:form.unit||'kg',
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
  const[page,setPage]=useState(1);
  const[pageSize,setPageSize]=useState(20);
  const[showCategoryDialog,setShowCategoryDialog]=useState(false);
  const[categoryForm,setCategoryForm]=useState({name:'',sort_order:0,is_active:1});
  const[savingCategory,setSavingCategory]=useState(false);
  const categorySelectRef=useRef(null);
  const[showManageDialog,setShowManageDialog]=useState(false);
  const[manageCategories,setManageCategories]=useState([]);
  const[manageSelectedId,setManageSelectedId]=useState(null);
  const[manageForm,setManageForm]=useState({name:'',sort_order:0,is_active:1});
  const[manageSaving,setManageSaving]=useState(false);
  const[manageDeleting,setManageDeleting]=useState(false);
  const[manageError,setManageError]=useState('');
  const[manageSearch,setManageSearch]=useState('');
  const currentUser=(()=>{try{return JSON.parse(localStorage.getItem('user')||'{}')}catch{return {}}})();
  const isAdmin=currentUser.role==='ADMIN';

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

  const refreshCategories=async()=>{
    const r=await api.get('/products/categories');
    setCategories(r.data||[]);
  };

  const openCategoryDialog=()=>{
    setCategoryForm({name:'',sort_order:0,is_active:1});
    setShowCategoryDialog(true);
  };

  const closeCategoryDialog=()=>{
    if(savingCategory)return;
    setShowCategoryDialog(false);
    categorySelectRef.current?.focus();
  };

  const saveCategory=async()=>{
    const name=String(categoryForm.name||'').trim();
    if(!name){
      showWarning('Nhập tên danh mục');
      return;
    }
    try{
      setSavingCategory(true);
      const res=await api.post('/products/categories',{
        name,
        sort_order:Number(categoryForm.sort_order)||0,
        is_active:categoryForm.is_active?1:0
      });
      await refreshCategories();
      const newId=res.data?.id;
      if(newId) updateForm({category_id:newId},true);
      showSuccess('Đã thêm danh mục');
      setShowCategoryDialog(false);
      categorySelectRef.current?.focus();
    }catch(e){
      showError(e.response?.data?.message||e.message||'Không thể thêm danh mục');
    }finally{
      setSavingCategory(false);
    }
  };

  const loadManageCategories=async()=>{
    try{
      const r=await api.get('/products/categories?all=1');
      const list=r.data||[];
      setManageCategories(list);
      return list;
    }catch(e){
      setManageError(e.response?.data?.message||e.message||'Không tải được danh sách danh mục');
      return [];
    }
  };

  const openManageDialog=async()=>{
    setManageError('');
    setManageSelectedId(null);
    setManageForm({name:'',sort_order:0,is_active:1});
    setManageSearch('');
    setShowManageDialog(true);
    await loadManageCategories();
  };

  const closeManageDialog=()=>{
    if(manageSaving||manageDeleting)return;
    setShowManageDialog(false);
    categorySelectRef.current?.focus();
  };

  const selectManageCategory=(c)=>{
    setManageSelectedId(c.id);
    setManageForm({name:c.name||'',sort_order:c.sort_order||0,is_active:c.is_active?1:0});
    setManageError('');
  };

  const saveManageCategory=async()=>{
    if(!manageSelectedId)return;
    const name=String(manageForm.name||'').trim();
    if(!name){
      showWarning('Nhập tên danh mục');
      return;
    }
    try{
      setManageSaving(true);
      setManageError('');
      await api.put('/products/categories/'+manageSelectedId,{
        name,
        sort_order:Number(manageForm.sort_order)||0,
        is_active:manageForm.is_active?1:0
      });
      showSuccess('Đã lưu danh mục');
      const list=await loadManageCategories();
      await refreshCategories();
      const updated=list.find(c=>c.id===manageSelectedId);
      if(updated) selectManageCategory(updated);
    }catch(e){
      setManageError(e.response?.data?.message||e.message||'Không thể lưu danh mục');
    }finally{
      setManageSaving(false);
    }
  };

  const deleteManageCategory=async()=>{
    if(!manageSelectedId)return;
    const deletingId=manageSelectedId;
    try{
      setManageDeleting(true);
      setManageError('');
      await api.delete('/products/categories/'+deletingId,{data:{reason:'Xóa qua quản lý danh mục'}});
      showSuccess('Đã xóa danh mục');
      setManageSelectedId(null);
      setManageForm({name:'',sort_order:0,is_active:1});
      await loadManageCategories();
      await refreshCategories();
      if(String(form.category_id)===String(deletingId)) updateForm({category_id:''});
    }catch(e){
      setManageError(e.response?.data?.message||e.message||'Không thể xóa danh mục');
    }finally{
      setManageDeleting(false);
    }
  };

  const categoryOptionsFor=(categoryId,categoryName,allowInactiveFallback)=>{
    if(!allowInactiveFallback||!categoryId)return categories;
    if(categories.some(c=>String(c.id)===String(categoryId)))return categories;
    return [...categories,{id:categoryId,name:`${categoryName||'—'} (Ngừng sử dụng)`}];
  };

  const editingProductRow=editing?rows.find(r=>r.id===editing):null;

  const manageFilteredCategories=manageCategories.filter(c=>{
    const q=String(manageSearch||'').trim().toLowerCase();
    if(!q)return true;
    return String(c.name||'').toLowerCase().includes(q);
  });
  const selectedManageCategory=manageCategories.find(c=>c.id===manageSelectedId);
  const selectedManageProductCount=Number(selectedManageCategory?.product_count||0);
  const canDeleteSelectedManageCategory=isAdmin&&!!manageSelectedId&&selectedManageProductCount===0;

  const filteredRows=rows.filter(x=>{
    const q=String(productSearch||'').trim().toLowerCase();
    if(!q)return true;
    return [
      x.product_code,
      x.name,
      x.barcode,
      x.category_name,
      x.unit,
      x.inventory_mode,
      x.sale_price,
      x.price
    ].some(v=>String(v||'').toLowerCase().includes(q));
  });
  const totalPages=Math.max(1,Math.ceil(filteredRows.length/pageSize));
  const cp=Math.min(page,totalPages);
  const paginated=filteredRows.slice((cp-1)*pageSize,cp*pageSize);

  return <SafePage loading={loading} error={error}>
    <div className="grid cols-2">
      <div className="card">
        <h3>{editing?'Sửa mặt hàng':'Thêm mặt hàng'}</h3>
        <p className="muted">Hệ thống nhớ mặc định theo user: danh mục, đơn vị, âm kho.</p>
        <div className="form-grid">
          <label className="field-label"><span>Mã hàng</span><input className="input" placeholder="Ví dụ: BO0001" value={form.product_code||''} onChange={e=>updateForm({product_code:e.target.value})}/></label>
          <label className="field-label"><span>Tên mặt hàng</span><input className="input" placeholder="Ví dụ: Búp bò, Sườn bò, Vụn..." value={form.name||''} onChange={e=>updateForm({name:e.target.value})}/></label>

          <label className="field-label">
            <span>Danh mục</span>
            <select ref={categorySelectRef} className="select" value={form.category_id||''} onChange={e=>{
              const v=e.target.value;
              if(v===ADD_NEW_CATEGORY_OPTION){openCategoryDialog();return;}
              if(v===MANAGE_CATEGORY_OPTION){openManageDialog();return;}
              updateForm({category_id:v},true);
            }}>
              <option value="">Chọn danh mục</option>
              {categoryOptionsFor(form.category_id,editingProductRow?.category_name,!!editing).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
              <option value={ADD_NEW_CATEGORY_OPTION}>+ Thêm danh mục...</option>
              <option value={MANAGE_CATEGORY_OPTION}>✏ Quản lý danh mục...</option>
            </select>
          </label>

          <label className="field-label"><span>Đơn vị tính</span><input className="input" placeholder="kg / con / cái" value={form.unit||'kg'} onChange={e=>updateForm({unit:e.target.value},true)}/></label>

          <label className="field-label"><span>Giá bán mặc định</span><MoneyInput placeholder="Ví dụ: 120,000" value={form.sale_price??''} onChange={v=>updateForm({sale_price:v})} data-pos-nav="true" onKeyDown={handlePosInputKeyNavigation}/></label>
          <label className="field-label"><span>Giá vốn / giá nhập</span><MoneyInput placeholder="Ví dụ: 90,000" value={form.cost_price??''} onChange={v=>updateForm({cost_price:v})} data-pos-nav="true" onKeyDown={handlePosInputKeyNavigation}/></label>

          <label className="field-label"><span>Tồn kho ban đầu</span><input className="input" placeholder="Ví dụ: 0" value={form.stock_quantity??''} onChange={e=>updateForm({stock_quantity:e.target.value})} inputMode="decimal" data-pos-nav="true" onKeyDown={handlePosInputKeyNavigation}/></label>
          <label className="field-label"><span>Ngưỡng cảnh báo tồn thấp</span><input className="input" placeholder="Ví dụ: 5" value={form.low_stock_threshold??''} onChange={e=>updateForm({low_stock_threshold:e.target.value})} inputMode="decimal" data-pos-nav="true" onKeyDown={handlePosInputKeyNavigation}/></label>

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
          Mặc định hiện tại: danh mục={defaults.category_id||'chưa chọn'}, đơn vị={defaults.unit||'kg'}, âm kho={defaults.allow_negative_stock? 'có':'không'}
        </p>
      </div>

      <div className="card">
        <h3>Agent gợi ý</h3>
        <p className="muted">Khi nhập nhiều mặt hàng cùng danh mục, chỉ cần chọn danh mục/mode một lần. Các lần sau hệ thống tự dùng lại.</p>
      </div>
    </div>

    <div className="card">
      <h3>Danh sách mặt hàng</h3>
      <div style={{marginBottom:12,display:'flex',gap:8,alignItems:'center'}}>
        <input className="input" placeholder="Tìm theo mã, tên, barcode, đơn vị..." value={productSearch} onChange={e=>{setProductSearch(e.target.value);setPage(1);}} style={{maxWidth:420}}/>
        {productSearch&&<button className="btn secondary" onClick={()=>{setProductSearch('');setPage(1);}}>Xóa lọc</button>}
        <span className="muted">{filteredRows.length} mặt hàng</span>
      </div>
      <table className="table product-inline-table">
        <thead><tr><th>Mã</th><th>Tên</th><th>Danh mục</th><th>ĐVT</th><th>Giá bán</th><th></th></tr></thead>
        <tbody>{paginated.map(x=><tr key={x.id}>
          <td>{x.product_code}</td>
          <td><input className="input" value={rowValue(x,'name')} onChange={e=>updateGrid(x.id,{name:e.target.value})}/></td>
          <td>
            <select className="select" value={rowValue(x,'category_id')} onChange={e=>updateGrid(x.id,{category_id:e.target.value})}>
              <option value="">Chọn danh mục</option>
              {categoryOptionsFor(rowValue(x,'category_id'),x.category_name,true).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </td>
          <td><input className="input" value={rowValue(x,'unit')} onChange={e=>updateGrid(x.id,{unit:e.target.value})}/></td>
          <td><MoneyInput value={rowValue(x,'sale_price')} onChange={v=>updateGrid(x.id,{sale_price:v})} data-pos-nav="true" onKeyDown={handlePosInputKeyNavigation}/></td>
          <td>
            <div style={{display:'flex',flexWrap:'nowrap',gap:6,alignItems:'center',justifyContent:'center'}}>
              <button className="btn secondary" title="Lưu" style={{padding:0,width:32,height:32,display:'inline-flex',alignItems:'center',justifyContent:'center'}} onClick={()=>saveGridRow(x)} disabled={!gridEdits[x.id]}><Save size={14}/></button>
              <button className="btn danger" title="Xóa" style={{padding:0,width:32,height:32,display:'inline-flex',alignItems:'center',justifyContent:'center'}} onClick={()=>remove(x)}><Trash2 size={14}/></button>
            </div>
          </td>
        </tr>)}
        {!filteredRows.length&&<tr><td colSpan="6" className="muted">Không tìm thấy mặt hàng phù hợp.</td></tr>}
        </tbody>
      </table>
      <div style={{display:'flex',justifyContent:'flex-end',alignItems:'center',gap:8,marginTop:12,flexWrap:'wrap'}}>
        <span className="muted">Trang {cp} / {totalPages}</span>
        <button className="btn secondary" onClick={()=>setPage(p=>Math.max(1,p-1))} disabled={cp<=1}>Trước</button>
        <button className="btn secondary" onClick={()=>setPage(p=>Math.min(totalPages,p+1))} disabled={cp>=totalPages}>Sau</button>
        <select className="select" value={pageSize} onChange={e=>{setPageSize(Number(e.target.value));setPage(1);}} style={{width:'auto'}}>
          <option value={10}>10 / trang</option>
          <option value={20}>20 / trang</option>
          <option value={50}>50 / trang</option>
          <option value={100}>100 / trang</option>
        </select>
      </div>
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

    {showCategoryDialog&&<div className="app-dialog-backdrop" role="dialog" aria-modal="true">
      <div className="app-dialog">
        <div className="app-dialog-head">
          <div className="app-dialog-icon"><Plus size={18}/></div>
          <div className="app-dialog-title">Thêm danh mục mới</div>
        </div>
        <div className="form-grid">
          <label className="field-label">
            <span>Tên danh mục</span>
            <input
              className="input"
              autoFocus
              placeholder="Ví dụ: Vịt"
              value={categoryForm.name}
              onChange={e=>setCategoryForm(f=>({...f,name:e.target.value}))}
              onKeyDown={e=>{if(e.key==='Escape')closeCategoryDialog();}}
            />
          </label>
          <label className="field-label">
            <span>Thứ tự hiển thị</span>
            <input
              className="input"
              type="number"
              value={categoryForm.sort_order}
              onChange={e=>setCategoryForm(f=>({...f,sort_order:e.target.value}))}
            />
          </label>
          <label className="field-label">
            <span>Trạng thái</span>
            <select className="select" value={categoryForm.is_active} onChange={e=>setCategoryForm(f=>({...f,is_active:Number(e.target.value)}))}>
              <option value={1}>Đang dùng</option>
              <option value={0}>Ngừng dùng</option>
            </select>
          </label>
        </div>
        <div className="app-dialog-actions" style={{marginTop:18}}>
          <button className="app-dialog-btn app-dialog-btn-cancel" onClick={closeCategoryDialog} disabled={savingCategory}>Hủy</button>
          <button className="app-dialog-btn app-dialog-btn-confirm" onClick={saveCategory} disabled={savingCategory}>{savingCategory?'Đang lưu...':'Lưu danh mục'}</button>
        </div>
      </div>
    </div>}

    {showManageDialog&&<div className="app-dialog-backdrop" role="dialog" aria-modal="true">
      <div className="app-dialog" style={{maxWidth:640}}>
        <div className="app-dialog-head">
          <div className="app-dialog-icon">✏</div>
          <div className="app-dialog-title">Quản lý danh mục</div>
        </div>
        {manageError&&<div className="app-dialog-message" style={{color:'#dc2626',margin:'0 0 12px'}}>{manageError}</div>}
        <div style={{display:'flex',gap:16}}>
          <div style={{flex:'0 0 42%'}}>
            <input
              className="input"
              placeholder="Tìm danh mục..."
              value={manageSearch}
              onChange={e=>setManageSearch(e.target.value)}
              style={{marginBottom:8}}
            />
            <div style={{maxHeight:280,overflow:'auto',border:'1px solid #e2e8f0',borderRadius:12}}>
              {manageFilteredCategories.map(c=><div
                key={c.id}
                onClick={()=>selectManageCategory(c)}
                style={{
                  padding:'8px 12px',cursor:'pointer',
                  background:manageSelectedId===c.id?'#eff6ff':'transparent',
                  borderBottom:'1px solid #f1f5f9',
                  display:'flex',justifyContent:'space-between',alignItems:'center',gap:8
                }}
              >
                <span>{c.name} ({Number(c.product_count||0)})</span>
                {!c.is_active&&<span className="muted" style={{fontSize:12}}>Ngừng dùng</span>}
              </div>)}
              {!manageFilteredCategories.length&&<div className="muted" style={{padding:12}}>Không tìm thấy danh mục phù hợp.</div>}
            </div>
          </div>
          <div style={{flex:1}}>
            {manageSelectedId?<>
              <div className="form-grid">
                <label className="field-label">
                  <span>Tên danh mục</span>
                  <input className="input" value={manageForm.name} onChange={e=>setManageForm(f=>({...f,name:e.target.value}))}/>
                </label>
                <label className="field-label">
                  <span>Thứ tự hiển thị</span>
                  <input className="input" type="number" value={manageForm.sort_order} onChange={e=>setManageForm(f=>({...f,sort_order:e.target.value}))}/>
                </label>
                <label className="field-label">
                  <span>Trạng thái</span>
                  <select className="select" value={manageForm.is_active} onChange={e=>setManageForm(f=>({...f,is_active:Number(e.target.value)}))}>
                    <option value={1}>Đang dùng</option>
                    <option value={0}>Ngừng dùng</option>
                  </select>
                </label>
              </div>
              {selectedManageProductCount>0&&
                <p className="muted" style={{marginTop:8,color:'#b45309'}}>
                  Danh mục đang được sử dụng bởi {selectedManageProductCount} mặt hàng.
                </p>
              }
            </>:<p className="muted">Chọn một danh mục bên trái để sửa.</p>}
          </div>
        </div>
        <div className="app-dialog-actions" style={{marginTop:18}}>
          <button className="app-dialog-btn app-dialog-btn-cancel" onClick={closeManageDialog} disabled={manageSaving||manageDeleting}>Đóng</button>
          {isAdmin&&<button className="app-dialog-btn app-dialog-btn-confirm danger" onClick={deleteManageCategory} disabled={!canDeleteSelectedManageCategory||manageSaving||manageDeleting}>{manageDeleting?'Đang xóa...':'Xóa'}</button>}
          <button className="app-dialog-btn app-dialog-btn-confirm" onClick={saveManageCategory} disabled={!manageSelectedId||manageSaving||manageDeleting}>{manageSaving?'Đang lưu...':'Lưu'}</button>
        </div>
      </div>
    </div>}

  </SafePage>
}
