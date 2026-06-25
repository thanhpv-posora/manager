import React,{useEffect,useState}from'react';
import api from'../api/api';
import SafePage from'../components/SafePage';
import {showSuccess,showError,showWarning}from'../utils/toast';
import {Pencil,Power,PowerOff}from'lucide-react';

const EMPTY_FORM={code:'',name:'',sort_order:0};

export default function Units(){
  const[rows,setRows]=useState([]);
  const[form,setForm]=useState(EMPTY_FORM);
  const[editing,setEditing]=useState(null);
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState('');
  const[saving,setSaving]=useState(false);
  const[search,setSearch]=useState('');
  const[page,setPage]=useState(1);
  const[pageSize,setPageSize]=useState(20);

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
      <h3>Danh sách đơn vị</h3>
      <div style={{marginBottom:12,display:'flex',gap:8,alignItems:'center'}}>
        <input className="input" placeholder="Tìm theo mã, tên đơn vị..." value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}} style={{maxWidth:320}}/>
        {search&&<button className="btn secondary" onClick={()=>{setSearch('');setPage(1);}}>Xóa lọc</button>}
        <span className="muted">{(()=>{const q=search.toLowerCase().trim();return q?rows.filter(x=>String(x.code+x.name).toLowerCase().includes(q)).length:rows.length})()}/{rows.length} đơn vị</span>
      </div>
      <table className="table">
        <thead>
          <tr><th>Mã</th><th>Tên</th><th>Thứ tự</th><th>Trạng thái</th><th></th></tr>
        </thead>
        <tbody>
          {(()=>{
            const q=search.toLowerCase().trim();
            const filtered=q?rows.filter(x=>String(x.code+' '+x.name).toLowerCase().includes(q)):rows;
            const totalPages=Math.max(1,Math.ceil(filtered.length/pageSize));
            const cp=Math.min(page,totalPages);
            const paginated=filtered.slice((cp-1)*pageSize,cp*pageSize);
            return <>
              {paginated.map(x=><tr key={x.id} style={x.is_active?{}:{opacity:0.5}}>
                <td><b>{x.code}</b></td>
                <td>{x.name}</td>
                <td>{x.sort_order}</td>
                <td>
                  <span className="badge" style={x.is_active?{background:'#dcfce7',color:'#166534'}:{background:'#f3f4f6',color:'#6b7280'}}>
                    {x.is_active?'Đang dùng':'Tắt'}
                  </span>
                </td>
                <td>
                  <div style={{display:'flex',flexWrap:'nowrap',gap:6,alignItems:'center',justifyContent:'center'}}>
                    <button className="btn secondary" title="Sửa" style={{padding:0,width:32,height:32,display:'inline-flex',alignItems:'center',justifyContent:'center'}} onClick={()=>editRow(x)}><Pencil size={14}/></button>
                    {x.is_active
                      ?<button className="btn danger" title="Tắt" style={{padding:0,width:32,height:32,display:'inline-flex',alignItems:'center',justifyContent:'center'}} onClick={()=>disable(x)}><PowerOff size={14}/></button>
                      :<button className="btn secondary" title="Bật" style={{padding:0,width:32,height:32,display:'inline-flex',alignItems:'center',justifyContent:'center'}} onClick={()=>enable(x)}><Power size={14}/></button>}
                  </div>
                </td>
              </tr>)}
              {paginated.length===0&&<tr><td colSpan={5} className="muted" style={{textAlign:'center',padding:24}}>Không tìm thấy đơn vị phù hợp</td></tr>}
              <tr><td colSpan={5} style={{padding:0,border:'none'}}>
                <div style={{display:'flex',justifyContent:'flex-end',alignItems:'center',gap:8,padding:'10px 0 2px',flexWrap:'wrap'}}>
                  <select className="select" value={pageSize} onChange={e=>{setPageSize(Number(e.target.value));setPage(1);}} style={{width:'auto'}}>
                    <option value={10}>10 / trang</option>
                    <option value={20}>20 / trang</option>
                    <option value={50}>50 / trang</option>
                  </select>
                  <span className="muted">Trang {cp} / {totalPages}</span>
                  <button className="btn secondary" onClick={()=>setPage(p=>Math.max(1,p-1))} disabled={cp<=1}>Trước</button>
                  <button className="btn secondary" onClick={()=>setPage(p=>Math.min(totalPages,p+1))} disabled={cp>=totalPages}>Sau</button>
                </div>
              </td></tr>
            </>;
          })()}
        </tbody>
      </table>
    </div>
  </SafePage>;
}
