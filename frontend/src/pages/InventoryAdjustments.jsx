import React,{useEffect,useMemo,useRef,useState}from'react';
import {Search}from'lucide-react';
import api from'../api/api';
import SafePage from'../components/SafePage';
import {showSuccess,showError,showWarning}from'../utils/toast';
import {formatQty}from'../utils/quantity';

// S6.6/S7.2/S7.3/S7.4/S7.5 — "Kiểm kê tồn kho" (stock count). Admin only.
// Excel-style grid: every TRACK_STOCK product loads as an editable row
// immediately — no per-product dialog. Only rows whose Actual Quantity
// differs from the current balance are saved, in ONE batch request/
// transaction (POST /inventory-adjustments/batch) — matches "No Reversal"
// (see backend route: no PUT/DELETE at all).
//
// S7.4 (production polish): server-side TRACK_STOCK filter, a read-only
// "Lần kiểm kê cuối" column, a dirty-row badge, and scroll/focus restoration
// after a successful save.
//
// S7.5 (production polish+): pure visual/UX polish only — sticky
// header/frozen column shadows, zebra rows, edited-cell highlight, a fixed
// bottom Save Bar, increase/decrease quantity totals, debounced search,
// search auto-select after save, and a friendlier empty state. No backend
// change, no API change, no schema change, no new entity.

const REASON_OPTIONS=[
  {value:'STOCK_COUNT',label:'Kiểm kê'},
  {value:'BROKEN',label:'Hỏng/Vỡ'},
  {value:'LOST',label:'Mất hàng'},
  {value:'EXPIRED',label:'Hết hạn'},
  {value:'FOUND',label:'Tìm thấy thừa'},
  {value:'OTHER',label:'Khác'},
];
const REASON_LABEL=Object.fromEntries(REASON_OPTIONS.map(r=>[r.value,r.label]));
const ZERO_TOLERANCE=0.001;
const SEARCH_DEBOUNCE_MS=150;

// Page-scoped CSS — not touching index.css. `.table` (global) sets
// `overflow:hidden` on the <table> element itself, which makes the table its
// own nearest overflow ancestor for position:sticky purposes and prevents
// the thead from ever sticking, even though the outer wrap div scrolls fine.
// The element+class selectors below win on specificity over the plain
// `.table`/`.table th`/`.table td` rules regardless of stylesheet order.
const inventoryCountStyles=`
.icnt-page{
  padding-bottom:84px;
}
.icnt-table-wrap{
  max-height:65vh;
  overflow:auto;
  position:relative;
  border:1px solid #E2E8F0;
  border-radius:18px;
}
table.icnt-table{
  overflow:visible;
  border:none;
  border-radius:0;
  box-shadow:none;
  width:100%;
  border-collapse:separate;
  border-spacing:0;
}
.icnt-table tbody tr.icnt-row-even td{
  background:#fafbfc;
}
.icnt-table thead th{
  position:sticky;
  top:0;
  z-index:10;
  background:#f8fafc;
  box-shadow:0 2px 4px -1px rgba(15,23,42,.12);
}
.icnt-table td.icnt-stt-col,
.icnt-table td.icnt-name-col{
  position:sticky;
  z-index:5;
  box-shadow:2px 0 4px -2px rgba(15,23,42,.15);
}
.icnt-table td.icnt-stt-col{left:0}
.icnt-table td.icnt-name-col{left:44px}
.icnt-table thead th.icnt-stt-col,
.icnt-table thead th.icnt-name-col{
  z-index:20;
  box-shadow:2px 0 4px -2px rgba(15,23,42,.15),0 2px 4px -1px rgba(15,23,42,.12);
}
.icnt-table thead th.icnt-stt-col{left:0}
.icnt-table thead th.icnt-name-col{left:44px}
.icnt-table tr.icnt-row-focused td{
  outline:1px solid #93c5fd;
  outline-offset:-1px;
}
.icnt-savebar{
  position:fixed;
  left:272px;
  right:0;
  bottom:0;
  z-index:30;
  background:#fff;
  border-top:1px solid #E2E8F0;
  box-shadow:0 -6px 16px rgba(15,23,42,.10);
  padding:12px 26px;
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:14px;
  flex-wrap:wrap;
}
@media(max-width:1100px){.icnt-savebar{left:238px}}
@media(max-width:760px){.icnt-savebar{left:0}}
`;

