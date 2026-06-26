import React,{useEffect,useState}from'react';
import {CheckCircle2,XCircle,Lock,Unlock,KeyRound,ExternalLink}from'lucide-react';
import api from'../api/api';
import SafePage from'../components/SafePage';
import {showSuccess,showError,showWarning}from'../utils/toast';

const TABS=[
  {key:'registrations',label:'Đăng ký chờ duyệt'},
  {key:'internal',label:'Internal User'},
  {key:'customer',label:'Customer User'},
  {key:'mapping',label:'Customer Mapping'},
];

export default function UserCustomerMapping({setPage}){
  const[tab,setTab]=useState('registrations');
  const[rows,setRows]=useState([]);
  const[registrations,setRegistrations]=useState([]);
  const[customers,setCustomers]=useState([]);
  const[form,setForm]=useState({});
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState('');
  const[pwModal,setPwModal]=useState(null);
  const[pwValue,setPwValue]=useState('');

  const load=async()=>{
    try{
      const[r,c,reg]=await Promise.all([
        api.get('/user-mapping'),
        api.get('/customers'),
        api.get('/user-mapping/registrations').catch(()=>({data:[]}))
      ]);
      setRows(r.data||[]);
      setCustomers(c.data||[]);
      setRegistrations(reg.data||[]);
    }catch(e){
      setError(e.response?.data?.message||e.message);
    }finally{
      setLoading(false);
    }
  };

  useEffect(()=>{load()},[]);

  const approve=async(id)=>{
    try{
      const r=await api.post('/user-mapping/registrations/'+id+'/approve');
      showSuccess(r.data?.message||'Đã duyệt và tạo user');
      await load();
    }catch(e){showError(e.response?.data?.message||e.message);}
  };

  const reject=async(id)=>{
    if(!await window.appConfirm('Bạn chắc chắn muốn từ chối đăng ký này?',{title:'Từ chối đăng ký',confirmText:'Từ chối',variant:'danger'}))return;
    try{
      const r=await api.post('/user-mapping/registrations/'+id+'/reject');
      showWarning(r.data?.message||'Đã từ chối đăng ký');
      await load();
    }catch(e){showError(e.response?.data?.message||e.message);}
  };

  const createStaff=async()=>{
    if(!form.password) return showError('Nhập mật khẩu');
    if(!form.confirm_password) return showError('Nhập lại mật khẩu');
    if(form.password!==form.confirm_password) return showError('Mật khẩu nhập lại không khớp');
    const{confirm_password:_,...payload}=form;
    try{
      await api.post('/user-mapping/user',{...payload,role:'STAFF'});
      showSuccess('Đã tạo user nội bộ');
      setForm({username:'',full_name:'',password:'',confirm_password:''});
      await load();
    }catch(e){showError(e.response?.data?.message||e.message);}
  };

  const lockUser=async(row)=>{
    if(!await window.appConfirm(`Khóa tài khoản "${row.username}"?`,{title:'Khóa tài khoản',confirmText:'Khóa',variant:'danger'}))return;
    try{
      await api.post(`/user-mapping/users/${row.user_id}/lock`);
      showSuccess('Đã khóa tài khoản');
      await load();
    }catch(e){showError(e.response?.data?.message||e.message);}
  };

  const unlockUser=async(row)=>{
    try{
      await api.post(`/user-mapping/users/${row.user_id}/unlock`);
      showSuccess('Đã mở khóa tài khoản');
      await load();
    }catch(e){showError(e.response?.data?.message||e.message);}
  };

  const openResetPw=(row)=>{
    setPwModal({user_id:row.user_id,username:row.username});
    setPwValue('');
  };

  const confirmResetPw=async()=>{
    try{
      await api.post(`/user-mapping/users/${pwModal.user_id}/reset-password`,{password:pwValue});
      showSuccess('Đã đặt lại mật khẩu');
      setPwModal(null);
    }catch(e){showError(e.response?.data?.message||e.message);}
  };

  const openCustomer=(row)=>{
    if(setPage&&row.customer_id) setPage('customers');
  };

  const map=async(row,customer_id)=>{
    try{
      await api.post('/user-mapping/map',{user_id:row.user_id,customer_id});
      showSuccess('Đã mapping user với khách hàng');
      await load();
    }catch(e){showError(e.response?.data?.message||e.message);}
  };

  const pending=registrations.filter(x=>x.status==='PENDING');
  const handled=registrations.filter(x=>x.status!=='PENDING');
  const staffRows=rows.filter(x=>x.role==='STAFF');
  const customerRows=rows.filter(x=>x.role==='CUSTOMER');

  return <SafePage loading={loading} error={error}>
    <div className="acct-tabs">
      {TABS.map(t=><button key={t.key} className={'acct-tab'+(tab===t.key?' active':'')} onClick={()=>setTab(t.key)}>
        {t.label}
        {t.key==='registrations'&&pending.length>0&&<span className="acct-tab-badge">{pending.length}</span>}
      </button>)}
    </div>

    {tab==='registrations'&&<>
      <div className="card">
        <h3>Đơn đăng ký đang chờ duyệt</h3>
        <p className="muted">Khách đăng ký ngoài trang home sẽ nằm ở đây. Duyệt sẽ tạo khách hàng + user CUSTOMER.</p>
        {!pending.length&&<p className="muted">Không có đăng ký mới đang chờ duyệt.</p>}
        {!!pending.length&&<table className="table mapping-registration-table">
          <thead><tr><th>Thông tin đăng ký</th><th>Tài khoản</th><th></th></tr></thead>
          <tbody>{pending.map(x=><tr key={x.id}>
            <td>
              <b>{x.full_name||x.business_name}</b><br/>
              <span className="muted">{x.phone} · {x.email}</span><br/>
              <span className="muted">{x.description||x.transfer_note||''}</span>
            </td>
            <td><b>{x.username}</b><br/><span className="muted">{x.service_plan||'TRIAL'}</span></td>
            <td>
              <div style={{display:'flex',gap:6,alignItems:'center',justifyContent:'center'}}>
                <button className="btn" title="Duyệt & tạo user" style={{padding:0,width:32,height:32,display:'inline-flex',alignItems:'center',justifyContent:'center'}} onClick={()=>approve(x.id)}><CheckCircle2 size={14}/></button>
                <button className="btn danger" title="Từ chối" style={{padding:0,width:32,height:32,display:'inline-flex',alignItems:'center',justifyContent:'center'}} onClick={()=>reject(x.id)}><XCircle size={14}/></button>
              </div>
            </td>
          </tr>)}</tbody>
        </table>}
      </div>
      {!!handled.length&&<div className="card" style={{marginTop:18}}>
        <h3>Lịch sử đã xử lý</h3>
        <table className="table">
          <thead><tr><th>Khách</th><th>User</th><th>Trạng thái</th><th>Mapping</th></tr></thead>
          <tbody>{handled.slice(0,30).map(x=><tr key={x.id}>
            <td><b>{x.full_name||x.business_name}</b><br/><span className="muted">{x.phone}</span></td>
            <td>{x.username}<br/><span className="muted">user_id: {x.user_id||'-'}</span></td>
            <td>{x.status}</td>
            <td>customer_id: {x.customer_id||'-'}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    </>}

    {tab==='internal'&&<>
      <div className="card">
        <h3>Tạo user nội bộ</h3>
        <p className="muted">Nhân viên (Cashier, Warehouse, Operator, Accountant, Manager) đều dùng role STAFF. Phân quyền chức năng qua trang Phân quyền user.</p>
        <div className="form-grid">
          <input className="input" placeholder="Username" value={form.username||''} onChange={e=>setForm({...form,username:e.target.value})}/>
          <input className="input" placeholder="Tên hiển thị" value={form.full_name||''} onChange={e=>setForm({...form,full_name:e.target.value})}/>
          <input className="input" placeholder="Mật khẩu" type="password" value={form.password||''} onChange={e=>setForm({...form,password:e.target.value})}/>
          <input className="input" placeholder="Nhập lại mật khẩu" type="password" value={form.confirm_password||''} onChange={e=>setForm({...form,confirm_password:e.target.value})}/>
        </div>
        <button className="btn" style={{marginTop:10}} onClick={createStaff}>Tạo user nội bộ</button>
      </div>
      <div className="card" style={{marginTop:18}}>
        <h3>Danh sách user nội bộ</h3>
        {!staffRows.length&&<p className="muted">Chưa có user nội bộ nào.</p>}
        {!!staffRows.length&&<table className="table">
          <thead><tr><th>User</th><th>Role</th><th>Trạng thái</th></tr></thead>
          <tbody>{staffRows.map(x=><tr key={x.user_id}>
            <td><b>{x.username}</b><br/><span className="muted">{x.full_name}</span></td>
            <td><span className="acct-badge staff">STAFF</span></td>
            <td><span className={'acct-badge '+(x.is_active?'active':'locked')}>{x.is_active?'Hoạt động':'Đã khóa'}</span></td>
          </tr>)}</tbody>
        </table>}
      </div>
    </>}

    {tab==='customer'&&<div className="card">
      <h3>Danh sách user khách hàng</h3>
      <p className="muted">Tài khoản khách hàng được tạo qua luồng Đăng ký → Xác minh email → Duyệt. Không tạo thủ công.</p>
      {!customerRows.length&&<p className="muted">Chưa có user khách hàng nào.</p>}
      {!!customerRows.length&&<table className="table">
        <thead><tr><th>User</th><th>Khách hàng</th><th>Trạng thái</th><th>Thao tác</th></tr></thead>
        <tbody>{customerRows.map(x=><tr key={x.user_id}>
          <td><b>{x.username}</b><br/><span className="muted">{x.full_name}</span></td>
          <td>{x.customer_code?`${x.customer_code} - ${x.customer_name}`:<span className="muted">Chưa gắn</span>}</td>
          <td><span className={'acct-badge '+(x.is_active?'active':'locked')}>{x.is_active?'Hoạt động':'Đã khóa'}</span></td>
          <td>
            <div className="row-actions">
              <button className="btn secondary" style={{padding:'0 10px',height:32,fontSize:12,gap:4,minHeight:32}} onClick={()=>openResetPw(x)}><KeyRound size={13}/>Reset PW</button>
              {x.is_active
                ?<button className="btn danger" style={{padding:'0 10px',height:32,fontSize:12,gap:4,minHeight:32}} onClick={()=>lockUser(x)}><Lock size={13}/>Khóa</button>
                :<button className="btn" style={{padding:'0 10px',height:32,fontSize:12,gap:4,minHeight:32,background:'var(--success)'}} onClick={()=>unlockUser(x)}><Unlock size={13}/>Mở khóa</button>
              }
              {x.customer_id&&<button className="btn secondary" style={{padding:'0 10px',height:32,fontSize:12,gap:4,minHeight:32}} onClick={()=>openCustomer(x)}><ExternalLink size={13}/>Khách</button>}
            </div>
          </td>
        </tr>)}</tbody>
      </table>}
    </div>}

    {tab==='mapping'&&<div className="card">
      <h3>Customer Mapping</h3>
      <p className="muted">Quyết định user thấy dữ liệu của khách hàng nào. STAFF không cần gắn khách hàng.</p>
      <table className="table">
        <thead><tr><th>User</th><th>Role</th><th>Khách đang gắn</th><th>Mapping</th></tr></thead>
        <tbody>{rows.map(x=>{
          const isInternal=x.role==='STAFF'||x.role==='ADMIN';
          return <tr key={x.user_id}>
            <td><b>{x.username}</b><br/><span className="muted">{x.full_name}</span></td>
            <td><span className={'acct-badge '+(x.role==='STAFF'?'staff':x.role==='ADMIN'?'admin':'customer')}>{x.role}</span></td>
            <td>{x.customer_code?`${x.customer_code} - ${x.customer_name}`:<span className="muted">-</span>}</td>
            <td>{isInternal
              ?<span className="muted" style={{fontSize:13}}>Internal User</span>
              :<select className="select" style={{minHeight:36,padding:'4px 10px'}} value={x.customer_id||''} onChange={e=>map(x,e.target.value)}>
                <option value="">Chưa gắn</option>
                {customers.map(c=><option key={c.id} value={c.id}>{c.customer_code} - {c.name}</option>)}
              </select>
            }</td>
          </tr>;
        })}</tbody>
      </table>
    </div>}

    {pwModal&&<div className="acct-modal-overlay" onClick={()=>setPwModal(null)}>
      <div className="acct-modal" onClick={e=>e.stopPropagation()}>
        <h3>Đặt lại mật khẩu</h3>
        <p className="muted">User: <b>{pwModal.username}</b></p>
        <input className="input" placeholder="Mật khẩu mới (tối thiểu 6 ký tự)" type="password" value={pwValue} onChange={e=>setPwValue(e.target.value)} style={{marginBottom:12,width:'100%',boxSizing:'border-box'}}/>
        <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
          <button className="btn secondary" onClick={()=>setPwModal(null)}>Hủy</button>
          <button className="btn" onClick={confirmResetPw}>Xác nhận</button>
        </div>
      </div>
    </div>}
  </SafePage>;
}
