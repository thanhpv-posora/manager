import React,{useEffect,useState,useCallback}from'react';
import api from'../api/api';
import SafePage from'../components/SafePage';
import {showSuccess,showError,showWarning}from'../utils/toast';

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

export default function SupplierPurchaseOptions(){
  const[suppliers,setSuppliers]=useState([]);
  const[allProducts,setAllProducts]=useState([]);
  const[categories,setCategories]=useState([]);
  const[units,setUnits]=useState([]);
  const[supplierId,setSupplierId]=useState('');
  const[categoryId,setCategoryId]=useState('');
  const[productId,setProductId]=useState('');
  const[options,setOptions]=useState([]);
  const[form,setForm]=useState(EMPTY_FORM);
  const[editing,setEditing]=useState(null);
  const[loading,setLoading]=useState(true);
  const[loadingOpts,setLoadingOpts]=useState(false);
  const[error,setError]=useState('');
  const[saving,setSaving]=useState(false);
  const[focused,setFocused]=useState('');
  const[showAddUnit,setShowAddUnit]=useState(false);
  const[addUnitForm,setAddUnitForm]=useState(EMPTY_UNIT_FORM);
  const[savingUnit,setSavingUnit]=useState(false);

  const reloadUnits=async()=>{
    const r=await api.get('/supplier-purchase-options/units');
    const fresh=r.data||[];
    setUnits(fresh);
    return fresh;
  };

  useEffect(()=>{
    Promise.all([
      api.get('/suppliers'),
      api.get('/products'),
      api.get('/products/categories'),
      api.get('/supplier-purchase-options/units')
    ]).then(([s,p,c,u])=>{
      setSuppliers(s.data||[]);
      setAllProducts(p.data||[]);
      setCategories(c.data||[]);
      setUnits(u.data||[]);
    }).catch(e=>setError(e.response?.data?.message||e.message))
    .finally(()=>setLoading(false));
  },[]);

  const loadOptions=useCallback(async(sid,pid)=>{
    if(!sid||!pid){setOptions([]);return;}
    setLoadingOpts(true);
    try{
      const r=await api.get('/supplier-purchase-options',{params:{supplier_id:sid,product_id:pid}});
      setOptions(r.data||[]);
    }catch(e){showError(e.response?.data?.message||e.message||'Không tải được quy cách');}
    finally{setLoadingOpts(false);}
  },[]);

  useEffect(()=>{loadOptions(supplierId,productId);},[supplierId,productId,loadOptions]);

  const filteredProducts=categoryId
    ?allProducts.filter(p=>String(p.category_id)===String(categoryId))
    :[];

  const reset=()=>{setEditing(null);setForm(EMPTY_FORM);};

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

  const save=async()=>{
    if(!supplierId||!productId){showWarning('Chọn nhà cung cấp và sản phẩm');return;}
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
          supplier_id:supplierId,product_id:productId,...form,default_conversion_qty:conv
        });
        showSuccess('Đã thêm quy cách');
      }
      reset();
      await loadOptions(supplierId,productId);
    }catch(e){
      showError(e.response?.data?.message||e.message||'Lưu thất bại');
    }finally{setSaving(false);}
  };

  const disable=async x=>{
    const ok=window.appConfirm
      ?await window.appConfirm(`Tắt quy cách "${x.display_label}"?`,
          {title:'Xác nhận tắt quy cách',confirmText:'Tắt',variant:'warning'})
      :window.confirm(`Tắt quy cách "${x.display_label}"?`);
    if(!ok)return;
    try{
      await api.delete('/supplier-purchase-options/'+x.id);
      showSuccess('Đã tắt quy cách');
      await loadOptions(supplierId,productId);
    }catch(e){showError(e.response?.data?.message||e.message||'Thao tác thất bại');}
  };

  const enable=async x=>{
    try{
      await api.put('/supplier-purchase-options/'+x.id,{
        unit_id:x.unit_id,default_conversion_qty:x.default_conversion_qty,
        requires_actual_weight:x.requires_actual_weight,display_order:x.display_order,is_active:1
      });
      showSuccess('Đã bật quy cách');
      await loadOptions(supplierId,productId);
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
      if(created) setForm(f=>({...f,unit_id:created.id}));
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

  const selSupplier=suppliers.find(s=>String(s.id)===String(supplierId));
  const selCategory=categories.find(c=>String(c.id)===String(categoryId));
  const selProduct=allProducts.find(p=>String(p.id)===String(productId));

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
      <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:12}}>

        <div>
          <label style={LBL}>Nhà cung cấp</label>
          <select className="select" value={supplierId} onChange={e=>{
            setSupplierId(e.target.value);
            setCategoryId('');setProductId('');setOptions([]);reset();
          }}>
            <option value="">Chọn nhà cung cấp...</option>
            {suppliers.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </div>

        <div>
          <label style={LBL}>Nhóm hàng</label>
          <select className="select" value={categoryId}
            disabled={!supplierId}
            onChange={e=>{
              setCategoryId(e.target.value);
              setProductId('');setOptions([]);reset();
            }}>
            <option value="">Chọn nhóm hàng...</option>
            {categories.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>

        <div>
          <label style={LBL}>Sản phẩm</label>
          <select className="select" value={productId}
            disabled={!categoryId}
            onChange={e=>{setProductId(e.target.value);reset();}}>
            <option value="">Chọn sản phẩm...</option>
            {filteredProducts.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </div>

      </div>
    </div>

    {/* ── Empty states ── */}
    {!supplierId&&(
      <div className="card" style={{textAlign:'center',padding:'28px 24px'}}>
        <p className="muted">Vui lòng chọn nhà cung cấp.</p>
      </div>
    )}
    {supplierId&&!categoryId&&(
      <div className="card" style={{textAlign:'center',padding:'28px 24px'}}>
        <p className="muted">Vui lòng chọn nhóm hàng.</p>
      </div>
    )}
    {supplierId&&categoryId&&!productId&&(
      <div className="card" style={{textAlign:'center',padding:'28px 24px'}}>
        <p className="muted">Vui lòng chọn sản phẩm.</p>
      </div>
    )}

    {/* ── Form ── */}
    {supplierId&&categoryId&&productId&&<>
      <div className="card">
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:10}}>
          <h3 style={{margin:0}}>{editing?'Sửa quy cách':'Thêm quy cách mới'}</h3>
          {selSupplier&&selProduct&&(
            <span className="muted" style={{fontSize:12}}>
              {selSupplier.name} › {selCategory?.name} › <b>{selProduct.name}</b>
            </span>
          )}
        </div>

        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'10px 20px'}}>

          {/* Unit */}
          <div>
            <label style={LBL}>Đơn vị tính</label>
            <select className="select" value={form.unit_id}
              onFocus={()=>setFocused('unit')}
              onBlur={()=>setFocused('')}
              onChange={e=>handleUnitChange(e.target.value)}>
              <option value="">Ví dụ: Kg, Thùng, Bao, Con...</option>
              {units.map(u=><option key={u.id} value={u.id}>{u.name} ({u.code})</option>)}
            </select>
            {focused==='unit'&&(
              <p style={HINT}>Đơn vị nhà cung cấp dùng khi giao hàng.</p>
            )}
            <div style={{marginTop:5,fontSize:12,color:'#6b7280'}}>
              Không có đơn vị?{' '}
              <button type="button" style={LINK_BTN}
                onClick={()=>{setAddUnitForm(EMPTY_UNIT_FORM);setShowAddUnit(true);}}>
                Tạo mới
              </button>
            </div>
          </div>

          {/* Conversion qty */}
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
            {focused==='conversion'&&!convFixed&&(
              <p style={HINT}>Ví dụ: 1 Thùng = 15kg</p>
            )}
            {convFixed&&(
              <p style={HINT}>Giá trị cố định theo loại đơn vị, không thể sửa.</p>
            )}
          </div>

          {/* Display order */}
          <div>
            <label style={LBL}>Thứ tự hiển thị</label>
            <input className="input" type="number" placeholder="Ví dụ: 1"
              value={form.display_order} min={0}
              onFocus={()=>setFocused('order')}
              onBlur={()=>setFocused('')}
              onChange={e=>setForm({...form,display_order:Number(e.target.value)||0})}/>
            {focused==='order'&&(
              <p style={HINT}>Số nhỏ hiển thị trước. Dùng khi có nhiều quy cách cho một sản phẩm.</p>
            )}
          </div>

          {/* Requires actual weight */}
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

        {/* Preview */}
        {previewLabel&&(
          <div style={{
            marginTop:12,padding:'7px 12px',
            background:'#f0f9ff',borderRadius:6,
            border:'1px solid #bae6fd',fontSize:13
          }}>
            Tên hiển thị: <b>{previewLabel}</b>
          </div>
        )}

        <div className="actions" style={{marginTop:12}}>
          <button className="btn" onClick={save} disabled={saving}>
            {saving?'Đang lưu...':(editing?'Lưu sửa':'Thêm quy cách')}
          </button>
          <button className="btn secondary" onClick={reset}>Hủy / Làm mới</button>
        </div>
      </div>

      {/* ── Table ── */}
      <div className="card">
        <h3>Quy cách nhập hàng ({options.length})</h3>
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
                    <span className="badge" style={x.is_active
                      ?{background:'#dcfce7',color:'#166534'}
                      :{background:'#f3f4f6',color:'#6b7280'}}>
                      {x.is_active?'Đang dùng':'Tắt'}
                    </span>
                  </td>
                  <td>
                    <button className="btn secondary" onClick={()=>editRow(x)}>Sửa</button>{' '}
                    {x.is_active
                      ?<button className="btn danger" onClick={()=>disable(x)}>Tắt</button>
                      :<button className="btn secondary" onClick={()=>enable(x)}>Bật</button>}
                  </td>
                </tr>
              ))}
              {options.length===0&&(
                <tr>
                  <td colSpan={7} style={{textAlign:'center',padding:'28px 0'}}>
                    <p className="muted" style={{marginBottom:4}}>
                      Chưa có quy cách nhập cho sản phẩm này.
                    </p>
                    <p className="muted" style={{fontSize:13}}>
                      Nhấn <b>Thêm quy cách</b> ở trên để bắt đầu.
                    </p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </>}

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
