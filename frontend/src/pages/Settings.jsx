import React,{useEffect,useState}from'react';import api from'../api/api';import SafePage from'../components/SafePage';import {setQuantityDecimalPlaces}from'../utils/quantity';

export default function Settings(){
  const[form,setForm]=useState({});
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState('');
  const[success,setSuccess]=useState('');

  useEffect(()=>{api.get('/settings').then(r=>setForm(r.data||{})).catch(e=>setError(e.response?.data?.message||e.message)).finally(()=>setLoading(false))},[]);
  const save=async()=>{
    const r=await api.put('/settings',form);
    setQuantityDecimalPlaces(form.quantity_decimal_places);
    setSuccess(r.data.message);
  };

  return <SafePage loading={loading} error={error}>
    <div className="card">
      <h3>Cấu hình cửa hàng - Business Edition</h3>
      <p className="muted">Dùng để đem triển khai cho nhiều hộ kinh doanh khác nhau: đổi tên cửa hàng, địa chỉ, số điện thoại, footer bill.</p>
      <div className="form-grid">
        <input className="input" placeholder="Tên cửa hàng" value={form.shop_name||''} onChange={e=>setForm({...form,shop_name:e.target.value})}/>
        <input className="input" placeholder="SĐT" value={form.shop_phone||''} onChange={e=>setForm({...form,shop_phone:e.target.value})}/>
        <input className="input" placeholder="Địa chỉ" value={form.shop_address||''} onChange={e=>setForm({...form,shop_address:e.target.value})}/>
        <select className="select" value={form.print_size||'K80'} onChange={e=>setForm({...form,print_size:e.target.value})}>
          <option value="K80">In nhiệt K80</option>
          <option value="A4">A4</option>
        </select>
        <input className="input" placeholder="Footer bill" value={form.bill_footer||''} onChange={e=>setForm({...form,bill_footer:e.target.value})}/>
        <label className="field-label">
          <span>Số chữ số thập phân số lượng</span>
          <select className="select" value={form.quantity_decimal_places??'2'} onChange={e=>setForm({...form,quantity_decimal_places:e.target.value})}>
            <option value="0">0 (588)</option>
            <option value="1">1 (588.1)</option>
            <option value="2">2 (588.10)</option>
            <option value="3">3 (588.100)</option>
          </select>
        </label>
      </div>
      <button className="btn" style={{marginTop:12}} onClick={save}>Lưu cấu hình</button>
      {success&&<p className="success">{success}</p>}
    </div>
  </SafePage>
}
