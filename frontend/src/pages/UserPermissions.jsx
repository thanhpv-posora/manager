import React,{useEffect,useState}from'react';
import api from'../api/api';
import SafePage from'../components/SafePage';
import {showSuccess,showError}from'../utils/toast';

export default function UserPermissions({onSaved}){
  const[users,setUsers]=useState([]);
  const[selected,setSelected]=useState('');
  const[detail,setDetail]=useState(null);
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState('');
  const[saving,setSaving]=useState(false);

  const load=async()=>{
    try{const r=await api.get('/permissions/users');setUsers(r.data||[]);}
    catch(e){setError(e.response?.data?.message||e.message);}
    finally{setLoading(false);}
  };
  useEffect(()=>{load();},[]);

  const open=async(id)=>{
    setSelected(id);
    const r=await api.get('/permissions/users/'+id+'/menus');
    setDetail(r.data);
  };

  const toggle=(key)=>{
    const cur=!!(detail.override&&detail.override[key]);
    setDetail({...detail,override:{...(detail.override||{}),[key]:!cur}});
  };

  const save=async()=>{
    try{
      setSaving(true);
      const menus=(detail.allMenus||[]).map(m=>({menu_key:m.menu_key,is_enabled:!!detail.override[m.menu_key]}));
      await api.put('/permissions/users/'+selected+'/menus',{menus});
      showSuccess('Đã lưu phân quyền menu');
      await open(selected);
      onSaved&&onSaved();
    }catch(e){showError(e.response?.data?.message||e.message||'Lưu thất bại');}
    finally{setSaving(false);}
  };

  const isAdmin=detail?.user?.role==='ADMIN';

  return(
    <SafePage loading={loading} error={error}>
      <div className="grid cols-2">
        <div className="card">
          <h3>Danh sách user</h3>
          <table className="table"><tbody>
            {users.map(u=>(
              <tr key={u.id}>
                <td><b>{u.username}</b><br/><span className="muted">{u.full_name} · {u.role}</span></td>
                <td><button className="btn secondary" onClick={()=>open(u.id)}>Phân quyền</button></td>
              </tr>
            ))}
          </tbody></table>
        </div>

        <div className="card">
          <h3>Quyền truy cập menu</h3>
          {!detail&&<p className="muted">Chọn user bên trái.</p>}
          {detail&&<>
            <p><b>{detail.user.username}</b> · {detail.user.role}</p>
            {isAdmin
              ? <p className="muted">ADMIN luôn có toàn quyền truy cập menu. Không thể giới hạn quyền ADMIN.</p>
              : <>
                  <p className="muted">Tick để cấp quyền truy cập menu cho user này.</p>
                  <div style={{marginTop:8}}>
                    {(detail.allMenus||[]).map(m=>(
                      <div key={m.menu_key} style={{display:'flex',alignItems:'center',gap:8,padding:'6px 4px',borderBottom:'1px solid #f1f5f9'}}>
                        <input type="checkbox" checked={!!detail.override[m.menu_key]} onChange={()=>toggle(m.menu_key)}/>
                        <span style={{flex:1,fontSize:14}}>{m.title}</span>
                      </div>
                    ))}
                  </div>
                  <button className="btn" style={{marginTop:12}} onClick={save} disabled={saving}>
                    {saving?'Đang lưu...':'Lưu phân quyền'}
                  </button>
                </>
            }
          </>}
        </div>
      </div>
    </SafePage>
  );
}
