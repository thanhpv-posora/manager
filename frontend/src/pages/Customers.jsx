import React,{useEffect,useState,useRef}from'react';
import {Pencil,Trash2,Plus,ChevronDown,ChevronRight}from'lucide-react';
import api from'../api/api';
import SafePage from'../components/SafePage';
import {moneyVnd}from'../utils/money';
import {showSuccess,showError,showWarning}from'../utils/toast';
import Dialog from'../components/common/Dialog';

// fix(partner): customers.partner_type is a bitmask — 1=Nhà cung cấp
// (supplier bit), 2=Khách hàng (customer bit), 3=Khách hàng và Nhà cung cấp
// (both). Matches PartnerAgent.listPartners()/InventoryPurchaseAgent.
// _resolvePartner() on the backend, which already read it this way.
const partnerTypeLabel=pt=>pt===3?'Khách hàng & NCC':pt===1?'Nhà cung cấp':'Khách hàng';
const EMPTY_FORM={price_mode:'COMMON_PRICE',billing_calendar_type:'SOLAR',is_active:1,partner_type:2,male_price:'',female_price:'',fragment_price:''};

export default function Customers(){
  const[rows,setRows]=useState([]);
  const[form,setForm]=useState(EMPTY_FORM);
  const[editing,setEditing]=useState(null);
  // Partner Dialog standardization: the Add/Edit form moves into this Dialog.
  // Same form/editing state as before, unchanged — this flag only controls
  // the Dialog's visibility, matching the pattern already used by Products.jsx.
  const[partnerDialogOpen,setPartnerDialogOpen]=useState(false);
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState('');
  const[pendingDelete,setPendingDelete]=useState(null);
  const[deleteReason,setDeleteReason]=useState('');
  const[deleting,setDeleting]=useState(false);
  const[search,setSearch]=useState('');
  const[page,setPage]=useState(1);
  const[pageSize,setPageSize]=useState(10);
  // fix(partner): Bò Xô price section (male_price/female_price/fragment_price,
  // moved here from the removed Suppliers.jsx) — collapsed by default, only
  // relevant when the Partner has the supplier bit set. Same
  // collapsed-by-default UX as Suppliers.jsx's own "Thông tin giá Bò Xô".
  const[bxOpen,setBxOpen]=useState(false);
  const user=JSON.parse(localStorage.getItem('user')||'{}');
  const isCustomer=user.role==='CUSTOMER';

  const isSupplierCapable=(Number(form.partner_type)||2)&1;
  // Last focusable field index depends on whether the Bò Xô section is both
  // eligible (supplier bit set) AND expanded — computed instead of a fixed
  // constant so Enter/ArrowDown on the last VISIBLE field always triggers
  // Save, never a no-op focus() on a field that isn't currently mounted
  // (same fix Suppliers.jsx already needed for this same pattern).
  const lastFieldIndex=()=>(isSupplierCapable&&bxOpen)?11:8;
  const fieldRefs=useRef([]);
  const handleFormKey=(e,idx)=>{
    const isSelect=e.target.tagName==='SELECT';
    if(e.key==='Enter'||(!isSelect&&e.key==='ArrowDown')){
      e.preventDefault();
      if(idx<lastFieldIndex()) fieldRefs.current[idx+1]?.focus();
      else save();
    } else if(!isSelect&&e.key==='ArrowUp'){
      e.preventDefault();
      if(idx>0) fieldRefs.current[idx-1]?.focus();
    }
  };

  const load=async()=>{
    try{
      const r=await api.get('/customers');
      setRows(r.data||[]);
    }catch(e){setError(e.response?.data?.message||e.message)}
    finally{setLoading(false)}
  };

  const loadNextCode=async()=>{
    try{
      const r=await api.get('/customers/next-code');
      setForm(f=>({...f,customer_code:r.data.customer_code}));
    }catch(e){}
  };

  useEffect(()=>{load();loadNextCode()},[]);

  const reset=()=>{setEditing(null);setForm(EMPTY_FORM);setBxOpen(false);loadNextCode()};

  const save=async()=>{
    if(!String(form.name||'').trim()){
      showWarning('Nhập tên khách hàng');
      return;
    }
    // fix(partner): bitmask-aware — required whenever the customer bit is
    // set (partner_type 2 Khách hàng or 3 Khách hàng và Nhà cung cấp), not
    // just the exact old binary "not exactly 1" check.
    if(!editing&&(Number(form.partner_type)&2)===2&&!form.default_sales_flow){
      showWarning('Vui lòng chọn luồng bán hàng mặc định (Bò Xô hoặc Bán hàng kho) cho khách hàng mới');
      return;
    }
    try{
      if(editing) await api.put('/customers/'+editing,form);
      else await api.post('/customers',form);
      showSuccess(editing?'Đã cập nhật đối tác':'Đã tạo đối tác');
      reset();
      // Dialog closes ONLY on successful save — the catch branch below never
      // reaches this line, so a failed save leaves partnerDialogOpen true, the
      // Dialog open, and (since reset() above is also skipped on failure)
      // every entered field exactly as the user left it, with the error toast
      // still visible.
      setPartnerDialogOpen(false);
      await load();
    }catch(e){
      showError(e.response?.data?.message||e.message||'Lưu khách hàng thất bại');
    }
  };

  const edit=x=>{
    setEditing(x.id);
    // fix(partner): pre-fill from the linked supplier's CURRENT saved beef
    // prices (supplier_male_price/... — aliased by CustomerAgent.list()'s
    // LEFT JOIN) rather than leaving them blank, which would otherwise
    // silently zero them out on the next save (_syncPartnerToSupplier always
    // writes whatever is in the form).
    setForm({
      ...x,
      is_active:x.is_active?1:0,
      male_price:x.supplier_male_price||'',
      female_price:x.supplier_female_price||'',
      fragment_price:x.supplier_fragment_price||'',
    });
    setBxOpen(false);
  };

  // Single set of Dialog open/close handlers, reused by both Add and Edit
  // entry points. openAddDialog/openEditDialog only decide which form state
  // to load (reset() vs edit(x), both unchanged) before opening. closeDialog
  // is the one Cancel/Esc/backdrop/X path — it always calls reset() first, so
  // stale edit state can never leak into the next open.
  const openAddDialog=()=>{
    reset();
    setPartnerDialogOpen(true);
  };

  const openEditDialog=x=>{
    edit(x);
    setPartnerDialogOpen(true);
  };

  const closeDialog=()=>{
    reset();
    setPartnerDialogOpen(false);
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

  const confirmDeleteCustomer=async()=>{
    if(!pendingDelete)return;
    const reason=String(deleteReason||'').trim();
    if(!reason){
      showWarning('Vui lòng nhập lý do xóa khách hàng');
      return;
    }
    try{
      setDeleting(true);
      await api.delete('/customers/'+pendingDelete.id,{data:{reason}});
      showSuccess('Đã xóa mềm khách hàng');
      setPendingDelete(null);
      setDeleteReason('');
      await load();
    }catch(e){
      showWarning(e.response?.data?.message||e.message||'Không thể xóa khách hàng');
    }finally{
      setDeleting(false);
    }
  };

  const q=search.toLowerCase().trim();
  const filtered=q?rows.filter(x=>{
    const label=partnerTypeLabel(x.partner_type).toLowerCase();
    return [x.customer_code,x.name,x.phone,x.address].some(f=>String(f||'').toLowerCase().includes(q))||label.includes(q);
  }):rows;
  const totalPages=Math.max(1,Math.ceil(filtered.length/pageSize));
  const cp=Math.min(page,totalPages);
  const paginated=filtered.slice((cp-1)*pageSize,cp*pageSize);

  return <SafePage loading={loading} error={error}>
    <div className="card">
      <h3>Thông tin scope</h3>
      <p className="muted">
        Quy tắc: user chỉ thấy menu admin bật và dữ liệu nằm trong phạm vi customer của user đó.
      </p>
      {isCustomer&&<div className="card" style={{boxShadow:'none',background:'#fff7ed'}}>
        <b>User hiện tại:</b> {user.username}<br/>
        <b>Customer ID:</b> {user.customer_id}<br/>
        <b>Khách tự tạo:</b> lưu dưới dạng khách con.
      </div>}
    </div>

    {/* Master Data Dialog Design System: header/body/footer standardized via
        Dialog's primaryAction/secondaryAction props. "Lấy mã mới" moved
        beside its related field (Mã khách) instead of the generic footer, per
        the contextual-action requirement — same loadNextCode() call, same
        code-generation authority, unchanged. See Products.jsx's "Làm mới"
        audit comment for why that button also moved into the body instead of
        the footer (identical finding applies here: Add-mode convenience vs a
        flagged, unchanged, pre-existing Edit-mode side effect). All form/
        save/reset/edit/loadNextCode/handleFormKey logic is unchanged — only
        the wrapper and footer construction changed. Dialog's built-in header
        "Đóng" button, Esc, and backdrop-click all already route through
        onClose=closeDialog, which resets stale edit state before the next
        open. */}
    <Dialog
      open={partnerDialogOpen}
      title={editing?'Cập nhật đối tác':(isCustomer?'Thêm đối tác riêng của user này':'Thêm đối tác')}
      onClose={closeDialog}
      primaryAction={{label:editing?'Cập nhật đối tác':'Thêm đối tác',onClick:save}}
    >
      <p className="muted">
        {isCustomer?'Khách tạo tại đây sẽ thuộc phạm vi user đang login. User chỉ thấy khách chính và khách con do user tạo.':'Admin thấy toàn bộ khách hàng.'}
      </p>
      <div className="form-grid">
        <div style={{display:'flex',flexDirection:'column',gap:6}}>
          <input className="input" placeholder="Mã khách tự động" value={form.customer_code||''} onChange={e=>setForm({...form,customer_code:e.target.value})} ref={el=>fieldRefs.current[0]=el} onKeyDown={e=>handleFormKey(e,0)}/>
          <button type="button" className="btn tiny secondary" style={{alignSelf:'flex-start'}} onClick={loadNextCode}>Lấy mã mới</button>
        </div>
        <input className="input" placeholder="Tên khách hàng *" value={form.name||''} onChange={e=>setForm({...form,name:e.target.value})} ref={el=>fieldRefs.current[1]=el} onKeyDown={e=>handleFormKey(e,1)}/>
        <input className="input" placeholder="Số điện thoại" value={form.phone||''} onChange={e=>setForm({...form,phone:e.target.value})} ref={el=>fieldRefs.current[2]=el} onKeyDown={e=>handleFormKey(e,2)}/>
        <input className="input" placeholder="Địa chỉ" value={form.address||''} onChange={e=>setForm({...form,address:e.target.value})} ref={el=>fieldRefs.current[3]=el} onKeyDown={e=>handleFormKey(e,3)}/>
        <select className="select" value={form.price_mode||'COMMON_PRICE'} onChange={e=>setForm({...form,price_mode:e.target.value})} ref={el=>fieldRefs.current[4]=el} onKeyDown={e=>handleFormKey(e,4)}>
          <option value="CUSTOM_PRICE">Giá riêng</option>
          <option value="COMMON_PRICE">Giá chung</option>
        </select>
        <select className="select" value={form.billing_calendar_type||'SOLAR'} onChange={e=>setForm({...form,billing_calendar_type:e.target.value})} ref={el=>fieldRefs.current[5]=el} onKeyDown={e=>handleFormKey(e,5)}>
          <option value="SOLAR">Tính bill theo dương lịch</option>
          <option value="LUNAR">Tính bill theo âm lịch</option>
        </select>
        <select className="select" value={form.partner_type||2} onChange={e=>setForm({...form,partner_type:Number(e.target.value)})} ref={el=>fieldRefs.current[6]=el} onKeyDown={e=>handleFormKey(e,6)}>
          <option value={2}>Khách hàng</option>
          <option value={1}>Nhà cung cấp</option>
          <option value={3}>Khách hàng và Nhà cung cấp</option>
        </select>
        <input className="input" placeholder="Ghi chú" value={form.note||''} onChange={e=>setForm({...form,note:e.target.value})} ref={el=>fieldRefs.current[7]=el} onKeyDown={e=>handleFormKey(e,7)}/>
        <label className="field-label">
          <span>Luồng bán hàng mặc định{!editing&&(Number(form.partner_type)&2)===2?' *':''}</span>
          <select className="select" value={form.default_sales_flow||''} onChange={e=>setForm({...form,default_sales_flow:e.target.value||null})} ref={el=>fieldRefs.current[8]=el} onKeyDown={e=>handleFormKey(e,8)}>
            <option value="">-- Chưa phân loại (khách cũ) --</option>
            <option value="CARCASS_POS">Bò Xô (Tạo bill POS)</option>
            <option value="INVENTORY_SALE">Bán hàng kho</option>
          </select>
        </label>
      </div>

      {/* fix(partner): Bò Xô price section, moved here from the removed
          Suppliers.jsx — same collapsed-by-default UX, same fields
          (male_price/female_price/fragment_price), only relevant once the
          Partner has the supplier bit set ((partner_type & 1) === 1). Values
          persist to the linked suppliers row via _syncPartnerToSupplier(). */}
      {isSupplierCapable===1 && <>
        <button type="button" className="btn secondary" onClick={()=>setBxOpen(o=>!o)}
          style={{marginTop:16,display:'inline-flex',alignItems:'center',gap:6}}
          aria-expanded={bxOpen}>
          {bxOpen?<ChevronDown size={14}/>:<ChevronRight size={14}/>}
          Thông tin giá Bò Xô
        </button>
        {bxOpen&&<>
          <p className="muted" style={{marginTop:8,marginBottom:8}}>Tuỳ chọn — dùng cho nghiệp vụ Nhập xô, không bắt buộc.</p>
          <div className="form-grid">
            <label className="field-label">
              <span>Giá bò đực</span>
              <input className="input" type="number" min={0} step="0.01" value={form.male_price} onChange={e=>setForm({...form,male_price:e.target.value})}
                ref={el=>fieldRefs.current[9]=el} onKeyDown={e=>handleFormKey(e,9)}/>
            </label>
            <label className="field-label">
              <span>Giá bò cái</span>
              <input className="input" type="number" min={0} step="0.01" value={form.female_price} onChange={e=>setForm({...form,female_price:e.target.value})}
                ref={el=>fieldRefs.current[10]=el} onKeyDown={e=>handleFormKey(e,10)}/>
            </label>
            <label className="field-label">
              <span>Giá thịt vụn</span>
              <input className="input" type="number" min={0} step="0.01" value={form.fragment_price} onChange={e=>setForm({...form,fragment_price:e.target.value})}
                ref={el=>fieldRefs.current[11]=el} onKeyDown={e=>handleFormKey(e,11)}/>
            </label>
          </div>
        </>}
      </>}

      {/* CTO decision applied here too (same finding as Products.jsx): visible
          only in Add mode, since reset() also clears `editing` and would
          otherwise silently abandon an in-progress edit. PRESENTATION GUARD
          only — reset() itself is unchanged. */}
      {!editing && (
        <div className="actions" style={{marginTop:12}}>
          <button type="button" className="btn secondary" onClick={reset}>Làm mới</button>
        </div>
      )}
    </Dialog>

    <div className="card">
      <h3>Danh sách đối tác</h3>
      <div style={{marginBottom:12,display:'flex',gap:8,alignItems:'center'}}>
        <input className="input" placeholder="Tìm theo mã, tên, SĐT, địa chỉ, loại đối tác..." value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}} style={{maxWidth:420}}/>
        {search&&<button className="btn secondary" onClick={()=>{setSearch('');setPage(1);}}>Xóa lọc</button>}
        <span className="muted">{filtered.length} đối tác</span>
        {/* Single, always-available Add entry point. openAddDialog() calls
            reset() before opening, so it can never inherit stale edit state
            left over from a previous Edit. */}
        <button className="btn" style={{marginLeft:'auto'}} onClick={openAddDialog}><Plus size={14}/> Thêm đối tác</button>
      </div>
      <table className="table">
        <thead><tr><th>Mã</th><th>Tên</th><th>Loại đối tác</th><th>Liên hệ</th><th>Lịch tính bill</th><th>Công nợ</th><th>Thuộc khách</th><th></th></tr></thead>
        <tbody>{paginated.map(x=><tr key={x.id}>
          <td>{x.customer_code}</td>
          <td><b>{x.name}</b><br/><span className="muted">{x.price_mode}</span></td>
          <td>{partnerTypeLabel(x.partner_type)}</td>
          <td>{x.phone}<br/><span className="muted">{x.address}</span></td>
          <td>{x.billing_calendar_type==='LUNAR'?'Âm lịch':'Dương lịch'}</td>
          <td>{moneyVnd(x.current_debt)}</td>
          <td>{x.parent_customer_name||'Khách chính'}</td>
          <td>
            <div style={{display:'flex',flexWrap:'nowrap',gap:6,alignItems:'center',justifyContent:'center'}}>
              <button className="btn secondary" title="Sửa" style={{padding:0,width:32,height:32,display:'inline-flex',alignItems:'center',justifyContent:'center'}} onClick={()=>openEditDialog(x)}><Pencil size={14}/></button>
              {(isCustomer?x.parent_customer_id:1)&&<button className="btn danger" title="Xóa" style={{padding:0,width:32,height:32,display:'inline-flex',alignItems:'center',justifyContent:'center'}} onClick={()=>remove(x)}><Trash2 size={14}/></button>}
            </div>
          </td>
        </tr>)}</tbody>
      </table>
      <div style={{display:'flex',justifyContent:'flex-end',alignItems:'center',gap:8,marginTop:12,flexWrap:'wrap'}}>
        <span className="muted">Trang {cp} / {totalPages}</span>
        <button className="btn secondary" onClick={()=>setPage(p=>Math.max(1,p-1))} disabled={cp<=1}>Trước</button>
        <button className="btn secondary" onClick={()=>setPage(p=>Math.min(totalPages,p+1))} disabled={cp>=totalPages}>Sau</button>
        <select className="select" value={pageSize} onChange={e=>{setPageSize(Number(e.target.value));setPage(1);}} style={{width:'auto'}}>
          <option value={10}>10 / trang</option>
          <option value={20}>20 / trang</option>
        </select>
      </div>
    </div>

    {pendingDelete&&<div className="app-dialog-backdrop" role="dialog" aria-modal="true">
      <div className="app-dialog app-dialog-danger">
        <div className="app-dialog-head">
          <div className="app-dialog-icon">⚠️</div>
          <div className="app-dialog-title">Xóa mềm khách hàng</div>
        </div>
        <div className="app-dialog-message">
          Bạn đang xóa mềm khách hàng <b>{pendingDelete.name||pendingDelete.customer_name||pendingDelete.customer_code||('#'+pendingDelete.id)}</b>.<br/>
          Khách hàng sẽ không bị xóa khỏi dữ liệu lịch sử, nhưng sẽ không còn dùng để tạo bill mới.
        </div>
        <label className="field-label" style={{marginTop:8}}>
          <span>Lý do xóa</span>
          <textarea
            className="input"
            autoFocus
            rows={3}
            placeholder="Ví dụ: nhập nhầm, khách ngừng giao dịch, trùng khách hàng..."
            value={deleteReason}
            onChange={e=>setDeleteReason(e.target.value)}
            onKeyDown={e=>{if(e.key==='Escape')closeDeleteDialog();}}
            style={{resize:'vertical',minHeight:88}}
          />
        </label>
        <div className="app-dialog-actions" style={{marginTop:18}}>
          <button className="app-dialog-btn app-dialog-btn-cancel" onClick={closeDeleteDialog} disabled={deleting}>Hủy</button>
          <button className="app-dialog-btn app-dialog-btn-confirm danger" onClick={confirmDeleteCustomer} disabled={deleting}>{deleting?'Đang xóa...':'Xóa khách hàng'}</button>
        </div>
      </div>
    </div>}
  </SafePage>
}
