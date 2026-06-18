import React,{useEffect,useState}from'react';
import api from'../api/api';
import SafePage from'../components/SafePage';
import {moneyVnd}from'../utils/money';
import {showSuccess,showError,showWarning}from'../utils/toast';

export default function Customers(){
  const[rows,setRows]=useState([]);
  const[form,setForm]=useState({price_mode:'COMMON_PRICE',billing_calendar_type:'SOLAR',is_active:1});
  const[editing,setEditing]=useState(null);
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState('');
  const[pendingDelete,setPendingDelete]=useState(null);
  const[deleteReason,setDeleteReason]=useState('');
  const[deleting,setDeleting]=useState(false);
  const user=JSON.parse(localStorage.getItem('user')||'{}');
  const isCustomer=user.role==='CUSTOMER';

  const load=async()=>{
    try{
      const r=await api.get('/customers');
      setRows(r.data||[]);
    }catch(e){setError(e.response?.data?.message||e.message)}
    finally{setLoading(false)}
  };

  const loadNextCode=async()=>{
    try{
      const r=await api.get('/customers/next-code');
      setForm(f=>({...f,customer_code:r.data.customer_code}));
    }catch(e){}
  };

  useEffect(()=>{load();loadNextCode()},[]);

  const reset=()=>{setEditing(null);setForm({price_mode:'COMMON_PRICE',billing_calendar_type:'SOLAR',is_active:1});loadNextCode()};

  const save=async()=>{
    if(!String(form.name||'').trim()){
      showWarning('Nhập tên khách hàng');
      return;
    }
    try{
      if(editing) await api.put('/customers/'+editing,form);
      else await api.post('/customers',form);
      showSuccess(editing?'Đã sửa khách hàng':'Đã tạo khách hàng');
      reset();
      await load();
    }catch(e){
      showError(e.response?.data?.message||e.message||'Lưu khách hàng thất bại');
    }
  };

  const edit=x=>{
    setEditing(x.id);
    setForm({...x,is_active:x.is_active?1:0});
  };

  const remove=x=>{
    setPendingDelete(x);
    setDeleteReason('');
  };

  const closeDeleteDialog=()=>{
    if(deleting)return;
    setPendingDelete(null);
    setDeleteReason('');
  };

  const confirmDeleteCustomer=async()=>{
    if(!pendingDelete)return;
    const reason=String(deleteReason||'').trim();
    if(!reason){
      showWarning('Vui lòng nhập lý do xóa khách hàng');
      return;
    }
    try{
      setDeleting(true);
      await api.delete('/customers/'+pendingDelete.id,{data:{reason}});
      showSuccess('Đã xóa mềm khách hàng');
      setPendingDelete(null);
      setDeleteReason('');
      await load();
    }catch(e){
      showWarning(e.response?.data?.message||e.message||'Không thể xóa khách hàng');
    }finally{
      setDeleting(false);
    }
  };

  return <SafePage loading={loading} error={error}>
    <div className="grid cols-2">
      <div className="card">
        <h3>{editing?'Sửa khách hàng':(isCustomer?'Tạo khách hàng riêng của user này':'Tạo khách hàng')}</h3>
        <p className="muted">
          {isCustomer?'Khách tạo tại đây sẽ thuộc phạm vi user đang login. User chỉ thấy khách chính và khách con do user tạo.':'Admin thấy toàn bộ khách hàng.'}
        </p>
        <div className="form-grid">
          <input className="input" placeholder="Mã khách tự động" value={form.customer_code||''} onChange={e=>setForm({...form,customer_code:e.target.value})}/>
          <input className="input" placeholder="Tên khách hàng *" value={form.name||''} onChange={e=>setForm({...form,name:e.target.value})}/>
          <input className="input" placeholder="Số điện thoại" value={form.phone||''} onChange={e=>setForm({...form,phone:e.target.value})}/>
          <input className="input" placeholder="Địa chỉ" value={form.address||''} onChange={e=>setForm({...form,address:e.target.value})}/>
          <select className="select" value={form.price_mode||'COMMON_PRICE'} onChange={e=>setForm({...form,price_mode:e.target.value})}>
            <option value="CUSTOM_PRICE">Giá riêng</option>
            <option value="COMMON_PRICE">Giá chung</option>
          </select>
          <select className="select" value={form.billing_calendar_type||'SOLAR'} onChange={e=>setForm({...form,billing_calendar_type:e.target.value})}>
            <option value="SOLAR">Tính bill theo dương lịch</option>
            <option value="LUNAR">Tính bill theo âm lịch</option>
          </select>
          <input className="input" placeholder="Ghi chú" value={form.note||''} onChange={e=>setForm({...form,note:e.target.value})}/>
        </div>
        <div className="actions" style={{marginTop:12}}>
          <button className="btn" onClick={save}>{editing?'Lưu sửa':'Tạo khách hàng'}</button>
          <button className="btn secondary" onClick={reset}>Làm mới</button>
          <button className="btn secondary" onClick={loadNextCode}>Lấy mã mới</button>
        </div>
      </div>

      <div className="card">
        <h3>Thông tin scope</h3>
        <p className="muted">
          Quy tắc: user chỉ thấy menu admin bật và dữ liệu nằm trong phạm vi customer của user đó.
        </p>
        {isCustomer&&<div className="card" style={{boxShadow:'none',background:'#fff7ed'}}>
          <b>User hiện tại:</b> {user.username}<br/>
          <b>Customer ID:</b> {user.customer_id}<br/>
          <b>Khách tự tạo:</b> lưu dưới dạng khách con.
        </div>}
      </div>
    </div>

    <div className="card">
      <h3>Danh sách khách hàng</h3>
      <table className="table">
        <thead><tr><th>Mã</th><th>Tên</th><th>Liên hệ</th><th>Lịch tính bill</th><th>Công nợ</th><th>Thuộc khách</th><th></th></tr></thead>
        <tbody>{rows.map(x=><tr key={x.id}>
          <td>{x.customer_code}</td>
          <td><b>{x.name}</b><br/><span className="muted">{x.price_mode}</span></td>
          <td>{x.phone}<br/><span className="muted">{x.address}</span></td>
          <td>{x.billing_calendar_type==='LUNAR'?'Âm lịch':'Dương lịch'}</td>
          <td>{moneyVnd(x.current_debt)}</td>
          <td>{x.parent_customer_name||'Khách chính'}</td>
          <td>
            <button className="btn secondary" onClick={()=>edit(x)}>Sửa</button>{' '}
            {(isCustomer?x.parent_customer_id:1)&&<button className="btn danger" onClick={()=>remove(x)}>Xóa</button>}
          </td>
        </tr>)}</tbody>
      </table>
    </div>

    {pendingDelete&&<div className="app-dialog-backdrop" role="dialog" aria-modal="true">
      <div className="app-dialog app-dialog-danger">
        <div className="app-dialog-head">
          <div className="app-dialog-icon">⚠️</div>
          <div className="app-dialog-title">Xóa mềm khách hàng</div>
        </div>
        <div className="app-dialog-message">
          Bạn đang xóa mềm khách hàng <b>{pendingDelete.name||pendingDelete.customer_name||pendingDelete.customer_code||('#'+pendingDelete.id)}</b>.<br/>
          Khách hàng sẽ không bị xóa khỏi dữ liệu lịch sử, nhưng sẽ không còn dùng để tạo bill mới.
        </div>
        <label className="field-label" style={{marginTop:8}}>
          <span>Lý do xóa</span>
          <textarea
            className="input"
            autoFocus
            rows={3}
            placeholder="Ví dụ: nhập nhầm, khách ngừng giao dịch, trùng khách hàng..."
            value={deleteReason}
            onChange={e=>setDeleteReason(e.target.value)}
            onKeyDown={e=>{if(e.key==='Escape')closeDeleteDialog();}}
            style={{resize:'vertical',minHeight:88}}
          />
        </label>
        <div className="app-dialog-actions" style={{marginTop:18}}>
          <button className="app-dialog-btn app-dialog-btn-cancel" onClick={closeDeleteDialog} disabled={deleting}>Hủy</button>
          <button className="app-dialog-btn app-dialog-btn-confirm danger" onClick={confirmDeleteCustomer} disabled={deleting}>{deleting?'Đang xóa...':'Xóa khách hàng'}</button>
        </div>
      </div>
    </div>}
  </SafePage>
}