// Excel-style Enter/ArrowUp/ArrowDown: move focus to the same column (Actual
// Quantity) in the next/previous VISIBLE row. Tab needs no code — plain
// focusable inputs in DOM order already tab correctly. Kept local to this
// page (not the shared POS keyboard util) so nothing else can regress.
function moveAdjGridFocus(e){
  const key=e.key;
  if(key!=='Enter'&&key!=='ArrowDown'&&key!=='ArrowUp')return;
  e.preventDefault();
  const visible=[...document.querySelectorAll('input[data-adj-qty]')].filter(el=>el.offsetParent!==null);
  const curIdx=visible.indexOf(e.currentTarget);
  if(curIdx<0)return;
  const targetIdx=(key==='ArrowUp')?Math.max(0,curIdx-1):Math.min(visible.length-1,curIdx+1);
  const target=visible[targetIdx];
  if(target){target.focus();target.select();}
}

// Try to pull the failing product's name out of the backend error message so
// we can scroll/focus that row — messages are built as `Mặt hàng "X" ...` /
// `Không đủ tồn kho "X" ...` / `... cho mặt hàng ID=123` in
// InventoryAdjustmentAgent._applyOneAdjustment / createBatch.
function parseFailedProductRef(message){
  if(!message)return null;
  const quoted=message.match(/"([^"]+)"/);
  if(quoted)return{by:'name',value:quoted[1]};
  const idMatch=message.match(/ID=(\d+)/);
  if(idMatch)return{by:'id',value:Number(idMatch[1])};
  return null;
}

function formatLastCount(value){
  if(!value)return'Chưa kiểm kê';
  return String(value).slice(0,16).replace('T',' ');
}

