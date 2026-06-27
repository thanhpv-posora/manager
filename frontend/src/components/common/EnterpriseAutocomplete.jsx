import React,{useState,useRef,useEffect,useCallback,useMemo,forwardRef,useImperativeHandle}from'react';
import {createPortal}from'react-dom';
import {ChevronDown,Loader2}from'lucide-react';

const MAX=50;

const CSS=`
.ea-wrap{position:relative;display:inline-flex;width:100%;box-sizing:border-box;}
.ea-field{display:flex;align-items:center;gap:6px;width:100%;min-height:42px;padding:3px 10px 3px 12px;background:#fff;border:1px solid #E2E8F0;border-radius:14px;cursor:pointer;box-sizing:border-box;transition:border-color .15s,box-shadow .15s;font-family:inherit;}
.ea-field:hover:not(.ea-dis){border-color:#94A3B8;}
.ea-field.ea-on{border-color:#1A73E8;box-shadow:0 0 0 3px rgba(26,115,232,.12);}
.ea-field.ea-dis{opacity:.55;cursor:not-allowed;background:#F8FAFC;}
.ea-body{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;overflow:hidden;}
.ea-inp{width:100%;border:none;outline:none;background:transparent;font:inherit;font-size:14px;color:#1F2937;padding:0;margin:0;cursor:text;}
.ea-inp::placeholder{color:#94A3B8;}
.ea-inp:disabled{cursor:not-allowed;}
.ea-lbl{flex:1;min-width:0;cursor:pointer;outline:none;}
.ea-lp{font-weight:600;font-size:14px;color:#1F2937;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.25;display:block;}
.ea-ls{font-size:11px;color:#64748B;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.3;display:block;margin-top:1px;}
.ea-acts{display:flex;align-items:center;gap:3px;flex-shrink:0;}
.ea-clr{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;border:none;background:#E2E8F0;color:#64748B;cursor:pointer;font-size:11px;padding:0;transition:background .15s;line-height:1;}
.ea-clr:hover{background:#CBD5E1;color:#1F2937;}
.ea-ch{color:#94A3B8;transition:transform .18s;flex-shrink:0;}
.ea-ch.ea-up{transform:rotate(180deg);}
@keyframes ea-sp{from{transform:rotate(0)}to{transform:rotate(360deg)}}
.ea-ld{animation:ea-sp 1s linear infinite;color:#1A73E8;}
.ea-drop{background:#fff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden;box-shadow:0 12px 32px rgba(15,23,42,.12);}
.ea-lst{max-height:320px;overflow-y:auto;}
.ea-row{display:flex;flex-direction:column;gap:2px;padding:10px 14px;cursor:pointer;border-bottom:1px solid #F8FAFC;}
.ea-row:last-child{border-bottom:none;}
.ea-row.ea-hi,.ea-row:hover{background:#EFF6FF;}
.ea-rp{font-weight:600;font-size:14px;color:#1F2937;}
.ea-rs{font-size:12px;color:#64748B;}
.ea-mt{padding:20px 14px;text-align:center;color:#94A3B8;font-size:14px;}
`;

let _ci=false;
function injectCss(){
  if(_ci)return;
  const s=document.createElement('style');
  s.textContent=CSS;
  document.head.appendChild(s);
  _ci=true;
}

