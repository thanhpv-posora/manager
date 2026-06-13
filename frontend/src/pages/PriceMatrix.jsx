import React,{useEffect,useState}from'react';import api from'../api/api';import SafePage from'../components/SafePage';import MoneyInput from'../components/MoneyInput';import {moneyVnd} from'../utils/money';

export default function PriceMatrix(){
  const[customers,setCustomers]=useState([]);
  const[cid,setCid]=useState('');
  const[data,setData]=useState(null);
  const[rows,setRows]=useState([]);
  const[copyTo,setCopyTo]=useState('');
  const[dragId,setDragId]=useState(null);
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState('');

  const loadCustomers=async()=>{
    const c=(await api.get('/customers')).data||[];
    setCustomers(c);
    if(!cid && c.length) {
      setCid(String(c[0].id));
      await loadMatrix(c[0].id);
    }
  };

  const loadMatrix=async(id)=>{
    if(!id)return;
    const r=(await api.get('/price-matrix/'+id)).data;
    setData(r);
    setRows((r.rows||[]).map((x,i)=>({...x, sort_order:x.sort_order||i+1, in_catalog:!!x.in_catalog})));
  };

  useEffect(()=>{let m=true;(async()=>{try{await loadCustomers()}catch(e){if(m)setError(e.response?.data?.message||e.message)}finally{if(m)setLoading(false)}})();return()=>{m=false}},[]);

  const changeCustomer=async(id)=>{setCid(id);await loadMatrix(id)};
  const setRow=(idx,patch)=>setRows(rows.map((r,i)=>i===idx?{...r,...patch}:r));
  const save=async()=>{await api.put('/price-matrix/'+cid,{items:rows.map((x,i)=>({...x,sort_order:i+1}))});alert('Đã lưu bảng giá riêng và thứ tự danh mục');await loadMatrix(cid)};
  const copy=async()=>{if(!copyTo)return alert('Chọn khách nhận copy');await api.post('/price-matrix/copy',{from_customer_id:cid,to_customer_id:copyTo});alert('Đã copy');};
  const handleDrop=(targetId)=>{
    if(!dragId||dragId===targetId)return;
    const arr=[...rows];
    const from=arr.findIndex(x=>String(x.product_id)===String(dragId));
    const to=arr.findIndex(x=>String(x.product_id)===String(targetId));
    if(from<0||to<0)return;
    const [moved]=arr.splice(from,1);
    arr.splice(to,0,moved);
    setRows(arr.map((x,i)=>({...x,sort_order:i+1,in_catalog:x.in_catalog})));
    setDragId(null);
  };

  const saveOrderOnly=async()=>{
    if(!cid)return;
    await api.put('/price-matrix/'+cid+'/catalog/reorder',{items:rows.map((x,i)=>({product_id:x.product_id,sort_order:i+1}))});
    alert('Đã lưu thứ tự kéo thả');
    await loadMatrix(cid);
  };

  return <SafePage loading={loading} error={error}>
    <div className="grid">
      <div className="card price-matrix-table-card">
        <h3>Price Matrix Agent - bảng giá riêng theo từng bạn hàng</h3>
        <div className="actions">
          <select className="select" style={{width:260}} value={cid} onChange={e=>changeCustomer(e.target.value)}>
            {customers.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select className="select" style={{width:260}} value={copyTo} onChange={e=>setCopyTo(e.target.value)}>
            <option value="">Copy bảng này sang khách...</option>
            {customers.filter(c=>String(c.id)!==String(cid)).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button className="btn secondary" onClick={copy}>Copy</button>
          <button className="btn secondary" onClick={saveOrderOnly}>Lưu thứ tự kéo thả</button>
          <button className="btn" onClick={save}>Lưu tất cả an toàn</button>
        </div>
        {data&&<p className="muted">Kéo biểu tượng ☰ để đổi thứ tự danh mục khách. Tick “Dùng trong bill” để mặt hàng xuất hiện trong tạo bill.</p>}
      </div>

      <div className="card">
        <table className="table">
          <thead><tr><th></th><th>Dùng trong bill</th><th>STT</th><th>Mặt hàng</th><th>Giá chung</th><th>Giá riêng khách này</th><th>Mode</th></tr></thead>
          <tbody>{rows.map((r,idx)=><tr key={r.product_id} draggable onDragStart={()=>setDragId(r.product_id)} onDragOver={e=>e.preventDefault()} onDrop={()=>handleDrop(r.product_id)} style={{cursor:'move'}}>
            <td>☰</td>
            <td><input type="checkbox" checked={!!r.in_catalog} onChange={e=>setRow(idx,{in_catalog:e.target.checked})}/></td>
            <td><input className="input" inputMode="numeric" style={{width:70}} value={idx+1} readOnly/></td>
            <td><b>{r.product_name}</b><br/><span className="muted">{r.category_name} · {r.product_code}</span></td>
            <td>{moneyVnd(r.default_sale_price)}</td>
            <td><MoneyInput value={r.private_price??r.effective_price??0} onChange={v=>setRow(idx,{private_price:v})}/></td>
            <td>{r.inventory_mode}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </div>
  </SafePage>;
}