export default function InventoryAdjustments(){
  const[rows,setRows]=useState([]);
  const[searchInput,setSearchInput]=useState('');
  const[search,setSearch]=useState('');
  const[categoryId,setCategoryId]=useState('');
  const[categories,setCategories]=useState([]);
  const[onlyChanged,setOnlyChanged]=useState(false);
  const[saving,setSaving]=useState(false);
  const[history,setHistory]=useState([]);
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState('');
  const[focusedProductId,setFocusedProductId]=useState(null);
  const tableWrapRef=useRef(null);
  const searchInputRef=useRef(null);

  // #9 — 150ms debounce: typing updates searchInput immediately (so the
  // input itself never feels laggy), but row filtering only recomputes 150ms
  // after the user stops typing.
  useEffect(()=>{
    const t=setTimeout(()=>setSearch(searchInput),SEARCH_DEBOUNCE_MS);
    return()=>clearTimeout(t);
  },[searchInput]);

  const loadProducts=async()=>{
    // Server-side filter is authoritative — the client-side re-filter below
    // is defense in depth only, never the primary guard against CARCASS_PART/
    // NON_STOCK leaking into this screen.
    const r=await api.get('/products',{params:{inventory_mode:'TRACK_STOCK'}});
    const trackStock=(r.data||[]).filter(p=>String(p.inventory_mode||'')==='TRACK_STOCK');
    setRows(prev=>{
      // Preserve any in-progress edits for products that still exist, so a
      // background reload (e.g. after a partially-relevant action) never
      // silently discards typed values. On first load prev is empty and this
      // is just a plain map.
      const prevById=Object.fromEntries(prev.map(r=>[r.product_id,r]));
      return trackStock.map(p=>{
        const keep=prevById[p.id];
        return{
          product_id:p.id,
          product_code:p.product_code,
          product_name:p.name,
          category_id:p.category_id||null,
          category_name:p.category_name||'',
          unit:p.unit||'kg',
          current_quantity:Number(p.stock_quantity||0),
          actual_quantity:keep?keep.actual_quantity:Number(p.stock_quantity||0),
          reason:keep?keep.reason:'STOCK_COUNT',
          remark:keep?keep.remark:'',
          last_count_at:p.last_count_at||null,
        };
      });
    });
  };
  const loadCategories=async()=>{
    const r=await api.get('/products/categories');
    setCategories(r.data||[]);
  };
  const loadHistory=async()=>{
    const r=await api.get('/inventory-adjustments',{params:{limit:100}});
    setHistory(r.data||[]);
  };

  useEffect(()=>{
    (async()=>{
      try{await Promise.all([loadProducts(),loadCategories(),loadHistory()]);}
      catch(e){setError(e.response?.data?.message||e.message);}
      finally{setLoading(false);}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  const setRow=(productId,patch)=>setRows(rows.map(r=>r.product_id===productId?{...r,...patch}:r));

  const isRowDirty=r=>Math.abs(Number(r.actual_quantity||0)-r.current_quantity)>ZERO_TOLERANCE;

  const dirtyRows=useMemo(()=>rows.filter(isRowDirty),[rows]);

  // #6/#7 — total increased/decreased quantity across every dirty row (what
  // Save All will actually apply), independent of the current visible filter.
  const totals=useMemo(()=>{
    let increaseQty=0,decreaseQty=0;
    for(const r of dirtyRows){
      const diff=Number(r.actual_quantity||0)-r.current_quantity;
      if(diff>0)increaseQty+=diff; else decreaseQty+=Math.abs(diff);
    }
    return{increaseQty,decreaseQty};
  },[dirtyRows]);

  const filteredRows=useMemo(()=>{
    const q=search.trim().toLowerCase();
    return rows.filter(r=>{
      if(categoryId&&String(r.category_id||'')!==String(categoryId))return false;
      if(q&&!String(r.product_name+' '+(r.product_code||'')).toLowerCase().includes(q))return false;
      if(onlyChanged&&!isRowDirty(r))return false;
      return true;
    });
  },[rows,search,categoryId,onlyChanged]);

  const summary=useMemo(()=>{
    let changed=0,increased=0,decreased=0;
    for(const r of filteredRows){
      const diff=Number(r.actual_quantity||0)-r.current_quantity;
      if(Math.abs(diff)>ZERO_TOLERANCE){
        changed++;
        if(diff>0)increased++; else decreased++;
      }
    }
    return{displayed:filteredRows.length,changed,increased,decreased};
  },[filteredRows]);

  const hasActiveFilters=!!(searchInput||categoryId||onlyChanged);
  const clearFilters=()=>{
    setSearchInput('');
    setCategoryId('');
    setOnlyChanged(false);
  };

  const scrollToFailedRow=(message)=>{
    const ref=parseFailedProductRef(message);
    if(!ref)return;
    const row=rows.find(r=>ref.by==='name'?r.product_name===ref.value:r.product_id===ref.value);
    if(!row)return;
    const input=document.querySelector(`input[data-adj-qty][data-product-id="${row.product_id}"]`);
    if(input){
      input.scrollIntoView({behavior:'smooth',block:'center'});
      input.focus();
    }
  };

  const saveAll=async()=>{
    if(!dirtyRows.length)return showWarning('Không có thay đổi nào để lưu. Sửa Số lượng thực tế cho các dòng cần điều chỉnh.');
    const missingReason=dirtyRows.find(r=>!r.reason);
    if(missingReason)return showWarning(`Chọn lý do điều chỉnh cho "${missingReason.product_name}"`);
    // Capture totals before the post-save reload wipes dirtyRows back to
    // empty (Save All clears every dirty row it touched).
    const savedIncreaseQty=totals.increaseQty;
    const savedDecreaseQty=totals.decreaseQty;
    try{
      setSaving(true);
      const r=await api.post('/inventory-adjustments/batch',{
        items:dirtyRows.map(x=>({product_id:x.product_id,actual_quantity:x.actual_quantity,reason:x.reason,remark:x.remark||null})),
      });
      showSuccess(`Đã kiểm kê và điều chỉnh ${r.data.items_adjusted} mặt hàng. Tăng +${formatQty(savedIncreaseQty)}, Giảm -${formatQty(savedDecreaseQty)}.`);
      await Promise.all([loadProducts(),loadHistory()]);
      if(tableWrapRef.current){
        tableWrapRef.current.scrollTop=0;
        tableWrapRef.current.scrollLeft=0;
      }
      // #8 — focus AND select so the user can immediately type a new search
      // term without manually clearing the field first.
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }catch(e){
      const message=e.response?.data?.message||e.message||'Không thể lưu kết quả kiểm kê';
      showError(message);
      scrollToFailedRow(message);
    }finally{setSaving(false);}
  };

  const resetAll=()=>setRows(rows.map(r=>({...r,actual_quantity:r.current_quantity,reason:'STOCK_COUNT',remark:''})));

  useEffect(()=>{
    const onKeyDown=(e)=>{
      if((e.ctrlKey||e.metaKey)&&(e.key==='s'||e.key==='S')){
        e.preventDefault();
        saveAll();
      }
    };
    window.addEventListener('keydown',onKeyDown);
    return()=>window.removeEventListener('keydown',onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[rows]);

  // #9/#10 — background auto-refresh every 30s, but ONLY while the grid is
  // fully clean. The instant any row becomes dirty this effect re-runs (its
  // dependency flips to false), the cleanup below clears the pending
  // interval, and the countdown fully pauses — it resumes as a fresh 30s
  // cycle only once the grid returns to clean, never a stale partial tick.
  const isClean=dirtyRows.length===0;
  useEffect(()=>{
    if(!isClean)return;
    const id=setInterval(()=>{
      loadProducts().catch(()=>{});
      loadHistory().catch(()=>{});
    },30000);
    return()=>clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[isClean]);

  const onQtyKeyDown=(r)=>(e)=>{
    if(e.key==='Escape'){
      e.preventDefault();
      setRow(r.product_id,{actual_quantity:r.current_quantity});
      e.currentTarget.value=r.current_quantity;
      return;
    }
    moveAdjGridFocus(e);
  };
  const onQtyDoubleClick=(r)=>(e)=>{
    setRow(r.product_id,{actual_quantity:r.current_quantity});
    e.currentTarget.value=r.current_quantity;
    e.currentTarget.select();
  };

  return <SafePage loading={loading} error={error}>
    <style>{inventoryCountStyles}</style>
    <div className="icnt-page">
    <div className="card">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:10}}>
        <div>
          <h3 style={{marginBottom:4}}>Kiểm kê tồn kho</h3>
          <p className="muted" style={{margin:0}}>Nhập số lượng thực tế sau khi kiểm kê. Hệ thống sẽ tự tính chênh lệch và tạo điều chỉnh tăng/giảm tồn kho cho các mặt hàng có thay đổi.</p>
        </div>
        <div className="actions">
          <span className="pill warn">{dirtyRows.length} dòng thay đổi</span>
          <button className="btn secondary" onClick={resetAll} disabled={saving}>Khôi phục số lượng hiện tại</button>
          <button className="btn" onClick={saveAll} disabled={saving||!dirtyRows.length}>{saving?'Đang lưu...':'Lưu kết quả kiểm kê'}</button>
        </div>
      </div>

      <div style={{display:'flex',gap:10,flexWrap:'wrap',alignItems:'center',marginTop:10}}>
        <input ref={searchInputRef} className="input" style={{maxWidth:280}} placeholder="Tìm mã hàng, tên mặt hàng..." value={searchInput} onChange={e=>setSearchInput(e.target.value)}/>
        <select className="select" style={{maxWidth:220}} value={categoryId} onChange={e=>setCategoryId(e.target.value)}>
          <option value="">Tất cả danh mục</option>
          {categories.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <label style={{display:'flex',alignItems:'center',gap:6,fontSize:13}}>
          <input type="checkbox" checked={onlyChanged} onChange={e=>setOnlyChanged(e.target.checked)}/>
          Chỉ hiện dòng có chênh lệch
        </label>
      </div>

      <div style={{display:'flex',gap:16,flexWrap:'wrap',marginTop:10,fontSize:13}} className="muted">
        <span>Hiển thị: <b>{summary.displayed} / {rows.length}</b> mặt hàng</span>
        <span>Thay đổi: <b>{summary.changed}</b></span>
        <span>Tăng: <b style={{color:'#16a34a'}}>{summary.increased}</b> ({'+' + formatQty(totals.increaseQty)})</span>
        <span>Giảm: <b style={{color:'#dc2626'}}>{summary.decreased}</b> (-{formatQty(totals.decreaseQty)})</span>
      </div>

      <div ref={tableWrapRef} className="icnt-table-wrap" style={{marginTop:10}}>
        <table className="table icnt-table">
          <thead>
            <tr>
              <th className="icnt-stt-col" style={{textAlign:'center',width:44,minWidth:44,maxWidth:44}}>STT</th>
              <th className="icnt-name-col">Tên mặt hàng</th>
              <th>Mã hàng</th>
              <th style={{textAlign:'center'}}>Đơn vị</th>
              <th style={{textAlign:'right'}}>Tồn hiện tại</th>
              <th style={{textAlign:'right'}}>Số lượng thực tế</th>
              <th style={{textAlign:'right'}}>Chênh lệch</th>
              <th>Lý do</th>
              <th>Ghi chú</th>
              <th>Lần kiểm kê cuối</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((r,idx)=>{
              const diff=Number(r.actual_quantity||0)-r.current_quantity;
              const isDirty=Math.abs(diff)>ZERO_TOLERANCE;
              const isFocused=focusedProductId===r.product_id;
              const dirtyBg=isDirty?(diff>0?'#f0fdf4':'#fef2f2'):null;
              const zebraClass=!isDirty&&idx%2===1?'icnt-row-even':'';
              const rowClass=[zebraClass,isFocused?'icnt-row-focused':''].filter(Boolean).join(' ');
              return <tr key={r.product_id} className={rowClass} style={dirtyBg?{background:dirtyBg}:undefined}>
                <td className="icnt-stt-col muted" style={{textAlign:'center',width:44,minWidth:44,maxWidth:44,background:dirtyBg||undefined}}>{idx+1}</td>
                <td className="icnt-name-col" style={dirtyBg?{background:dirtyBg}:undefined}>
                  <b>{r.product_name}</b>
                  {isDirty&&<div><span style={{display:'inline-block',marginTop:4,fontSize:10,fontWeight:800,letterSpacing:'.03em',color:'#fff',background:diff>0?'#16a34a':'#dc2626',borderRadius:999,padding:'2px 7px'}}>CHƯA LƯU</span></div>}
                </td>
                <td>{r.product_code}</td>
                <td className="muted" style={{textAlign:'center'}}>{r.unit}</td>
                <td style={{textAlign:'right',background:'#f3f4f6',color:'#6b7280'}}>{formatQty(r.current_quantity)}</td>
                <td style={{textAlign:'right'}}>
                  <input
                    className="input icnt-qty-input"
                    style={{width:110,textAlign:'right',background:isDirty?'#fffbeb':'#fff',borderColor:isDirty?'#f59e0b':undefined}}
                    type="number"
                    step="0.001"
                    min={0}
                    data-adj-qty="true"
                    data-product-id={r.product_id}
                    value={r.actual_quantity}
                    onChange={e=>setRow(r.product_id,{actual_quantity:e.target.value===''?'':Number(e.target.value)})}
                    onKeyDown={onQtyKeyDown(r)}
                    onDoubleClick={onQtyDoubleClick(r)}
                    onFocus={()=>setFocusedProductId(r.product_id)}
                    onBlur={()=>setFocusedProductId(prev=>prev===r.product_id?null:prev)}
                  />
                </td>
                <td style={{textAlign:'right',fontWeight:isDirty?700:400,color:diff>0?'#16a34a':(diff<0?'#dc2626':'inherit')}}>
                  {isDirty?(diff>0?'+':'')+formatQty(diff):'—'}
                </td>
                <td>
                  <select className="select" value={r.reason} disabled={!isDirty} onChange={e=>setRow(r.product_id,{reason:e.target.value})}>
                    {REASON_OPTIONS.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </td>
                <td>
                  <input className="input" style={{minWidth:140}} disabled={!isDirty} placeholder="Ghi chú" value={r.remark} onChange={e=>setRow(r.product_id,{remark:e.target.value})}/>
                </td>
                <td className="muted" style={{whiteSpace:'nowrap'}}>{formatLastCount(r.last_count_at)}</td>
              </tr>;
            })}
            {!filteredRows.length&&<tr><td colSpan={10} style={{textAlign:'center',padding:32}}>
              <Search size={26} style={{color:'#94a3b8',marginBottom:8}}/>
              <div className="muted" style={{fontWeight:700,marginBottom:4}}>Không tìm thấy mặt hàng phù hợp</div>
              <div className="muted" style={{fontSize:13,marginBottom:hasActiveFilters?10:0}}>Thử đổi từ khóa tìm kiếm, chọn danh mục khác, hoặc bỏ chọn "Chỉ hiện dòng có chênh lệch".</div>
              {hasActiveFilters&&<button className="btn secondary" onClick={clearFilters}>Xóa bộ lọc</button>}
            </td></tr>}
          </tbody>
        </table>
      </div>
    </div>

    <div className="card">
      <h3>Lịch sử điều chỉnh tồn kho</h3>
      <table className="table">
        <thead><tr><th>Số phiếu</th><th>Mặt hàng</th><th>Loại</th><th>Số lượng</th><th>Lý do</th><th>Ghi chú</th><th>Người tạo</th><th>Thời gian</th></tr></thead>
        <tbody>
          {history.map(h=><tr key={h.id}>
            <td><b>{h.adjustment_code}</b></td>
            <td>{h.product_name||`#${h.product_id}`}{h.product_code&&<div className="muted" style={{fontSize:11}}>{h.product_code}</div>}</td>
            <td>{h.direction==='INCREASE'?<span className="pill ok">Tăng</span>:<span className="pill warn">Giảm</span>}</td>
            <td>{formatQty(h.quantity)}</td>
            <td>{REASON_LABEL[h.reason]||h.reason}</td>
            <td>{h.remark||'—'}</td>
            <td>{h.created_by_name||'—'}</td>
            <td>{String(h.created_at||'').slice(0,16).replace('T',' ')}</td>
          </tr>)}
          {!history.length&&<tr><td colSpan={8} className="muted" style={{textAlign:'center',padding:24}}>Chưa có phiếu điều chỉnh nào</td></tr>}
        </tbody>
      </table>
    </div>
    </div>

    <div className="icnt-savebar">
      <div style={{display:'flex',gap:16,flexWrap:'wrap',alignItems:'center',fontSize:13}}>
        <b>{dirtyRows.length?`Có ${dirtyRows.length} mặt hàng chưa lưu.`:'Không có thay đổi nào.'}</b>
        <span>Tăng: <b style={{color:'#16a34a'}}>+{formatQty(totals.increaseQty)}</b></span>
        <span>Giảm: <b style={{color:'#dc2626'}}>-{formatQty(totals.decreaseQty)}</b></span>
      </div>
      <div className="actions">
        <button className="btn secondary" onClick={resetAll} disabled={saving}>Khôi phục số lượng hiện tại</button>
        <button className="btn" onClick={saveAll} disabled={saving||!dirtyRows.length}>{saving?'Đang lưu...':'Lưu kết quả kiểm kê'}</button>
      </div>
    </div>
  </SafePage>;
}
