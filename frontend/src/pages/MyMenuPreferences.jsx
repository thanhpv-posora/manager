import React,{useEffect,useRef,useState}from'react';
import api from'../api/api';
import SafePage from'../components/SafePage';
import {showSuccess,showError}from'../utils/toast';

export default function MyMenuPreferences({onSaved}){
  const[menus,setMenus]=useState([]);
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState('');
  const[saving,setSaving]=useState(false);
  const[dragging,setDragging]=useState(null);
  const[dragOver,setDragOver]=useState(null);
  const dragFrom=useRef(null);

  const load=async()=>{
    setLoading(true);
    try{
      const r=await api.get('/permissions/my/menu-preferences');
      setMenus(r.data?.menus||[]);
    }catch(e){setError(e.response?.data?.message||e.message);}
    finally{setLoading(false);}
  };
  useEffect(()=>{load();},[]);

  const onDragStart=(idx)=>{dragFrom.current=idx;setDragging(idx);};
  const onDragOver=(e,idx)=>{e.preventDefault();setDragOver(idx);};
  const onDrop=(e,toIdx)=>{
    e.preventDefault();
    const from=dragFrom.current;
    if(from===null||from===toIdx){setDragging(null);setDragOver(null);return;}
    setMenus(prev=>{
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

  // TODO: show unsaved changes indicator after drag/drop
  // TODO (next sprint): togglePin — moves menu to top of sidebar (is_pinned column)
  // TODO (next sprint): toggleHide — removes menu from sidebar (is_hidden column)

  const save=async()=>{
    try{
      setSaving(true);
      // is_pinned/is_hidden sent as 0 until next sprint enables pin/hide UI
      const items=menus.map((m,idx)=>({menu_key:m.menu_key,sort_order:idx+1,is_pinned:0,is_hidden:0}));
      await api.put('/permissions/my/menu-preferences',{items});
      showSuccess('Đã lưu thứ tự menu cá nhân');
      onSaved&&onSaved();
    }catch(e){showError(e.response?.data?.message||e.message||'Lưu thất bại');}
    finally{setSaving(false);}
  };

  const restoreDefault=async()=>{
    const ok=window.appConfirm
      ?await window.appConfirm('Khôi phục menu về thứ tự mặc định hệ thống?',{title:'Khôi phục mặc định',confirmText:'Khôi phục',variant:'warning'})
      :window.confirm('Khôi phục menu về thứ tự mặc định hệ thống?');
    if(!ok)return;
    try{
      setSaving(true);
      await api.delete('/permissions/my/menu-preferences');
      showSuccess('Đã khôi phục menu mặc định');
      await load();          // reload page list → shows app_menus.sort_order
      onSaved&&onSaved();    // refreshPermissions() → reloads sidebar immediately
    }catch(e){showError(e.response?.data?.message||e.message||'Thao tác thất bại');}
    finally{setSaving(false);}
  };

  return(
    <SafePage loading={loading} error={error}>
      <div className="card">
        <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:16,flexWrap:'wrap',gap:8}}>
          <div>
            <h3 style={{margin:0}}>Menu của tôi</h3>
            <p className="muted" style={{margin:'4px 0 0'}}>Kéo để sắp xếp thứ tự hiển thị trên sidebar. Chỉ áp dụng cho tài khoản của bạn.</p>
          </div>
          <div style={{display:'flex',gap:8,flexShrink:0}}>
            <button className="btn secondary" onClick={restoreDefault} disabled={saving}>Khôi phục mặc định</button>
            <button className="btn" onClick={save} disabled={saving}>{saving?'Đang lưu...':'Lưu thứ tự'}</button>
          </div>
        </div>

        {menus.length===0&&<p className="muted">Không có menu nào được phép truy cập.</p>}

        {menus.map((m,idx)=>(
          <div
            key={m.menu_key}
            draggable
            onDragStart={()=>onDragStart(idx)}
            onDragOver={e=>onDragOver(e,idx)}
            onDrop={e=>onDrop(e,idx)}
            onDragEnd={onDragEnd}
            style={{
              display:'flex',alignItems:'center',gap:10,padding:'8px 4px',
              borderTop:dragOver===idx?'2px solid #3b82f6':'2px solid transparent',
              borderBottom:'1px solid #f1f5f9',
              opacity:dragging===idx?0.35:1,
              userSelect:'none',
            }}
          >
            <span style={{color:'#94a3b8',cursor:'grab',fontSize:15,letterSpacing:'0.02em',lineHeight:1}}>⠿</span>
            <span style={{flex:1,fontSize:14}}>{m.title}</span>
            {/* TODO (next sprint): pin button */}
            {/* TODO (next sprint): hide button */}
          </div>
        ))}
      </div>
    </SafePage>
  );
}
