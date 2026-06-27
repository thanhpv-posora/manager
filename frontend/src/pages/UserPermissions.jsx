import React,{useEffect,useRef,useState}from'react';
import api from'../api/api';
import SafePage from'../components/SafePage';

export default function UserPermissions({onSaved}){
  const[users,setUsers]=useState([]);
  const[selected,setSelected]=useState('');
  const[detail,setDetail]=useState(null);
  const[menuOrder,setMenuOrder]=useState([]);
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState('');
  const[dragging,setDragging]=useState(null);
  const[dragOver,setDragOver]=useState(null);
  const dragFrom=useRef(null);

  const load=async()=>{
    try{const r=await api.get('/permissions/users');setUsers(r.data||[]);}
    catch(e){setError(e.response?.data?.message||e.message);}
    finally{setLoading(false);}
  };
  useEffect(()=>{load();},[]);

  const open=async(id)=>{
    setSelected(id);
    const r=await api.get('/permissions/users/'+id+'/menus');
    const data=r.data;
    setDetail(data);
    const allMenus=data.allMenus||[];
    const prefs=data.preferences||{};
    const sorted=[...allMenus].sort((a,b)=>{
      const oa=prefs[a.menu_key]?.sort_order??a.sort_order;
      const ob=prefs[b.menu_key]?.sort_order??b.sort_order;
      return oa-ob;
    });
    setMenuOrder(sorted.map(m=>m.menu_key));
  };

  const toggle=(key)=>{
    const cur=!!(detail.override&&detail.override[key]);
    setDetail({...detail,override:{...(detail.override||{}),[key]:!cur}});
  };

  const onDragStart=(idx)=>{dragFrom.current=idx;setDragging(idx);};
  const onDragOver=(e,idx)=>{e.preventDefault();setDragOver(idx);};
  const onDrop=(e,toIdx)=>{
    e.preventDefault();
    const from=dragFrom.current;
    if(from===null||from===toIdx){setDragging(null);setDragOver(null);return;}
    setMenuOrder(prev=>{
      const next=[...prev];
      const[removed]=next.splice(from,1);
      const insertAt=from<toIdx?toIdx-1:toIdx;
      next.splice(insertAt,0,removed);
      return next;
    });
    dragFrom.current=null;
    setDragging(null);
    setDragOver(null);
  };
  const onDragEnd=()=>{dragFrom.current=null;setDragging(null);setDragOver(null);};

  const save=async()=>{
    const isAdmin=detail.user.role==='ADMIN';
    if(!isAdmin){
      const menus=(detail.allMenus||[]).map(m=>({menu_key:m.menu_key,is_enabled:!!detail.override[m.menu_key]}));
      await api.put('/permissions/users/'+selected+'/menus',{menus});
    }
    const items=menuOrder.map((menu_key,idx)=>({menu_key,sort_order:idx+1,is_pinned:0,is_hidden:0}));
    await api.put('/permissions/users/'+selected+'/menu-preferences',{items});
    alert(isAdmin?'Đã lưu thứ tự menu cho ADMIN':'Đã lưu phân quyền và thứ tự menu');
    await open(selected);
    onSaved&&onSaved();
  };

  const menuMap={};
  (detail?.allMenus||[]).forEach(m=>menuMap[m.menu_key]=m);
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
          <h3>Menu được phép hiển thị</h3>
          {!detail&&<p className="muted">Chọn user bên trái.</p>}
          {detail&&<>
            <p><b>{detail.user.username}</b> · {detail.user.role}</p>
            {isAdmin
              ? <p className="muted">ADMIN luôn có toàn quyền menu. Màn hình này chỉ dùng để sắp xếp thứ tự menu.</p>
              : <p className="muted">Tick để cấp quyền. Kéo để sắp xếp thứ tự sidebar.</p>
            }
            <div style={{marginTop:8}}>
              {menuOrder.map((key,idx)=>{
                const m=menuMap[key];
                if(!m)return null;
                return(
                  <div
                    key={key}
                    draggable
                    onDragStart={()=>onDragStart(idx)}
                    onDragOver={e=>onDragOver(e,idx)}
                    onDrop={e=>onDrop(e,idx)}
                    onDragEnd={onDragEnd}
                    style={{
                      display:'flex',alignItems:'center',gap:8,padding:'6px 4px',
                      borderTop:dragOver===idx?'2px solid #3b82f6':'2px solid transparent',
                      opacity:dragging===idx?0.35:1,
                      userSelect:'none',
                    }}
                  >
                    <span style={{color:'#94a3b8',cursor:'grab',fontSize:15,letterSpacing:'0.02em',lineHeight:1}}>⠿</span>
                    {!isAdmin&&<input type="checkbox" checked={!!detail.override[key]} onChange={()=>toggle(key)}/>}
                    <span style={{flex:1,fontSize:14}}>{m.title}</span>
                  </div>
                );
              })}
            </div>
            <button className="btn" style={{marginTop:12}} onClick={save}>
              {isAdmin?'Lưu thứ tự menu':'Lưu phân quyền'}
            </button>
          </>}
        </div>
      </div>
    </SafePage>
  );
}