const EnterpriseAutocomplete=forwardRef(function EnterpriseAutocomplete({
  items=[],
  value=null,
  onChange,
  placeholder='Tìm kiếm...',
  displayField='name',
  secondaryFields=[],
  searchFields=['name'],
  filter,
  disabled=false,
  loading=false,
  emptyText='Không tìm thấy kết quả',
  getItemKey=i=>i.id,
  renderItem,
  renderValue,
},ref){
  const[open,setOpen]=useState(false);
  const[query,setQuery]=useState('');
  const[hi,setHi]=useState(0);
  const[pos,setPos]=useState({top:0,left:0,w:0});
  const wrapRef=useRef(null);
  const dropRef=useRef(null);
  const inpRef=useRef(null);
  const lstRef=useRef(null);

  useEffect(()=>{injectCss();},[]);

  const filtered=useMemo(()=>{
    const base=filter?items.filter(filter):items;
    if(!query.trim())return base.slice(0,MAX);
    const q=query.trim().toLowerCase();
    return base
      .filter(item=>searchFields.some(f=>String(item[f]||'').toLowerCase().includes(q)))
      .slice(0,MAX);
  },[items,query,searchFields,filter]);

  const upd=useCallback(()=>{
    if(!wrapRef.current)return;
    const r=wrapRef.current.getBoundingClientRect();
    setPos({top:r.bottom+4,left:r.left,w:r.width});
  },[]);

  // Update portal position on scroll/resize while open
  useEffect(()=>{
    if(!open)return;
    upd();
    const fn=()=>upd();
    window.addEventListener('scroll',fn,true);
    window.addEventListener('resize',fn);
    return()=>{window.removeEventListener('scroll',fn,true);window.removeEventListener('resize',fn);};
  },[open,upd]);

  // Close on outside mousedown
  useEffect(()=>{
    if(!open)return;
    const h=(e)=>{
      if(wrapRef.current?.contains(e.target)||dropRef.current?.contains(e.target))return;
      setOpen(false);setQuery('');
    };
    document.addEventListener('mousedown',h);
    return()=>document.removeEventListener('mousedown',h);
  },[open]);

  // Reset highlight when filtered list changes
  useEffect(()=>{setHi(0);},[filtered]);

  // Scroll highlighted row into view
  useEffect(()=>{
    if(!lstRef.current)return;
    lstRef.current.children[hi]?.scrollIntoView({block:'nearest'});
  },[hi]);

  const openDrop=()=>{
    if(disabled)return;
    upd();setQuery('');setHi(0);setOpen(true);
    setTimeout(()=>inpRef.current?.focus(),0);
  };

  useImperativeHandle(ref,()=>({focus:()=>openDrop()}),[disabled]);

  const close=()=>{setOpen(false);setQuery('');};

  const pick=(item)=>{onChange&&onChange(item);close();};

  const clr=(e)=>{
    e.stopPropagation();
    onChange&&onChange(null);
    setQuery('');setOpen(false);
  };

  const kd=(e)=>{
    if(!open){
      if(e.key==='ArrowDown'||e.key==='Enter'){e.preventDefault();openDrop();}
      return;
    }
    if(e.key==='ArrowDown'){e.preventDefault();setHi(h=>Math.min(h+1,filtered.length-1));}
    else if(e.key==='ArrowUp'){e.preventDefault();setHi(h=>Math.max(h-1,0));}
    else if(e.key==='Enter'){e.preventDefault();if(filtered[hi])pick(filtered[hi]);}
    else if(e.key==='Escape'||e.key==='Tab'){close();}
  };

  const disp=value?(renderValue?renderValue(value):String(value[displayField]||'')):'';
  const sec=value?secondaryFields.map(f=>value[f]).filter(Boolean).join(' · '):'';

  const drop=open?(
    <div
      ref={dropRef}
      className="ea-drop"
      style={{position:'fixed',top:pos.top,left:pos.left,width:pos.w,zIndex:9999,minWidth:220}}
      onMouseDown={e=>e.preventDefault()}
    >
      <div ref={lstRef} className="ea-lst">
        {filtered.length===0
          ?<div className="ea-mt">{emptyText}</div>
          :filtered.map((item,idx)=>(
            <div
              key={getItemKey(item)}
              className={`ea-row${idx===hi?' ea-hi':''}`}
              onClick={()=>pick(item)}
              onMouseEnter={()=>setHi(idx)}
            >
              {renderItem?renderItem(item):(
                <>
                  <span className="ea-rp">{String(item[displayField]||'')}</span>
                  {secondaryFields.length>0&&(
                    <span className="ea-rs">
                      {secondaryFields.map(f=>item[f]).filter(Boolean).join(' · ')}
                    </span>
                  )}
                </>
              )}
            </div>
          ))
        }
      </div>
    </div>
  ):null;

  return(
    <div ref={wrapRef} className="ea-wrap">
      <div
        className={`ea-field${disabled?' ea-dis':''}${open?' ea-on':''}`}
        onClick={!open?openDrop:undefined}
      >
        <div className="ea-body">
          {/* Closed + has value: styled label with primary + secondary */}
          {!open&&value
            ? <div
                className="ea-lbl"
                tabIndex={disabled?-1:0}
                onFocus={openDrop}
                onKeyDown={kd}
              >
                <span className="ea-lp">{disp}</span>
                {sec&&<span className="ea-ls">{sec}</span>}
              </div>
            /* Open or no value: the input IS the search box */
            : <input
                ref={inpRef}
                className="ea-inp"
                value={open?query:''}
                onChange={e=>{
                  setQuery(e.target.value);
                  setHi(0);
                  if(!open){upd();setOpen(true);}
                }}
                onFocus={()=>{if(!open){upd();setQuery('');setHi(0);setOpen(true);}}}
                onKeyDown={kd}
                placeholder={placeholder}
                disabled={disabled}
                autoComplete="off"
              />
          }
        </div>
        <div className="ea-acts">
          {loading&&<Loader2 size={14} className="ea-ld"/>}
          {value&&!disabled&&(
            <button className="ea-clr" onClick={clr} tabIndex={-1} type="button">✕</button>
          )}
          <ChevronDown size={16} className={`ea-ch${open?' ea-up':''}`}/>
        </div>
      </div>
      {createPortal(drop,document.body)}
    </div>
  );
});

export default EnterpriseAutocomplete;
