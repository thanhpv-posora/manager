import React,{useEffect,useState}from'react';
import api from'../api/api';
import SafePage from'../components/SafePage';
import MoneyInput from'../components/MoneyInput';
import {moneyVnd}from'../utils/money';

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
    if(!String(form.name||'').trim())return alert('Nhập tên hàng');
    await saveDefaults(pickDefaults(form));
    if(editing) await api.put('/products/'+editing,form);
    else await api.post('/products',form);
    reset();
    await load();
  };

  const edit=x=>{
    setEditing(x.id);
    setForm({...buildEmptyForm(defaults),...x,is_active:x.is_active?1:0,allow_negative_stock:x.allow_negative_stock?1:0});
  };

  const remove=async x=>{
    const reason=prompt('Lý do xóa mặt hàng?');
    if(reason!==null){
      await api.delete('/products/'+x.id,{data:{reason}});
      await load();
    }
  };

  return <SafePage loading={loading} error={error}>
    <div className="grid cols-2">
      <div className="card">
        <h3>{editing?'Sửa mặt hàng':'Thêm mặt hàng'}</h3>
        <p className="muted">Hệ thống nhớ mặc định theo user: nhóm hàng, đơn vị, kiểu tồn kho, âm kho.</p>
        <div className="form-grid">
          <input className="input" placeholder="Mã hàng" value={form.product_code||''} onChange={e=>updateForm({product_code:e.target.value})}/>
          <input className="input" placeholder="Tên hàng" value={form.name||''} onChange={e=>updateForm({name:e.target.value})}/>

          <select className="select" value={form.category_id||''} onChange={e=>updateForm({category_id:e.target.value},true)}>
            <option value="">Nhóm hàng</option>
            {categories.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
          </select>

          <input className="input" placeholder="Đơn vị" value={form.unit||'kg'} onChange={e=>updateForm({unit:e.target.value},true)}/>

          <MoneyInput value={form.sale_price||0} onChange={v=>updateForm({sale_price:v})}/>
          <MoneyInput value={form.cost_price||0} onChange={v=>updateForm({cost_price:v})}/>

          <input className="input" placeholder="Tồn kho" value={form.stock_quantity||0} onChange={e=>updateForm({stock_quantity:e.target.value})}/>
          <input className="input" placeholder="Ngưỡng tồn thấp" value={form.low_stock_threshold||5} onChange={e=>updateForm({low_stock_threshold:e.target.value})}/>

          <select className="select" value={form.inventory_mode||'STOCK'} onChange={e=>updateForm({inventory_mode:e.target.value},true)}>
            <option value="STOCK">Quản tồn kho chuẩn: gà/vịt/thịt đông lạnh</option>
            <option value="NON_STOCK">Không quản tồn từng mã: bò xô/nguyên con</option>
            <option value="CARCASS_PART">Phần pha lóc từ bò xô: đùi/búp/nạm...</option>
          </select>

          <select className="select" value={Number(form.allow_negative_stock||0)} onChange={e=>updateForm({allow_negative_stock:Number(e.target.value)},true)}>
            <option value={0}>Không cho âm kho</option>
            <option value={1}>Cho phép không kiểm tồn</option>
          </select>
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
      <h3>Danh sách mặt hàng</h3>
      <table className="table">
        <thead><tr><th>Mã</th><th>Tên</th><th>ĐVT</th><th>Giá bán</th><th>Mode</th><th></th></tr></thead>
        <tbody>{rows.map(x=><tr key={x.id}>
          <td>{x.product_code}</td>
          <td><b>{x.name}</b><br/><span className="muted">{x.category_name||''}</span></td>
          <td>{x.unit}</td>
          <td>{moneyVnd(x.sale_price||x.price||0)}</td>
          <td>{x.inventory_mode}</td>
          <td><button className="btn secondary" onClick={()=>edit(x)}>Sửa</button>{' '}<button className="btn danger" onClick={()=>remove(x)}>Xóa</button></td>
        </tr>)}</tbody>
      </table>
    </div>
  </SafePage>
}
