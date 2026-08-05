import React,{useEffect,useState,useRef}from'react';
import {Pencil,Trash2,Plus,Eye}from'lucide-react';
import api from'../api/api';
import SafePage from'../components/SafePage';
import Dialog from'../components/common/Dialog';
import {moneyVnd}from'../utils/money';
import {showSuccess,showError,showWarning}from'../utils/toast';

// P2-01 — Supplier Management UI.
//
// Backend audit (SupplierAgent.js + routes/suppliers.js, both pre-existing,
// unchanged by this story):
//   GET    /api/suppliers            -> suppliers()       list, ACTIVE only
//                                        (is_active=1 AND del_flg=0), no
//                                        search/pagination params — the
//                                        endpoint always returns the full
//                                        active list.
//   POST   /api/suppliers            -> addSupplier(data) requires name;
//                                        supplier_code auto-generated
//                                        ('NCC'+timestamp) when omitted;
//                                        is_active is hardcoded 1 server-side
//                                        (not settable at create).
//   PUT    /api/suppliers/:id        -> updateSupplier(id,data) requires
//                                        name; does NOT accept supplier_code
//                                        (immutable after create) or del_flg;
//                                        DOES accept is_active (reactivate/
//                                        deactivate without a full delete).
//   DELETE /api/suppliers/:id        -> removeSupplier(id,reason,userId) ->
//                                        SoftDeleteAgent.softDelete('supplier',...):
//                                        requires a reason, blocks the delete
//                                        server-side if the supplier is still
//                                        referenced by purchase_lots/
//                                        supplier_purchase_options/
//                                        purchase_orders/inventory_receives
//                                        (SoftDeleteAgent's refChecks — not
//                                        modified here), sets del_flg=1 +
//                                        is_active=0 + delete_reason/deleted_at/
//                                        deleted_by, and logs to delete_logs
//                                        (already surfaced generically by the
//                                        existing Trash page's 'supplier'
//                                        entity option — no changes needed
//                                        there).
//   GET    /api/suppliers/:id/beef-prices -> cattle-lot (Bò Xô) price
//                                        resolution, used by Lots.jsx; out of
//                                        scope for this CRUD UI.
// Both list-mutating routes require ADMIN or STAFF (auth(['ADMIN','STAFF']));
// CUSTOMER gets 403 from the backend regardless of this page's own logic —
// matches the pattern already relied on elsewhere in this codebase.
//
// male_price/female_price/fragment_price are part of the existing suppliers
// row schema (used by the separate cattle-lot/Bò Xô flow in Lots.jsx) —
// exposed here as an optional section so a supplier's full existing record
// can be edited from one place, without adding any new backend field or
// business rule.
//
// Search and pagination are client-side over the single GET /api/suppliers
// response (mirrors Customers.jsx's own convention for its "Đối tác" list,
// the closest existing analog) — the backend list endpoint has no
// search/limit/offset params to extend, and this task is frontend-only.

const CALENDAR_LABELS={SOLAR:'Dương lịch',LUNAR:'Âm lịch'};

const EMPTY_FORM={supplier_code:'',name:'',phone:'',address:'',note:'',billing_calendar_type:'SOLAR',male_price:'',female_price:'',fragment_price:'',is_active:1};

