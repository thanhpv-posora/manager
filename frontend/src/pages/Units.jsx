import React,{useEffect,useState}from'react';
import api from'../api/api';
import SafePage from'../components/SafePage';
import {showSuccess,showError,showWarning}from'../utils/toast';

const EMPTY_FORM={code:'',name:'',sort_order:0};

export default function Units(){
  const[rows,setRows]=useState([]);
  const[form,setForm]=useState(EMPTY_FORM);
  const[editing,setEditing]=useState(null);
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState('');
  const[saving,setSaving]=useState(false);

  const load=async()=>{
    try{
      const r=await api.get('/units');
      setRows(r.data||[]);
    }catch(e){setError(e.response?.data?.message||e.message);}
    finally{setLoading(false);}
  };

  useEffect(()=>{load();},[]);

  const reset=()=>{setEditing(null);setForm(EMPTY_FORM);};

  const editRow=x=>{
    setEditing(x.id);
    setForm({code:x.code,name:x.name,sort_order:x.sort_order});
  };

  const save=async()=>{
    const code=String(form.code||'').trim().toUpperCase();
    const name=String(form.name||'').trim();
    if(!code){showWarning('Nhập mã đơn vị');return;}
    if(!name){showWarning('Nhập tên đơn vị');return;}
    try{
      setSaving(true);
      if(editing){
        await api.put('/units/'+editing,{...form,code});
        showSuccess('Đã cập nhật đơn vị');
      }else{
        await api.post('/units',{...form,code});
        showSuccess('Đã tạo đơn vị');
      }
      reset();
      await load();
    }catch(e){
      showError(e.response?.data?.message||e.message||'Lưu thất bại');
    }finally{setSaving(false);}
  };

  const disable=async x=>{
    const ok=window.appConfirm
      ?await window.appConfirm(`Tắt đơn vị "${x.name}"?`,{title:'Xác nhận tắt đơn vị',confirmText:'Tắt',variant:'warning'})
      :window.confirm(`Tắt đơn vị "${x.name}"?`);
    if(!ok)return;
    try{
      await api.delete('/units/'+x.id);
      showSuccess('Đã tắt đơn vị');
      await load();
    }catch(e){showError(e.response?.data?.message||e.message||'Thao tác thất bại');}
  };

  const enable=async x=>{
    try{
      await api.put('/units/'+x.id,{code:x.code,name:x.name,sort_order:x.sort_order,is_active:1});
      showSuccess('Đã bật đơn vị');
      await load();
    }catch(e){showError(e.response?.data?.message||e.message||'Thao tác thất bại');}
  };

  return <SafePage loading={loading} error={error}>
    <div className="grid cols-2">
      <div className="card">
        <h3>{editing?'Sửa đơn vị':'Tạo đơn vị mới'}</h3>
        <div className="form-grid">
          <input className="input" placeholder="Mã đơn vị (VD: KG, CON, THUNG) *"
            value={form.code} onChange={e=>setForm({...form,code:e.target.value.toUpperCase()})}/>
          <input className="input" placeholder="Tên đơn vị (VD: Kilogram, Con, Thùng) *"
            value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/>
          <input className="input" type="number" placeholder="Thứ tự sắp xếp"
            value={form.sort_order} min={0}
            onChange={e=>setForm({...form,sort_order:Number(e.target.value)||0})}/>
        </div>
        <div className="actions" style={{marginTop:12}}>
          <button className="btn" onClick={save} disabled={saving}>
            {saving?'Đang lưu...':(editing?'Lưu sửa':'Tạo đơn vị')}
          </button>
          <button className="btn secondary" onClick={reset}>Hủy / Làm mới</button>
        </div>
      </div>
      <div className="card">
        <h3>Lưu ý</h3>
        <p className="muted">
          Mã đơn vị tự động viết HOA (KG, CON, THUNG, HOP...).<br/><br/>
          Không dùng ENUM — thêm đơn vị tùy ý theo nhu cầu kinh doanh.<br/><br/>
          Đơn vị đã tắt không hiển thị trong các tùy chọn nhập hàng NCC.
        </p>
      </div>
    </div>

    <div className="card">
      <h3>Danh sách đơn vị ({rows.length})</h3>
      <table className="table">
        <thead>
          <tr><th>Mã</th><th>Tên</th><th>Thứ tự</th><th>Trạng thái</th><th></th></tr>
        </thead>
        <tbody>
          {rows.map(x=><tr key={x.id} style={x.is_active?{}:{opacity:0.5}}>
            <td><b>{x.code}</b></td>
            <td>{x.name}</td>
            <td>{x.sort_order}</td>
            <td>
              <span className="badge" style={x.is_active?{background:'#dcfce7',color:'#166534'}:{background:'#f3f4f6',color:'#6b7280'}}>
                {x.is_active?'Đang dùng':'Tắt'}
              </span>
            </td>
            <td>
              <button className="btn secondary" onClick={()=>editRow(x)}>Sửa</button>{' '}
              {x.is_active
                ?<button className="btn danger" onClick={()=>disable(x)}>Tắt</button>
                :<button className="btn secondary" onClick={()=>enable(x)}>Bật</button>}
            </td>
          </tr>)}
          {rows.length===0&&<tr><td colSpan={5} className="muted" style={{textAlign:'center',padding:24}}>Chưa có đơn vị nào</td></tr>}
        </tbody>
      </table>
    </div>
  </SafePage>;
}
