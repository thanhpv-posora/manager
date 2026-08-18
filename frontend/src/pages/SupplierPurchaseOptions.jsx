import React,{useEffect,useMemo,useState,useCallback}from'react';
import {Pencil,Power,PowerOff}from'lucide-react';
import EnterpriseAutocomplete from'../components/common/EnterpriseAutocomplete';
import api from'../api/api';
import SafePage from'../components/SafePage';
import {showSuccess,showError,showWarning}from'../utils/toast';
import {handlePosInputKeyNavigation}from'../utils/focusNavigation';

const EMPTY_FORM={unit_id:'',default_conversion_qty:1,requires_actual_weight:0,display_order:0};
const EMPTY_UNIT_FORM={code:'',name:''};

// Units whose conversion ratio is physically fixed — user cannot override
const FIXED_WEIGHT={'KG':1,'G':0.001,'GRAM':0.001,'TAN':1000,'TON':1000};

const LBL={fontSize:12,fontWeight:600,display:'block',marginBottom:3,color:'#374151'};
const HINT={fontSize:11,lineHeight:1.45,marginTop:3,color:'#6b7280'};
const LINK_BTN={border:'none',background:'none',color:'#2563eb',cursor:'pointer',
  padding:0,fontSize:12,textDecoration:'underline'};

function makeLabel(unitName,convQty){
  const n=Number(convQty);
  return `${unitName||'?'} (${n>0?n:0}kg)`;
}

// A bulk row is only directly editable when it has 0 or 1 existing supplier_purchase_options —
// 2+ existing units are never inline-edited by the fast path (story: "Do not overwrite
// additional existing options silently"), only via the per-product detail dialog.
function toEditableRow(p){
  const spo=p.spo;
  return {
    product_id:p.product_id,
    product_name:p.product_name,
    product_code:p.product_code,
    spo_count:p.spo_count,
    unit_id:spo?String(spo.unit_id):'',
    default_conversion_qty:spo?String(spo.default_conversion_qty):'',
    requires_actual_weight:spo?!!spo.requires_actual_weight:false,
    display_order:spo?Number(spo.display_order):0,
    original:spo?{unit_id:String(spo.unit_id),default_conversion_qty:String(spo.default_conversion_qty),requires_actual_weight:!!spo.requires_actual_weight,display_order:Number(spo.display_order)}:null,
  };
}

function isRowDirty(r){
  if(r.spo_count>=2)return false;
  if(!r.original){
    // Previously unconfigured — "dirty" only once the user has filled in enough to save.
    return !!r.unit_id&&Number(r.default_conversion_qty)>0;
  }
  return String(r.unit_id)!==r.original.unit_id
    ||String(r.default_conversion_qty)!==r.original.default_conversion_qty
    ||!!r.requires_actual_weight!==r.original.requires_actual_weight
    ||Number(r.display_order)!==r.original.display_order;
}

