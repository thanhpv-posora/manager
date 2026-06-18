import React,{useEffect,useState}from'react';
import api from'../api/api';
import SafePage from'../components/SafePage';
import MoneyInput from'../components/MoneyInput';
import {parseProductImportText}from'../utils/productImageImportParser';
import {preprocessImageFile}from'../utils/imagePreprocess';

export default function ProductImageImport(){
 const[categories,setCategories]=useState([]);
 const[categoryId,setCategoryId]=useState('');
 const[rawText,setRawText]=useState('');
 const[rows,setRows]=useState([]);
 const[loading,setLoading]=useState(false);
 const[error,setError]=useState('');
 const[ocrMode,setOcrMode]=useState('preprocess');
 const[threshold,setThreshold]=useState(150);
 const[ocrProvider,setOcrProvider]=useState('TESSERACT');

 useEffect(()=>{api.get('/products/categories').then(r=>setCategories(r.data||[])).catch(()=>{});api.get('/ocr-providers/active/product-import').then(r=>setOcrProvider(r.data.provider||'TESSERACT')).catch(()=>{})},[]);

 const ocrImage=async(file)=>{
  if(!file)return;
  setLoading(true);setError('');
  try{
   const Tesseract=await import('tesseract.js');
   const imgFile=ocrMode==='preprocess'?await preprocessImageFile(file,{threshold:Number(threshold||150)}):file;
   const res=await Tesseract.recognize(imgFile,'vie+eng',{
    tessedit_pageseg_mode:'6',
    preserve_interword_spaces:'1'
   });
   setRawText(res.data.text||'');
   if((res.data.confidence||0)<55){
    setError('OCR confidence thấp ('+Math.round(res.data.confidence||0)+'%). Nên sửa text bên dưới trước khi import.');
   }
  }catch(e){setError('OCR ảnh lỗi: '+e.message)}
  finally{setLoading(false)}
 };

 const useTemplate=()=>{
  setRawText(`Đùi bò kg 230,000
Búp bò kg 190,000
Nạm bò kg 210,000
Sườn bò kg 180,000`);
 };

 const parseText=async()=>{
  const parsed=parseProductImportText(rawText,categoryId);
  const preview=(await api.post('/product-import/preview',{rows:parsed})).data;
  // Add OCR confidence warnings client side
  const merged=preview.map((r,i)=>{
    const conf=parsed[i]?.ocr_confidence??100;
    const warnings=[...(r.warnings||[])];
    if(conf<65) warnings.push('OCR không chắc, cần kiểm tra');
    return {...r,ocr_confidence:conf,status:r.status==='OK'&&conf<65?'WARN':r.status,warnings};
  });
  setRows(merged);
 };

 const updateRow=(idx,patch)=>setRows(rows.map((r,i)=>i===idx?{...r,...patch}:r));

 const save=async()=>{
  const chosen=rows.filter(x=>x.selected&&x.status!=='ERROR');
  if(!chosen.length)return alert('Không có dòng hợp lệ để lưu');
  if(chosen.some(x=>x.status==='WARN')&&!await window.appConfirm('Có dòng màu vàng cần kiểm tra. Bạn chắc chắn muốn lưu?',{title:'Xác nhận lưu dữ liệu',confirmText:'Lưu',variant:'warning'}))return;
  const r=await api.post('/product-import/save',{rows:chosen});
  alert(`${r.data.message}. Lưu ${r.data.saved.length}, bỏ qua ${r.data.skipped.length}`);
  setRows([]);setRawText('');
 };

 return <SafePage loading={loading} error={error}>
  <div className="card portal-hero">
   <h1>Smart Product Image Import Agent</h1>
   <p>OCR ảnh chỉ là bước đọc thô. Agent sẽ tiền xử lý ảnh, cho sửa text, preview màu rồi mới lưu.</p>
  </div>

  <div className="grid cols-2">
   <div className="card">
    <h3>1. Upload ảnh hoặc dán text</h3><p className="muted">OCR đang dùng: <b>{ocrProvider}</b>. Nếu ảnh khó đọc, vào Advanced OCR Provider để đổi Google Document AI/Azure/PaddleOCR.</p>
    <div className="form-grid">
     <select className="select" value={categoryId} onChange={e=>setCategoryId(e.target.value)}>
      <option value="">Chọn nhóm mặc định</option>
      {categories.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
     </select>
     <select className="select" value={ocrMode} onChange={e=>setOcrMode(e.target.value)}>
      <option value="preprocess">Tiền xử lý ảnh đen trắng</option>
      <option value="raw">OCR ảnh gốc</option>
     </select>
     <input className="input" type="number" value={threshold} onChange={e=>setThreshold(e.target.value)} placeholder="Ngưỡng sáng 120-180"/>
     <input className="input" type="file" accept="image/*" onChange={e=>ocrImage(e.target.files?.[0])}/>
    </div>
    <textarea className="input" style={{minHeight:260,marginTop:12}} placeholder={"Mỗi dòng 1 mặt hàng:\nĐùi bò kg 230,000\nBúp bò kg 190,000"} value={rawText} onChange={e=>setRawText(e.target.value)}/>
    <div className="actions" style={{marginTop:12}}>
     <button className="btn secondary" onClick={useTemplate}>Dùng mẫu nhập chuẩn</button>
     <button className="btn secondary" onClick={parseText}>Xem trước import</button>
     <button className="btn" onClick={save} disabled={!rows.length}>Lưu mặt hàng đã chọn</button>
    </div>
   </div>
   <div className="card">
    <h3>Vì sao OCR đọc sai?</h3>
    <p className="muted">Ảnh chụp nghiêng, chữ nhỏ, bảng mờ, nền nhiều màu hoặc chữ viết tay sẽ làm OCR sai. Vì vậy bản này dùng quy trình an toàn:</p>
    <ol>
     <li>Tiền xử lý ảnh.</li>
     <li>Cho sửa text OCR trước.</li>
     <li>Preview màu.</li>
     <li>Không lưu dòng đỏ.</li>
     <li>Dòng vàng phải xác nhận.</li>
    </ol>
   </div>
  </div>

  {rows.length>0&&<div className="card">
   <h3>2. Preview danh mục</h3>
   <table className="table">
    <thead><tr><th>Chọn</th><th>Raw OCR</th><th>Tên mặt hàng</th><th>ĐVT</th><th>Giá bán</th><th>Mode tồn</th><th>Trạng thái</th></tr></thead>
    <tbody>{rows.map((r,i)=><tr key={i} style={{background:r.status==='ERROR'?'#fee2e2':(r.status==='WARN'?'#fef3c7':'#dcfce7')}}>
     <td><input type="checkbox" checked={!!r.selected} disabled={r.status==='ERROR'} onChange={e=>updateRow(i,{selected:e.target.checked})}/></td>
     <td>{r.raw}<br/><span className="muted">OCR: {r.ocr_confidence||100}%</span></td>
     <td><input className="input" value={r.name||''} onChange={e=>updateRow(i,{name:e.target.value,status:e.target.value?'OK':'ERROR'})}/></td>
     <td><input className="input" style={{width:80}} value={r.unit||'kg'} onChange={e=>updateRow(i,{unit:e.target.value})}/></td>
     <td><MoneyInput value={r.sale_price||0} onChange={v=>updateRow(i,{sale_price:v})}/></td>
     <td><select className="select" value={r.inventory_mode||'STOCK'} onChange={e=>updateRow(i,{inventory_mode:e.target.value,allow_negative_stock:e.target.value==='STOCK'?0:1})}><option value="STOCK">Kiểm tồn</option><option value="CARCASS_PART">Bò xô/pha lóc</option><option value="NON_STOCK">Không kiểm tồn</option></select></td>
     <td>{r.status==='OK'?'🟢 OK':(r.status==='WARN'?'🟡 '+(r.warnings||[]).join(', '):'🔴 '+(r.errors||[]).join(', '))}{r.duplicate&&<><br/><span className="muted">Trùng: {r.duplicate.product_code} - {r.duplicate.name}</span></>}</td>
    </tr>)}</tbody>
   </table>
  </div>}
 </SafePage>
}