export default function Suppliers(){
  const[rows,setRows]=useState([]);
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState('');

  const[search,setSearch]=useState('');
  const[page,setPage]=useState(1);
  const[pageSize,setPageSize]=useState(10);

  const[form,setForm]=useState(EMPTY_FORM);
  const[editing,setEditing]=useState(null); // supplier id | null
  const[dialogOpen,setDialogOpen]=useState(false);
  const[saving,setSaving]=useState(false);

  const[viewing,setViewing]=useState(null); // supplier row | null

  const[pendingDelete,setPendingDelete]=useState(null); // supplier row | null
  const[deleteReason,setDeleteReason]=useState('');
  const[deleting,setDeleting]=useState(false);

  const fieldRefs=useRef([]);
  const handleFormKey=(e,idx)=>{
    const isSelect=e.target.tagName==='SELECT';
    if(e.key==='Enter'||(!isSelect&&e.key==='ArrowDown')){
      e.preventDefault();
      if(idx<fieldRefs.current.length-1) fieldRefs.current[idx+1]?.focus();
      else save();
    } else if(!isSelect&&e.key==='ArrowUp'){
      e.preventDefault();
      if(idx>0) fieldRefs.current[idx-1]?.focus();
    }
  };

  const load=async()=>{
    try{
      setLoading(true);
      const r=await api.get('/suppliers');
      setRows(r.data||[]);
    }catch(e){ setError(e.response?.data?.message||e.message); }
    finally{ setLoading(false); }
  };
  useEffect(()=>{ load(); },[]);

  const reset=()=>{ setEditing(null); setForm(EMPTY_FORM); };

  const openAddDialog=()=>{ reset(); setDialogOpen(true); };
  const openEditDialog=(x)=>{
    setEditing(x.id);
    setForm({
      supplier_code:x.supplier_code||'',
      name:x.name||'',
      phone:x.phone||'',
      address:x.address||'',
      note:x.note||'',
      billing_calendar_type:x.billing_calendar_type||'SOLAR',
      male_price:x.male_price||'',
      female_price:x.female_price||'',
      fragment_price:x.fragment_price||'',
      is_active:x.is_active?1:0,
    });
    setDialogOpen(true);
  };
  const closeDialog=()=>{ if(saving)return; reset(); setDialogOpen(false); };

  const save=async()=>{
    if(saving)return;
    const name=String(form.name||'').trim();
    if(!name){ showWarning('Vui lòng nhập tên nhà cung cấp'); return; }
    const payload={
      name,
      phone:form.phone||'',
      address:form.address||'',
      note:form.note||'',
      billing_calendar_type:form.billing_calendar_type||'SOLAR',
      male_price:Number(form.male_price)||0,
      female_price:Number(form.female_price)||0,
      fragment_price:Number(form.fragment_price)||0,
      is_active:form.is_active?1:0,
    };
    // supplier_code is accepted by addSupplier() (falls back to an
    // auto-generated code when blank) but ignored entirely by updateSupplier()
    // — only sent on create, matching what the backend actually reads.
    if(!editing && String(form.supplier_code||'').trim()) payload.supplier_code=String(form.supplier_code).trim();
    try{
      setSaving(true);
      if(editing) await api.put('/suppliers/'+editing,payload);
      else await api.post('/suppliers',payload);
      showSuccess(editing?'Đã cập nhật nhà cung cấp':'Đã tạo nhà cung cấp');
      reset();
      setDialogOpen(false);
      await load();
    }catch(e){
      showError(e.response?.data?.message||e.message||'Lưu nhà cung cấp thất bại');
    }finally{
      setSaving(false);
    }
  };

  const openView=(x)=>setViewing(x);
  const closeView=()=>setViewing(null);

  const openDelete=(x)=>{ setPendingDelete(x); setDeleteReason(''); };
  const closeDeleteDialog=()=>{ if(deleting)return; setPendingDelete(null); setDeleteReason(''); };
  const confirmDelete=async()=>{
    if(!pendingDelete)return;
    const reason=String(deleteReason||'').trim();
    if(!reason){ showWarning('Vui lòng nhập lý do xóa nhà cung cấp'); return; }
    try{
      setDeleting(true);
      await api.delete('/suppliers/'+pendingDelete.id,{data:{reason}});
      showSuccess('Đã xóa mềm nhà cung cấp');
      setPendingDelete(null);
      setDeleteReason('');
      await load();
    }catch(e){
      // SoftDeleteAgent blocks the delete (400) when the supplier is still
      // referenced by purchase_lots/supplier_purchase_options/purchase_orders/
      // inventory_receives — surfaced here as-is, not re-validated client-side
      // (the reference check itself is out of this story's scope).
      showWarning(e.response?.data?.message||e.message||'Không thể xóa nhà cung cấp');
    }finally{
      setDeleting(false);
    }
  };

  const q=search.toLowerCase().trim();
  const filtered=q?rows.filter(x=>[x.supplier_code,x.name,x.phone,x.address].some(f=>String(f||'').toLowerCase().includes(q))):rows;
  const totalPages=Math.max(1,Math.ceil(filtered.length/pageSize));
  const cp=Math.min(page,totalPages);
  const paginated=filtered.slice((cp-1)*pageSize,cp*pageSize);

  return <SafePage loading={loading} error={error}>
    <div className="card">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16,flexWrap:'wrap',gap:12}}>
        <h2 style={{margin:0}}>Nhà cung cấp</h2>
        <button type="button" className="btn" onClick={openAddDialog}><Plus size={16}/> Thêm nhà cung cấp</button>
      </div>

      <div style={{display:'flex',gap:8,alignItems:'center',marginBottom:16,flexWrap:'wrap'}}>
        <input className="input" placeholder="Tìm theo mã, tên, SĐT, địa chỉ..." value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}} style={{maxWidth:420}}/>
        {search&&<button type="button" className="btn secondary" onClick={()=>{setSearch('');setPage(1);}}>Xóa lọc</button>}
        <span className="muted">{filtered.length} nhà cung cấp</span>
      </div>

      <div style={{overflowX:'auto'}}>
        <table className="table">
          <thead><tr>
            <th>Mã</th><th>Tên</th><th>Liên hệ</th><th>Lịch tính bill</th><th>Trạng thái</th><th></th>
          </tr></thead>
          <tbody>
            {paginated.map(x=>(
              <tr key={x.id}>
                <td>{x.supplier_code}</td>
                <td><b>{x.name}</b>{x.note&&<><br/><span className="muted">{x.note}</span></>}</td>
                <td>{x.phone}{x.address&&<><br/><span className="muted">{x.address}</span></>}</td>
                <td>{CALENDAR_LABELS[x.billing_calendar_type]||x.billing_calendar_type}</td>
                <td>{x.is_active?<span style={{color:'#065F46'}}>Đang hoạt động</span>:<span style={{color:'#991B1B'}}>Ngừng hoạt động</span>}</td>
                <td>
                  <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                    <button type="button" className="btn secondary" title="Xem" onClick={()=>openView(x)}><Eye size={14}/></button>
                    <button type="button" className="btn secondary" title="Sửa" onClick={()=>openEditDialog(x)}><Pencil size={14}/></button>
                    <button type="button" className="btn danger" title="Xóa" onClick={()=>openDelete(x)}><Trash2 size={14}/></button>
                  </div>
                </td>
              </tr>
            ))}
            {!paginated.length&&<tr><td colSpan={6} style={{textAlign:'center',color:'#6b7280'}}>Chưa có nhà cung cấp nào phù hợp.</td></tr>}
          </tbody>
        </table>
      </div>

      <div style={{display:'flex',justifyContent:'flex-end',alignItems:'center',gap:8,marginTop:12,flexWrap:'wrap'}}>
        <span className="muted">Trang {cp} / {totalPages}</span>
        <button type="button" className="btn secondary" onClick={()=>setPage(p=>Math.max(1,p-1))} disabled={cp<=1}>Trước</button>
        <button type="button" className="btn secondary" onClick={()=>setPage(p=>Math.min(totalPages,p+1))} disabled={cp>=totalPages}>Sau</button>
        <select className="select" value={pageSize} onChange={e=>{setPageSize(Number(e.target.value));setPage(1);}} style={{width:'auto'}}>
          <option value={10}>10 / trang</option>
          <option value={20}>20 / trang</option>
          <option value={50}>50 / trang</option>
        </select>
      </div>
    </div>

    <Dialog
      open={dialogOpen}
      title={editing?'Cập nhật nhà cung cấp':'Thêm nhà cung cấp'}
      onClose={closeDialog}
      primaryAction={{label:editing?'Cập nhật':'Thêm nhà cung cấp',onClick:save,loadingLabel:'Đang lưu...'}}
      submitting={saving}
    >
      <div className="form-grid">
        <label className="field-label">
          <span>Mã nhà cung cấp</span>
          <input className="input" placeholder={editing?'':'Bỏ trống để tự sinh mã'} value={form.supplier_code}
            disabled={!!editing}
            onChange={e=>setForm({...form,supplier_code:e.target.value})}
            ref={el=>fieldRefs.current[0]=el} onKeyDown={e=>handleFormKey(e,0)}/>
        </label>
        <label className="field-label">
          <span>Tên nhà cung cấp *</span>
          <input className="input" value={form.name} onChange={e=>setForm({...form,name:e.target.value})}
            ref={el=>fieldRefs.current[1]=el} onKeyDown={e=>handleFormKey(e,1)}/>
        </label>
        <label className="field-label">
          <span>Số điện thoại</span>
          <input className="input" value={form.phone} onChange={e=>setForm({...form,phone:e.target.value})}
            ref={el=>fieldRefs.current[2]=el} onKeyDown={e=>handleFormKey(e,2)}/>
        </label>
        <label className="field-label">
          <span>Địa chỉ</span>
          <input className="input" value={form.address} onChange={e=>setForm({...form,address:e.target.value})}
            ref={el=>fieldRefs.current[3]=el} onKeyDown={e=>handleFormKey(e,3)}/>
        </label>
        <label className="field-label">
          <span>Lịch tính bill</span>
          <select className="select" value={form.billing_calendar_type} onChange={e=>setForm({...form,billing_calendar_type:e.target.value})}
            ref={el=>fieldRefs.current[4]=el} onKeyDown={e=>handleFormKey(e,4)}>
            <option value="SOLAR">Dương lịch</option>
            <option value="LUNAR">Âm lịch</option>
          </select>
        </label>
        <label className="field-label">
          <span>Ghi chú</span>
          <input className="input" value={form.note} onChange={e=>setForm({...form,note:e.target.value})}
            ref={el=>fieldRefs.current[5]=el} onKeyDown={e=>handleFormKey(e,5)}/>
        </label>
        {editing&&(
          <label className="field-label">
            <span>Trạng thái</span>
            <select className="select" value={form.is_active} onChange={e=>setForm({...form,is_active:Number(e.target.value)})}
              ref={el=>fieldRefs.current[6]=el} onKeyDown={e=>handleFormKey(e,6)}>
              <option value={1}>Đang hoạt động</option>
              <option value={0}>Ngừng hoạt động</option>
            </select>
          </label>
        )}
      </div>

      <p className="muted" style={{marginTop:16,marginBottom:8}}>Giá thu mua bò xô (tuỳ chọn — dùng cho nghiệp vụ Nhập xô)</p>
      <div className="form-grid">
        <label className="field-label">
          <span>Giá bò đực</span>
          <input className="input" type="number" min={0} step="0.01" value={form.male_price} onChange={e=>setForm({...form,male_price:e.target.value})}
            ref={el=>fieldRefs.current[7]=el} onKeyDown={e=>handleFormKey(e,7)}/>
        </label>
        <label className="field-label">
          <span>Giá bò cái</span>
          <input className="input" type="number" min={0} step="0.01" value={form.female_price} onChange={e=>setForm({...form,female_price:e.target.value})}
            ref={el=>fieldRefs.current[8]=el} onKeyDown={e=>handleFormKey(e,8)}/>
        </label>
        <label className="field-label">
          <span>Giá thịt vụn</span>
          <input className="input" type="number" min={0} step="0.01" value={form.fragment_price} onChange={e=>setForm({...form,fragment_price:e.target.value})}
            ref={el=>fieldRefs.current[9]=el} onKeyDown={e=>handleFormKey(e,9)}/>
        </label>
      </div>
    </Dialog>

    <Dialog open={!!viewing} title={`Nhà cung cấp ${viewing?.supplier_code||''}`} onClose={closeView} maxWidth={560}>
      {viewing&&<div style={{display:'grid',gap:8}}>
        <div><b>Tên:</b> {viewing.name}</div>
        <div><b>Số điện thoại:</b> {viewing.phone||'—'}</div>
        <div><b>Địa chỉ:</b> {viewing.address||'—'}</div>
        <div><b>Lịch tính bill:</b> {CALENDAR_LABELS[viewing.billing_calendar_type]||viewing.billing_calendar_type}</div>
        <div><b>Trạng thái:</b> {viewing.is_active?'Đang hoạt động':'Ngừng hoạt động'}</div>
        <div><b>Ghi chú:</b> {viewing.note||'—'}</div>
        <div style={{marginTop:8}}><b>Giá thu mua bò xô:</b></div>
        <div>Bò đực: {moneyVnd(viewing.male_price)} · Bò cái: {moneyVnd(viewing.female_price)} · Thịt vụn: {moneyVnd(viewing.fragment_price)}</div>
      </div>}
    </Dialog>

    <Dialog
      open={!!pendingDelete}
      title={`Xóa nhà cung cấp ${pendingDelete?.name||''}`}
      onClose={closeDeleteDialog}
      primaryAction={{label:'Xóa nhà cung cấp',onClick:confirmDelete,loadingLabel:'Đang xóa...'}}
      submitting={deleting}
    >
      <p className="muted">
        Nhà cung cấp sẽ không bị xóa khỏi dữ liệu lịch sử, chỉ ngừng dùng để tạo phiếu mua hàng/nhập xô mới.
        Nếu nhà cung cấp còn phát sinh dữ liệu (lô nhập, phiếu mua hàng, phiếu nhận hàng, quy cách nhập...), hệ thống sẽ từ chối xóa.
      </p>
      <label className="field-label">
        <span>Lý do xóa *</span>
        <textarea className="input" rows={3} autoFocus value={deleteReason} onChange={e=>setDeleteReason(e.target.value)}
          placeholder="VD: nhập trùng, ngừng hợp tác..." style={{resize:'vertical',minHeight:88}}/>
      </label>
    </Dialog>
  </SafePage>;
}