export default function SupplierPurchaseOptions(){
  const[partners,setPartners]=useState([]);
  const[categories,setCategories]=useState([]);
  const[units,setUnits]=useState([]);
  const[partnerId,setPartnerId]=useState('');
  const[categoryId,setCategoryId]=useState('');
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState('');
  const[showAddUnit,setShowAddUnit]=useState(false);
  const[addUnitForm,setAddUnitForm]=useState(EMPTY_UNIT_FORM);
  const[savingUnit,setSavingUnit]=useState(false);

  // ── Bulk table state ──────────────────────────────────────────────────────
  const[bulkRows,setBulkRows]=useState([]);
  const[bulkLoading,setBulkLoading]=useState(false);
  const[catalogSource,setCatalogSource]=useState('');
  const[selectedIds,setSelectedIds]=useState(()=>new Set());
  const[bulkSearch,setBulkSearch]=useState('');
  const[bulkFilter,setBulkFilter]=useState('ALL');
  const[applyUnit,setApplyUnit]=useState('');
  const[applyConv,setApplyConv]=useState('');
  const[applyActualWeight,setApplyActualWeight]=useState(''); // '' = không đổi, '1' = Có, '0' = Không
  const[applyOrderStart,setApplyOrderStart]=useState('');
  const[bulkSaving,setBulkSaving]=useState(false);

  // ── Single-product detail dialog (preserves the existing capability) ─────
  const[detailProduct,setDetailProduct]=useState(null); // {product_id, product_name, product_code} or null
  const[options,setOptions]=useState([]);
  const[form,setForm]=useState(EMPTY_FORM);
  const[editing,setEditing]=useState(null);
  const[loadingOpts,setLoadingOpts]=useState(false);
  const[saving,setSaving]=useState(false);
  const[focused,setFocused]=useState('');

  const reloadUnits=async()=>{
    const r=await api.get('/supplier-purchase-options/units');
    const fresh=r.data||[];
    setUnits(fresh);
    return fresh;
  };

  useEffect(()=>{
    Promise.all([
      api.get('/partners',{params:{role:'supplier'}}),
      api.get('/products/categories'),
      api.get('/supplier-purchase-options/units')
    ]).then(([s,c,u])=>{
      setPartners(s.data||[]);
      setCategories(c.data||[]);
      setUnits(u.data||[]);
    }).catch(e=>setError(e.response?.data?.message||e.message))
    .finally(()=>setLoading(false));
  },[]);

  const loadBulk=useCallback(async(pid,cid)=>{
    if(!pid||!cid){setBulkRows([]);setCatalogSource('');return;}
    setBulkLoading(true);
    try{
      const r=await api.get('/supplier-purchase-options/bulk',{params:{partner_id:pid,category_id:cid}});
      setBulkRows((r.data.products||[]).map(toEditableRow));
      setCatalogSource(r.data.catalog_source||'');
      setSelectedIds(new Set());
    }catch(e){showError(e.response?.data?.message||e.message||'Không tải được danh sách sản phẩm');}
    finally{setBulkLoading(false);}
  },[]);

  useEffect(()=>{loadBulk(partnerId,categoryId);},[partnerId,categoryId,loadBulk]);

  const changePartner=p=>{setPartnerId(p?String(p.id):'');setCategoryId('');};
  const changeCategory=cid=>{setCategoryId(cid);};

  const setRow=(productId,patch)=>{
    setBulkRows(rows=>rows.map(r=>r.product_id===productId?{...r,...patch}:r));
  };

  // ── Selection ──────────────────────────────────────────────────────────
  const filteredRows=useMemo(()=>{
    const q=String(bulkSearch||'').trim().toLowerCase();
    return bulkRows.filter(r=>{
      if(bulkFilter==='UNCONFIGURED'&&r.spo_count!==0)return false;
      if(bulkFilter==='CONFIGURED'&&r.spo_count!==1)return false;
      if(bulkFilter==='MULTI'&&r.spo_count<2)return false;
      if(!q)return true;
      return String(r.product_name||'').toLowerCase().includes(q)||String(r.product_code||'').toLowerCase().includes(q);
    });
  },[bulkRows,bulkSearch,bulkFilter]);

  const selectableVisibleIds=useMemo(()=>filteredRows.filter(r=>r.spo_count<2).map(r=>r.product_id),[filteredRows]);

  const toggleSelect=productId=>{
    setSelectedIds(prev=>{
      const next=new Set(prev);
      if(next.has(productId))next.delete(productId);else next.add(productId);
      return next;
    });
  };
  const selectAllVisible=()=>setSelectedIds(new Set(selectableVisibleIds));
  const clearSelection=()=>setSelectedIds(new Set());

  // ── Apply common values to selected rows (frontend state only, not persisted) ──
  const applyToSelected=()=>{
    if(!selectedIds.size)return showWarning('Chưa chọn dòng nào');
    if(!applyUnit&&!applyConv&&applyActualWeight===''&&!applyOrderStart)
      return showWarning('Chọn ít nhất một giá trị để áp dụng');
    const convNum=applyConv?Number(applyConv):null;
    if(applyConv&&!(convNum>0))return showWarning('Kg quy đổi phải lớn hơn 0');
    const orderStartNum=applyOrderStart!==''?Number(applyOrderStart):null;
    let orderCursor=orderStartNum;
    setBulkRows(rows=>rows.map(r=>{
      if(!selectedIds.has(r.product_id)||r.spo_count>=2)return r;
      const patch={};
      if(applyUnit)patch.unit_id=applyUnit;
      if(convNum!==null)patch.default_conversion_qty=String(convNum);
      if(applyActualWeight!=='')patch.requires_actual_weight=applyActualWeight==='1';
      if(orderCursor!==null){patch.display_order=orderCursor;orderCursor++;}
      return {...r,...patch};
    }));
    showSuccess(`Đã áp dụng cho ${selectedIds.size} dòng đã chọn. Bấm "Lưu tất cả" để lưu xuống database.`);
  };

  // ── Save all changed rows in one batch ──────────────────────────────────
  const saveAllBulk=async()=>{
    const dirtyRows=bulkRows.filter(isRowDirty);
    if(!dirtyRows.length)return showWarning('Không có thay đổi nào để lưu');
    const invalidLocal=dirtyRows.filter(r=>!r.unit_id||!(Number(r.default_conversion_qty)>0));
    if(invalidLocal.length){
      showWarning(`Có ${invalidLocal.length} dòng thiếu đơn vị hoặc kg quy đổi không hợp lệ: ${invalidLocal.map(r=>r.product_name).join(', ')}`);
      return;
    }
    setBulkSaving(true);
    try{
      const payload=dirtyRows.map(r=>({
        product_id:r.product_id,
        product_name:r.product_name,
        unit_id:r.unit_id,
        default_conversion_qty:Number(r.default_conversion_qty),
        requires_actual_weight:r.requires_actual_weight?1:0,
        display_order:Number(r.display_order||0),
      }));
      const res=await api.post('/supplier-purchase-options/bulk',{partner_id:partnerId,category_id:categoryId,rows:payload});
      showSuccess(res.data.message||'Đã lưu');
      await loadBulk(partnerId,categoryId);
    }catch(e){
      showError(e.response?.data?.message||e.message||'Lưu thất bại');
    }finally{
      setBulkSaving(false);
    }
  };

  const dirtyCount=useMemo(()=>bulkRows.filter(isRowDirty).length,[bulkRows]);

  // ── Single-product detail dialog (reuses the original single-item logic) ──
  const loadOptions=useCallback(async(pid_partner,pid_product)=>{
    if(!pid_partner||!pid_product){setOptions([]);return;}
    setLoadingOpts(true);
    try{
      const r=await api.get('/supplier-purchase-options',{params:{partner_id:pid_partner,product_id:pid_product}});
      setOptions(r.data||[]);
    }catch(e){showError(e.response?.data?.message||e.message||'Không tải được quy cách');}
    finally{setLoadingOpts(false);}
  },[]);

  const openDetail=row=>{
    setDetailProduct(row);
    setEditing(null);
    setForm(EMPTY_FORM);
    loadOptions(partnerId,row.product_id);
  };
  const closeDetail=async()=>{
    setDetailProduct(null);
    setOptions([]);
    setEditing(null);
    setForm(EMPTY_FORM);
    await loadBulk(partnerId,categoryId); // reflect any single-item edits back into the bulk table
  };

  const handleUnitChange=uid=>{
    const unit=units.find(u=>String(u.id)===String(uid));
    const fixed=unit?FIXED_WEIGHT[unit.code?.toUpperCase()]:undefined;
    setForm(f=>({...f,unit_id:uid,
      default_conversion_qty:fixed!==undefined?fixed:f.default_conversion_qty}));
  };

  const editRow=x=>{
    setEditing(x.id);
    setForm({unit_id:x.unit_id,default_conversion_qty:x.default_conversion_qty,
      requires_actual_weight:x.requires_actual_weight,display_order:x.display_order});
  };
  const resetForm=()=>{setEditing(null);setForm(EMPTY_FORM);};

  const saveDetail=async()=>{
    if(!partnerId||!detailProduct){showWarning('Chọn nhà cung cấp và sản phẩm');return;}
    if(!form.unit_id){showWarning('Chọn đơn vị');return;}
    const conv=Number(form.default_conversion_qty||0);
    if(conv<=0){showWarning('Quy đổi kg phải lớn hơn 0');return;}
    try{
      setSaving(true);
      if(editing){
        await api.put('/supplier-purchase-options/'+editing,{...form,default_conversion_qty:conv});
        showSuccess('Đã cập nhật quy cách');
      }else{
        await api.post('/supplier-purchase-options',{
          partner_id:partnerId,product_id:detailProduct.product_id,...form,default_conversion_qty:conv
        });
        showSuccess('Đã thêm quy cách');
      }
      resetForm();
      await loadOptions(partnerId,detailProduct.product_id);
    }catch(e){
      showError(e.response?.data?.message||e.message||'Lưu thất bại');
    }finally{setSaving(false);}
  };

  const disableOpt=async x=>{
    const ok=window.appConfirm
      ?await window.appConfirm(`Tắt quy cách "${x.display_label}"?`,
          {title:'Xác nhận tắt quy cách',confirmText:'Tắt',variant:'warning'})
      :window.confirm(`Tắt quy cách "${x.display_label}"?`);
    if(!ok)return;
    try{
      await api.delete('/supplier-purchase-options/'+x.id);
      showSuccess('Đã tắt quy cách');
      await loadOptions(partnerId,detailProduct.product_id);
    }catch(e){showError(e.response?.data?.message||e.message||'Thao tác thất bại');}
  };

  const enableOpt=async x=>{
    try{
      await api.put('/supplier-purchase-options/'+x.id,{
        unit_id:x.unit_id,default_conversion_qty:x.default_conversion_qty,
        requires_actual_weight:x.requires_actual_weight,display_order:x.display_order,is_active:1
      });
      showSuccess('Đã bật quy cách');
      await loadOptions(partnerId,detailProduct.product_id);
    }catch(e){showError(e.response?.data?.message||e.message||'Thao tác thất bại');}
  };

  const saveAddUnit=async()=>{
    const code=String(addUnitForm.code||'').trim().toUpperCase();
    const name=String(addUnitForm.name||'').trim();
    if(!code){showWarning('Nhập mã đơn vị');return;}
    if(!name){showWarning('Nhập tên đơn vị');return;}
    try{
      setSavingUnit(true);
      await api.post('/units',{code,name});
      showSuccess('Đã tạo đơn vị "'+name+'"');
      const fresh=await reloadUnits();
      const created=fresh.find(u=>u.code===code);
      if(created&&detailProduct) setForm(f=>({...f,unit_id:created.id}));
      setShowAddUnit(false);
      setAddUnitForm(EMPTY_UNIT_FORM);
    }catch(e){
      showError(e.response?.data?.message||e.message||'Không tạo được đơn vị');
    }finally{setSavingUnit(false);}
  };

  const selectedUnit=units.find(u=>String(u.id)===String(form.unit_id));
  const convFixed=selectedUnit?FIXED_WEIGHT[selectedUnit.code?.toUpperCase()]!==undefined:false;
  const previewLabel=selectedUnit&&Number(form.default_conversion_qty)>0
    ?makeLabel(selectedUnit.name,form.default_conversion_qty):'';

  const selPartner=partners.find(s=>String(s.id)===String(partnerId));
  const closeAddUnit=()=>{setShowAddUnit(false);setAddUnitForm(EMPTY_UNIT_FORM);};

  return <SafePage loading={loading} error={error}>

    {/* ── Banner ── */}
    <div style={{
      background:'#f0f9ff',border:'1px solid #bae6fd',borderRadius:8,
      padding:'10px 16px',marginBottom:12,fontSize:13,lineHeight:1.6
    }}>
      <b>Cấu hình quy cách nhập</b> — Thiết lập cách nhà cung cấp giao từng sản phẩm.{' '}
      Ví dụ: Thùng = 15kg, Bao = 20kg, Con = 80kg.{' '}
      <span className="muted">Quy cách này chỉ dùng khi lập phiếu nhập hàng. Không tạo tồn kho.</span>
    </div>

    {/* ── Selector ── */}
    <div className="card">
      <h3 style={{marginBottom:12}}>Chọn phạm vi cấu hình</h3>
      <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:12}}>
        <div>
          <label style={LBL}>Nhà cung cấp</label>
          <EnterpriseAutocomplete
            items={partners}
            value={selPartner||null}
            onChange={changePartner}
            placeholder="Tìm nhà cung cấp..."
            displayField="name"
            secondaryFields={['customer_code','phone']}
            searchFields={['name','customer_code','phone']}
            filter={item=>(Number(item.partner_type||0)&1)===1}
            emptyText="Không tìm thấy nhà cung cấp"
            getItemKey={item=>item.id}
            getTooltip={item=>`ID: ${item.id}\nSĐT: ${item.phone||'—'}`}
          />
        </div>
        <div>
          <label style={LBL}>Nhóm hàng</label>
          <select className="select" value={categoryId}
            disabled={!partnerId}
            onChange={e=>changeCategory(e.target.value)}>
            <option value="">Chọn nhóm hàng...</option>
            {categories.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
      </div>
    </div>

    {/* ── Empty states ── */}
    {!partnerId&&(
      <div className="card" style={{textAlign:'center',padding:'28px 24px'}}>
        <p className="muted">Vui lòng chọn nhà cung cấp.</p>
      </div>
    )}
    {partnerId&&!categoryId&&(
      <div className="card" style={{textAlign:'center',padding:'28px 24px'}}>
        <p className="muted">Vui lòng chọn nhóm hàng.</p>
      </div>
    )}

    {/* ── Bulk table ── */}
    {partnerId&&categoryId&&<div className="card">
      {bulkLoading&&<p className="muted">Đang tải danh sách sản phẩm...</p>}
      {!bulkLoading&&bulkRows.length===0&&(
        <div style={{textAlign:'center',padding:'28px 0'}}>
          <p className="muted" style={{marginBottom:4}}>
            Nhà cung cấp này chưa có danh mục sản phẩm cho nhóm hàng đã chọn.
          </p>
          <p className="muted" style={{fontSize:13}}>
            Vui lòng cấu hình <b>Bảng giá riêng NCC</b> (Price Matrix) hoặc liên kết sản phẩm với nhà cung cấp trước khi cấu hình quy cách nhập.
          </p>
        </div>
      )}
      {!bulkLoading&&bulkRows.length>0&&<>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10,flexWrap:'wrap',gap:8}}>
          <h3 style={{margin:0}}>Cấu hình hàng loạt ({bulkRows.length} sản phẩm{catalogSource?` · nguồn: ${catalogSource==='PRICE_BOOK'?'Bảng giá NCC':catalogSource==='SUPPLIER_LINKS'?'Liên kết NCC':catalogSource}`:''})</h3>
        </div>

        {/* Search + filter */}
        <div className="actions" style={{marginBottom:10,alignItems:'center'}}>
          <input className="input" style={{maxWidth:300}} placeholder="Tìm theo tên hoặc mã sản phẩm..." value={bulkSearch} onChange={e=>setBulkSearch(e.target.value)}/>
          <select className="select" style={{width:180}} value={bulkFilter} onChange={e=>setBulkFilter(e.target.value)}>
            <option value="ALL">Tất cả</option>
            <option value="UNCONFIGURED">Chưa cấu hình</option>
            <option value="CONFIGURED">Đã cấu hình</option>
            <option value="MULTI">Có nhiều đơn vị</option>
          </select>
          <span className="muted">{filteredRows.length}/{bulkRows.length} sản phẩm · Đã chọn {selectedIds.size} · {dirtyCount} dòng thay đổi</span>
          <button className="btn secondary" onClick={selectAllVisible}>Chọn tất cả</button>
          <button className="btn secondary" onClick={clearSelection}>Bỏ chọn</button>
        </div>

        {/* Apply common values panel */}
        <div style={{background:'#f9fafb',border:'1px solid #e5e7eb',borderRadius:8,padding:10,marginBottom:10}}>
          <div style={{fontSize:12,fontWeight:600,marginBottom:8,color:'#374151'}}>Áp dụng giá trị chung cho dòng đã chọn</div>
          <div className="actions" style={{alignItems:'center'}}>
            <select className="select" style={{width:160}} value={applyUnit} onChange={e=>setApplyUnit(e.target.value)}>
              <option value="">Đơn vị nhập: không đổi</option>
              {units.map(u=><option key={u.id} value={u.id}>{u.name} ({u.code})</option>)}
            </select>
            <input className="input" style={{width:130}} type="number" min={0.001} step={0.001} placeholder="Kg quy đổi" value={applyConv} onChange={e=>setApplyConv(e.target.value)}/>
            <select className="select" style={{width:170}} value={applyActualWeight} onChange={e=>setApplyActualWeight(e.target.value)}>
              <option value="">Cân thực tế: không đổi</option>
              <option value="1">Bắt buộc cân thực tế: Có</option>
              <option value="0">Bắt buộc cân thực tế: Không</option>
            </select>
            <input className="input" style={{width:150}} type="number" min={0} placeholder="Thứ tự bắt đầu (tuỳ chọn)" value={applyOrderStart} onChange={e=>setApplyOrderStart(e.target.value)}/>
            <button className="btn" onClick={applyToSelected}>Áp dụng cho dòng đã chọn</button>
          </div>
        </div>

        <table className="table">
          <thead>
            <tr>
              <th>Chọn</th><th>Sản phẩm</th><th>Mã sản phẩm</th>
              <th>Đơn vị nhập</th><th>Kg quy đổi</th><th>Bắt buộc cân thực tế</th>
              <th>Thứ tự</th><th>Trạng thái</th><th>Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map(r=>{
              const multi=r.spo_count>=2;
              return <tr key={r.product_id}>
                <td>
                  <input type="checkbox" disabled={multi}
                    checked={selectedIds.has(r.product_id)}
                    onChange={()=>toggleSelect(r.product_id)}/>
                </td>
                <td><b>{r.product_name}</b></td>
                <td>{r.product_code}</td>
                <td>
                  {multi
                    ?<span className="muted">—</span>
                    :<select className="select" style={{minWidth:120}} value={r.unit_id}
                        data-pos-nav="true" onKeyDown={handlePosInputKeyNavigation}
                        onChange={e=>setRow(r.product_id,{unit_id:e.target.value})}>
                        <option value="">-- Chọn --</option>
                        {units.map(u=><option key={u.id} value={u.id}>{u.name} ({u.code})</option>)}
                      </select>}
                </td>
                <td>
                  {multi
                    ?<span className="muted">—</span>
                    :<input className="input" style={{width:90}} type="number" min={0.001} step={0.001}
                        value={r.default_conversion_qty}
                        data-pos-nav="true" onKeyDown={handlePosInputKeyNavigation}
                        onChange={e=>setRow(r.product_id,{default_conversion_qty:e.target.value})}/>}
                </td>
                <td style={{textAlign:'center'}}>
                  {multi
                    ?<span className="muted">—</span>
                    :<input type="checkbox" checked={!!r.requires_actual_weight}
                        onChange={e=>setRow(r.product_id,{requires_actual_weight:e.target.checked})}/>}
                </td>
                <td>
                  {multi
                    ?<span className="muted">—</span>
                    :<input className="input" style={{width:70}} type="number" min={0}
                        value={r.display_order}
                        data-pos-nav="true" onKeyDown={handlePosInputKeyNavigation}
                        onChange={e=>setRow(r.product_id,{display_order:Number(e.target.value)||0})}/>}
                </td>
                <td>
                  {r.spo_count===0&&<span className="badge" style={{background:'#f3f4f6',color:'#6b7280'}}>Chưa cấu hình</span>}
                  {r.spo_count===1&&<span className="badge" style={{background:'#dcfce7',color:'#166534'}}>Đã cấu hình</span>}
                  {multi&&<span className="badge" style={{background:'#fef3c7',color:'#92400e'}}>Có {r.spo_count} đơn vị</span>}
                  {isRowDirty(r)&&<span className="badge" style={{background:'#dbeafe',color:'#1e40af',marginLeft:4}}>Chưa lưu</span>}
                </td>
                <td>
                  <button className="btn secondary" style={{fontSize:12}} onClick={()=>openDetail(r)}>
                    {multi?'Xem / chỉnh nhiều đơn vị':'+ Thêm đơn vị'}
                  </button>
                </td>
              </tr>;
            })}
          </tbody>
        </table>

        <div className="actions" style={{marginTop:12}}>
          <button className="btn" onClick={saveAllBulk} disabled={bulkSaving||!dirtyCount}>
            {bulkSaving?'Đang lưu...':`Lưu tất cả (${dirtyCount} dòng thay đổi)`}
          </button>
        </div>
      </>}
    </div>}

    {/* ── Single-product detail dialog (preserves the existing single-item capability) ── */}
    {detailProduct&&(
      <div className="app-dialog-backdrop" role="dialog" aria-modal="true">
        <div className="app-dialog" style={{maxWidth:720,width:'90%'}}>
          <div className="app-dialog-head">
            <div className="app-dialog-title">{selPartner?.name} › {detailProduct.product_name}</div>
          </div>
          <div className="app-dialog-message" style={{textAlign:'left'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:10}}>
              <h3 style={{margin:0}}>{editing?'Sửa quy cách':'Thêm quy cách mới'}</h3>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'10px 20px'}}>
              <div>
                <label style={LBL}>Đơn vị tính</label>
                <select className="select" value={form.unit_id}
                  onFocus={()=>setFocused('unit')}
                  onBlur={()=>setFocused('')}
                  onChange={e=>handleUnitChange(e.target.value)}>
                  <option value="">Ví dụ: Kg, Thùng, Bao, Con...</option>
                  {units.map(u=><option key={u.id} value={u.id}>{u.name} ({u.code})</option>)}
                </select>
                {focused==='unit'&&(<p style={HINT}>Đơn vị nhà cung cấp dùng khi giao hàng.</p>)}
                <div style={{marginTop:5,fontSize:12,color:'#6b7280'}}>
                  Không có đơn vị?{' '}
                  <button type="button" style={LINK_BTN}
                    onClick={()=>{setAddUnitForm(EMPTY_UNIT_FORM);setShowAddUnit(true);}}>
                    Tạo mới
                  </button>
                </div>
              </div>
              <div>
                <label style={LBL}>Khối lượng mặc định (kg)</label>
                <input className="input" type="number" placeholder="Ví dụ: 15"
                  value={form.default_conversion_qty}
                  min={0.001} step={0.001}
                  readOnly={convFixed}
                  style={convFixed?{background:'#f3f4f6',cursor:'not-allowed',color:'#6b7280'}:{}}
                  onFocus={()=>setFocused('conversion')}
                  onBlur={()=>setFocused('')}
                  onChange={e=>{if(!convFixed)setForm({...form,default_conversion_qty:e.target.value});}}/>
                {focused==='conversion'&&!convFixed&&(<p style={HINT}>Ví dụ: 1 Thùng = 15kg</p>)}
                {convFixed&&(<p style={HINT}>Giá trị cố định theo loại đơn vị, không thể sửa.</p>)}
              </div>
              <div>
                <label style={LBL}>Thứ tự hiển thị</label>
                <input className="input" type="number" placeholder="Ví dụ: 1"
                  value={form.display_order} min={0}
                  onFocus={()=>setFocused('order')}
                  onBlur={()=>setFocused('')}
                  onChange={e=>setForm({...form,display_order:Number(e.target.value)||0})}/>
                {focused==='order'&&(<p style={HINT}>Số nhỏ hiển thị trước. Dùng khi có nhiều quy cách cho một sản phẩm.</p>)}
              </div>
              <div style={{paddingTop:18}}>
                <label style={{display:'flex',alignItems:'flex-start',gap:8,cursor:'pointer'}}>
                  <input type="checkbox" style={{marginTop:2}} checked={!!form.requires_actual_weight}
                    onChange={e=>setForm({...form,requires_actual_weight:e.target.checked?1:0})}/>
                  <span>
                    <span style={{fontSize:12,fontWeight:600,color:'#374151'}}>Bắt buộc cân thực tế</span>
                    <span style={{...HINT,display:'block',marginTop:1}}>
                      Nếu bật, phải nhập kg thực tế khi tạo lô. Tắt để dùng kg quy đổi mặc định.
                    </span>
                  </span>
                </label>
              </div>
            </div>

            {previewLabel&&(
              <div style={{marginTop:12,padding:'7px 12px',background:'#f0f9ff',borderRadius:6,border:'1px solid #bae6fd',fontSize:13}}>
                Tên hiển thị: <b>{previewLabel}</b>
              </div>
            )}

            <div className="actions" style={{marginTop:12}}>
              <button className="btn" onClick={saveDetail} disabled={saving}>
                {saving?'Đang lưu...':(editing?'Lưu sửa':'Thêm quy cách')}
              </button>
              <button className="btn secondary" onClick={resetForm}>Hủy / Làm mới</button>
            </div>

            <h3 style={{marginTop:20}}>Quy cách nhập hàng ({options.length})</h3>
            {loadingOpts&&<p className="muted">Đang tải...</p>}
            {!loadingOpts&&(
              <table className="table">
                <thead>
                  <tr>
                    <th>Tên hiển thị</th><th>Đơn vị</th><th>Kg/đơn vị</th>
                    <th>Cân thực</th><th>Thứ tự</th><th>Trạng thái</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {options.map(x=>(
                    <tr key={x.id} style={x.is_active?{}:{opacity:0.5}}>
                      <td><b>{x.display_label}</b></td>
                      <td>{x.unit_name} ({x.unit_code})</td>
                      <td>{x.default_conversion_qty}</td>
                      <td>{x.requires_actual_weight?'Có':'—'}</td>
                      <td>{x.display_order}</td>
                      <td>
                        <span className="badge" style={x.is_active?{background:'#dcfce7',color:'#166534'}:{background:'#f3f4f6',color:'#6b7280'}}>
                          {x.is_active?'Đang dùng':'Tắt'}
                        </span>
                      </td>
                      <td>
                        <div style={{display:'flex',flexWrap:'nowrap',gap:6,alignItems:'center',justifyContent:'center'}}>
                          <button className="btn secondary" title="Sửa" style={{padding:0,width:32,height:32,display:'inline-flex',alignItems:'center',justifyContent:'center'}} onClick={()=>editRow(x)}><Pencil size={14}/></button>
                          {x.is_active
                            ?<button className="btn danger" title="Tắt" style={{padding:0,width:32,height:32,display:'inline-flex',alignItems:'center',justifyContent:'center'}} onClick={()=>disableOpt(x)}><PowerOff size={14}/></button>
                            :<button className="btn secondary" title="Bật" style={{padding:0,width:32,height:32,display:'inline-flex',alignItems:'center',justifyContent:'center'}} onClick={()=>enableOpt(x)}><Power size={14}/></button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {options.length===0&&(
                    <tr><td colSpan={7} style={{textAlign:'center',padding:'28px 0'}}>
                      <p className="muted">Chưa có quy cách nhập cho sản phẩm này.</p>
                    </td></tr>
                  )}
                </tbody>
              </table>
            )}
          </div>
          <div className="app-dialog-actions">
            <button className="app-dialog-btn app-dialog-btn-cancel" onClick={closeDetail}>Đóng</button>
          </div>
        </div>
      </div>
    )}

    {/* ── Quick Add Unit dialog ── */}
    {showAddUnit&&(
      <div className="app-dialog-backdrop" role="dialog" aria-modal="true">
        <div className="app-dialog">
          <div className="app-dialog-head">
            <div className="app-dialog-title">Thêm đơn vị mới</div>
          </div>
          <div className="app-dialog-message" style={{textAlign:'left'}}>
            <p className="muted" style={{marginBottom:12,fontSize:13}}>
              Sau khi tạo, đơn vị sẽ tự động được chọn trong form.
            </p>
            <div style={{marginBottom:10}}>
              <label style={LBL}>Mã đơn vị</label>
              <input className="input" placeholder="Ví dụ: THUNG (tự động viết HOA)"
                autoFocus
                value={addUnitForm.code}
                onChange={e=>setAddUnitForm({...addUnitForm,code:e.target.value.toUpperCase()})}
                onKeyDown={e=>{if(e.key==='Escape')closeAddUnit();}}/>
            </div>
            <div>
              <label style={LBL}>Tên đơn vị</label>
              <input className="input" placeholder="Ví dụ: Thùng"
                value={addUnitForm.name}
                onChange={e=>setAddUnitForm({...addUnitForm,name:e.target.value})}
                onKeyDown={e=>{if(e.key==='Enter')saveAddUnit();if(e.key==='Escape')closeAddUnit();}}/>
            </div>
          </div>
          <div className="app-dialog-actions">
            <button className="app-dialog-btn app-dialog-btn-cancel"
              disabled={savingUnit} onClick={closeAddUnit}>
              Hủy
            </button>
            <button className="app-dialog-btn app-dialog-btn-confirm"
              disabled={savingUnit} onClick={saveAddUnit}>
              {savingUnit?'Đang tạo...':'Tạo đơn vị'}
            </button>
          </div>
        </div>
      </div>
    )}

  </SafePage>;
}
