import React,{useEffect,useState}from'react';
import {Pencil}from'lucide-react';
import api from'../api/api';
import SafePage from'../components/SafePage';

export default function OCRProviders(){
 const[meta,setMeta]=useState({providers:[],modules:[]});
 const[configs,setConfigs]=useState([]);
 const[form,setForm]=useState({module_key:'product-import',provider:'TESSERACT',is_active:1});
 const[loading,setLoading]=useState(true);
 const[error,setError]=useState('');

 const load=async()=>{
  try{
   const[m,c]=await Promise.all([api.get('/ocr-providers/providers'),api.get('/ocr-providers/configs')]);
   setMeta(m.data);setConfigs(c.data||[]);
  }catch(e){setError(e.response?.data?.message||e.message)}
  finally{setLoading(false)}
 };
 useEffect(()=>{load()},[]);

 const save=async()=>{
  await api.post('/ocr-providers/configs',form);
  alert('Đã lưu OCR provider');
  await load();
 };

 const edit=x=>setForm({...x,is_active:x.is_active?1:0});

 return <SafePage loading={loading} error={error}>
  <div className="card portal-hero">
   <h1>Advanced OCR Provider Agent</h1>
   <p>Chọn trình đọc OCR cao cấp cho từng hạng mục: mặt hàng, bill, viết tay, nhập lô.</p>
  </div>

  <div className="grid cols-2">
   <div className="card">
    <h3>Cấu hình provider</h3>
    <div className="form-grid">
     <select className="select" value={form.module_key} onChange={e=>setForm({...form,module_key:e.target.value})}>
      {meta.modules.map(m=><option key={m.key} value={m.key}>{m.name}</option>)}
     </select>
     <select className="select" value={form.provider} onChange={e=>setForm({...form,provider:e.target.value})}>
      {meta.providers.map(p=><option key={p.key} value={p.key}>{p.name} - {p.quality}</option>)}
     </select>
     <input className="input" placeholder="Endpoint URL / PaddleOCR / Azure" value={form.endpoint_url||''} onChange={e=>setForm({...form,endpoint_url:e.target.value})}/>
     <input className="input" placeholder="API Key / token" value={form.api_key||''} onChange={e=>setForm({...form,api_key:e.target.value})}/>
     <input className="input" placeholder="Google project_id" value={form.project_id||''} onChange={e=>setForm({...form,project_id:e.target.value})}/>
     <input className="input" placeholder="processor_id" value={form.processor_id||''} onChange={e=>setForm({...form,processor_id:e.target.value})}/>
     <input className="input" placeholder="location_id: us/eu/asia..." value={form.location_id||''} onChange={e=>setForm({...form,location_id:e.target.value})}/>
     <select className="select" value={form.is_active?1:0} onChange={e=>setForm({...form,is_active:Number(e.target.value)})}><option value={1}>Đang dùng</option><option value={0}>Tắt</option></select>
    </div>
    <textarea className="input" style={{marginTop:12}} placeholder="Ghi chú" value={form.note||''} onChange={e=>setForm({...form,note:e.target.value})}/>
    <button className="btn" style={{marginTop:12}} onClick={save}>Lưu cấu hình</button>
   </div>

   <div className="card">
    <h3>Khuyến nghị theo hạng mục</h3>
    <table className="table"><tbody>{meta.modules.map(m=><tr key={m.key}><td><b>{m.name}</b><br/><span className="muted">{m.key}</span></td><td>{m.recommended}</td></tr>)}</tbody></table>
    <p className="muted">Production nên dùng Google Document AI cho ảnh bảng/giấy/Zalo, còn Tesseract chỉ dùng fallback local.</p>
   </div>
  </div>

  <div className="card">
   <h3>Cấu hình hiện tại</h3>
   <table className="table">
    <thead><tr><th>Module</th><th>Provider</th><th>Endpoint</th><th>Active</th><th></th></tr></thead>
    <tbody>{configs.map(c=><tr key={c.id}><td>{c.module_key}</td><td>{c.provider}</td><td>{c.endpoint_url}</td><td>{c.is_active?'YES':'NO'}</td><td><div style={{display:'flex',flexWrap:'nowrap',gap:6,alignItems:'center',justifyContent:'center'}}><button className="btn secondary" title="Sửa" style={{padding:0,width:32,height:32,display:'inline-flex',alignItems:'center',justifyContent:'center'}} onClick={()=>edit(c)}><Pencil size={14}/></button></div></td></tr>)}</tbody>
   </table>
  </div>
 </SafePage>
}
