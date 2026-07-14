import React,{useEffect,useMemo,useRef,useState}from'react';import {Trash2} from'lucide-react';import api from'../api/api';import SafePage from'../components/SafePage';import MoneyInput from'../components/MoneyInput';import {moneyVnd} from'../utils/money';import {handlePosInputKeyNavigation} from'../utils/focusNavigation';import EnterpriseAutocomplete from'../components/common/EnterpriseAutocomplete';import {showSuccess,showError,showWarning,showInfo} from'../utils/toast';

function isBusinessPartner(item){
  const t=Number(item.partner_type||0);
  return (t&1)===1||(t&2)===2;
}

export default function PriceMatrix(){
  const[customers,setCustomers]=useState([]);
  const[categories,setCategories]=useState([]);
  const[customerCategories,setCustomerCategories]=useState([]);
  const[addCategoryPickerId,setAddCategoryPickerId]=useState('');
  const[categoryDragId,setCategoryDragId]=useState(null);
  const[cid,setCid]=useState('');
  const[categoryId,setCategoryId]=useState('');
  const[data,setData]=useState(null);
  const[rows,setRows]=useState([]);
  const[copyTo,setCopyTo]=useState('');
  const[dragId,setDragId]=useState(null);
  const[fileImport,setFileImport]=useState(null);
  const[priceSheetFilter,setPriceSheetFilter]=useState('');
  const todayIso=new Date().toISOString().slice(0,10);
  const[effectiveFrom,setEffectiveFrom]=useState(todayIso);
  const[effectiveLunarDateText,setEffectiveLunarDateText]=useState('01/01/2026');
  const[copyEffectiveFrom,setCopyEffectiveFrom]=useState(todayIso);
  const[copyEffectiveLunarDateText,setCopyEffectiveLunarDateText]=useState('01/01/2026');
  const fileInputRef=useRef(null);const priceImportReadSeqRef=useRef(0);
  const resetPriceImportFileInput=()=>{
    priceImportReadSeqRef.current+=1;
    if(fileInputRef.current) fileInputRef.current.value='';
  };
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState('');
  const[books,setBooks]=useState([]);
  const[bookDetail,setBookDetail]=useState(null);
  const[bookItems,setBookItems]=useState([]);
  const[bookBusy,setBookBusy]=useState(false);
  const[showPickModal,setShowPickModal]=useState(false);
  const[newBookMode,setNewBookMode]=useState(false);
  const[customerLoading,setCustomerLoading]=useState(false);
  const[bookAddItems,setBookAddItems]=useState([]);
  const[rowsLoading,setRowsLoading]=useState(false);
  const[rowSearch,setRowSearch]=useState('');
  const[rowPage,setRowPage]=useState(1);
  const[rowPageSize,setRowPageSize]=useState(20);

  const loadCustomers=async()=>{
    const c=(await api.get('/customers')).data||[];
    setCustomers(c);
  };
  const loadCategories=async()=>{
    const c=(await api.get('/products/categories')).data||[];
    setCategories(c);
  };

  // S4.3: a bạn hàng's price books are scoped under their Customer Price Categories, not
  // the raw global category list — load the ones already set up for this customer.
  const loadCustomerCategories=async(id)=>{
    if(!id){setCustomerCategories([]);return[];}
    const r=(await api.get('/price-matrix/'+id+'/categories')).data;
    setCustomerCategories(r.categories||[]);
    return r.categories||[];
  };

  // Perf fix: loadMatrix() always re-fetched the books list too, even when the caller had
  // just fetched it seconds earlier (tryLoadSelection/enterNewBookMode, the "Xem/Sửa" button)
  // — a measured, unnecessary duplicate GET /price-matrix/:id/books on the hot "open a
  // category" path. refreshBooks defaults to true so callers that DO need a fresh list after
  // a mutation (save(), saveBook()) keep their existing behavior unchanged.
  const loadMatrix=async(id,catId=categoryId,{refreshBooks=true}={})=>{
    if(!id||!catId)return;
    const r=(await api.get('/price-matrix/'+id,{params:{category_id:catId}})).data;
    setData(r);
    setRows((r.rows||[]).map((x,i)=>({...x, sort_order:x.sort_order||i+1, in_catalog:!!x.in_catalog})));
    if(refreshBooks)await loadBooks(id,catId);
  };

  const loadBooks=async(id=cid,catId=categoryId)=>{
    if(!id||!catId)return[];
    const r=(await api.get('/price-matrix/'+id+'/books',{params:{category_id:catId}})).data||[];
    setBooks(r);
    return r;
  };

  useEffect(()=>{let m=true;(async()=>{try{await Promise.all([loadCustomers(),loadCategories()])}catch(e){if(m)setError(e.response?.data?.message||e.message)}finally{if(m)setLoading(false)}})();return()=>{m=false}},[]);

  const selectedCustomer=customers.find(c=>String(c.id)===String(cid))||data?.customer||{};
  const effectiveCalendarType=String(selectedCustomer.billing_calendar_type||'SOLAR').toUpperCase()==='LUNAR'?'LUNAR':'SOLAR';
  const effectivePayload=()=>effectiveCalendarType==='LUNAR'
    ? {effective_calendar_type:'LUNAR',effective_lunar_date_text:effectiveLunarDateText}
    : {effective_calendar_type:'SOLAR',effective_from:effectiveFrom};
  const effectiveLabel=effectiveCalendarType==='LUNAR'?`${effectiveLunarDateText} ÂL`:effectiveFrom;

  // CTO calendar-mismatch fix: Copy creates a NEW price book for the DESTINATION customer
  // (copyTo), not the customer currently being viewed (cid) — its calendar type must come
  // from copyTo's own billing_calendar_type, never from the source's effectiveCalendarType.
  // Sending the source's type here was the actual reproduced root cause of
  // CALENDAR_TYPE_MISMATCH: copying between a SOLAR and a LUNAR customer always failed.
  const copyToCustomer=customers.find(c=>String(c.id)===String(copyTo))||{};
  const copyCalendarType=String(copyToCustomer.billing_calendar_type||'SOLAR').toUpperCase()==='LUNAR'?'LUNAR':'SOLAR';
  const copyEffectivePayload=()=>copyCalendarType==='LUNAR'
    ? {effective_calendar_type:'LUNAR',effective_lunar_date_text:copyEffectiveLunarDateText}
    : {effective_calendar_type:'SOLAR',effective_from:copyEffectiveFrom};
  const copyEffectiveLabel=copyCalendarType==='LUNAR'?`${copyEffectiveLunarDateText} ÂL`:copyEffectiveFrom;

  // Selecting a copy target re-initializes its own effective-date state from scratch — never
  // carries over whatever was left in the source customer's date fields.
  const changeCopyTo=(id)=>{
    setCopyTo(id);
    setCopyEffectiveFrom(todayIso);
    setCopyEffectiveLunarDateText('01/01/2026');
  };

  const resetSelectionUi=()=>{
    setShowPickModal(false);setNewBookMode(false);setRowsLoading(false);
    setBookDetail(null);setBookItems([]);setBookAddItems([]);
    setRowSearch('');setRowPage(1);
    setData(null);setRows([]);setBooks([]);
  };

  // S4.2: category is the pricing scope, same rank as customer — the matrix/books
  // for a customer only load once BOTH a customer and a Danh mục hàng hóa are chosen.
  const tryLoadSelection=async(id,catId)=>{
    if(!id||!catId)return;
    setCustomerLoading(true);
    try{
      const bks=await loadBooks(id,catId);
      const active=(bks||[]).filter(b=>String(b.status||'ACTIVE')!=='DELETED');
      if(active.length){setShowPickModal(true);}
      else{await enterNewBookMode(id,catId);}
    }finally{setCustomerLoading(false)}
  };

  // CTO fix: "Tạo bảng giá mới" must immediately show the effective date AND immediately
  // load the category's product list — never leave the page empty while loading. Products
  // load from the Product Category (matrix()), never from an existing Price Book — there may
  // not be one yet (0 books) or we're intentionally starting a new version alongside existing
  // ones. setNewBookMode(true) is synchronous and renders the persistent effective-date card
  // (below, in JSX) BEFORE any network call — the date is never gated behind a network round
  // trip. rowsLoading covers the (possibly several-second, real-DB-latency) gap while
  // loadMatrix() is in flight, so the product table shows a loading state instead of looking
  // empty/broken.
  const enterNewBookMode=async(id,catId)=>{
    setNewBookMode(true);
    setRowsLoading(true);
    try{
      // refreshBooks:false — every caller of enterNewBookMode (tryLoadSelection's 0-books
      // branch, the "+ Thêm bảng giá mới" button) already fetched the books list moments ago.
      await loadMatrix(id,catId,{refreshBooks:false});
      setRows(prev=>prev.map(r=>({...r,in_catalog:Number(r.private_price||0)>0})));
    }finally{
      setRowsLoading(false);
    }
  };

  const changeCustomer=async(id)=>{
    resetSelectionUi();
    setCategoryId('');
    setAddCategoryPickerId('');
    if(!id){setCid('');setCustomerCategories([]);return;}
    setCid(id);
    await loadCustomerCategories(id);
  };

  const changeCategory=async(catId)=>{
    resetSelectionUi();
    setCategoryId(catId);
    await tryLoadSelection(cid,catId);
  };

  const unassignedCustomerCategories=useMemo(
    ()=>categories.filter(c=>!customerCategories.some(cc=>String(cc.category_id)===String(c.id))),
    [categories,customerCategories]
  );

  // Single explicit-confirm entry point for creating a Customer Price Category — reused by
  // both this admin screen and POS's guided init. Never created silently.
  const confirmAddCustomerCategory=async()=>{
    if(!cid||!addCategoryPickerId)return showWarning('Chọn danh mục hàng hóa cần thêm');
    const catName=categories.find(c=>String(c.id)===String(addCategoryPickerId))?.name||'';
    if(!await window.appConfirm(`Xác nhận thêm danh mục "${catName}" cho bạn hàng này?`,{title:'Thêm danh mục giá',confirmText:'Thêm',variant:'info'}))return;
    setCustomerLoading(true);
    try{
      await api.post('/price-matrix/'+cid+'/categories',{category_id:addCategoryPickerId});
      const newCategoryId=addCategoryPickerId;
      await loadCustomerCategories(cid);
      setAddCategoryPickerId('');
      await changeCategory(newCategoryId);
    }catch(e){
      showError(e.response?.data?.message||e.message||'Không thể thêm danh mục');
    }finally{
      setCustomerLoading(false);
    }
  };

  const setCategoryDefault=async(id)=>{
    await api.put('/price-matrix/categories/'+id+'/default',{});
    await loadCustomerCategories(cid);
  };

  const handleCategoryDrop=async(targetRowId)=>{
    if(!categoryDragId||categoryDragId===targetRowId)return;
    const arr=[...customerCategories];
    const from=arr.findIndex(x=>x.id===categoryDragId);
    const to=arr.findIndex(x=>x.id===targetRowId);
    if(from<0||to<0)return;
    const[moved]=arr.splice(from,1);
    arr.splice(to,0,moved);
    const reordered=arr.map((x,i)=>({...x,display_order:i+1}));
    setCustomerCategories(reordered);
    setCategoryDragId(null);
    await api.put('/price-matrix/'+cid+'/categories/reorder',{items:reordered.map(x=>({id:x.id,display_order:x.display_order}))});
  };
  const setRow=(idx,patch)=>setRows(rows.map((r,i)=>i===idx?{...r,...patch}:r));
  const save=async()=>{
    if(effectiveCalendarType==='LUNAR'&&!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(effectiveLunarDateText))return showWarning('Chọn ngày hiệu lực âm lịch dạng DD/MM/YYYY');
    if(effectiveCalendarType==='SOLAR'&&!effectiveFrom)return showWarning('Chọn ngày hiệu lực cho bảng giá');
    if(newBookMode){
      const dup=books.find(b=>String(b.status||'ACTIVE')!=='DELETED'&&(effectiveCalendarType==='LUNAR'?b.effective_lunar_date_text===effectiveLunarDateText:String(b.effective_from||'').slice(0,10)===effectiveFrom));
      if(dup)return showWarning('Bảng giá của ngày này đã tồn tại. Vui lòng chỉnh sửa bảng giá hiện có.');
    }
    await api.put('/price-matrix/'+cid,{...effectivePayload(),items:rows.map((x,i)=>({...x,sort_order:i+1})),category_id:categoryId});
    showSuccess('Đã lưu bảng giá riêng và thứ tự danh mục. Ngày hiệu lực: '+effectiveLabel);
    setNewBookMode(false);await loadMatrix(cid)
  };
  const copy=async()=>{
    if(!copyTo)return showWarning('Chọn bạn hàng nhận copy');
    if(copyCalendarType==='LUNAR'&&!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(copyEffectiveLunarDateText))return showWarning('Chọn ngày hiệu lực âm lịch dạng DD/MM/YYYY cho bạn hàng nhận copy');
    if(copyCalendarType==='SOLAR'&&!copyEffectiveFrom)return showWarning('Chọn ngày hiệu lực cho bảng giá copy');
    await api.post('/price-matrix/copy',{from_customer_id:cid,to_customer_id:copyTo,...copyEffectivePayload(),category_id:categoryId});
    showSuccess('Đã copy bảng giá. Ngày hiệu lực: '+copyEffectiveLabel);
  };
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


  const openBook=async(bookId)=>{
    setBookBusy(true);
    try{
      const r=(await api.get('/price-matrix/books/'+bookId)).data;
      setBookDetail(r);
      const items=(r.items||[]).map(x=>({...x,sale_price:Number(x.sale_price||0)}));
      setBookItems(items);
      // Candidates must come from the book's OWN immutable category identity (r.customer_id /
      // r.category_id), fetched fresh right here — never from the page-level `rows` state.
      // `rows` is reset to [] by changeCategory()'s resetSelectionUi() before the book picker
      // even opens, and this closure's `rows` reference stays stale to that same render even
      // after a later loadMatrix() call updates it — so candidates always came out empty.
      const catalog=(await api.get('/price-matrix/'+r.customer_id,{params:{category_id:r.category_id}})).data;
      const inBook=new Set(items.map(x=>String(x.product_id)));
      setBookAddItems((catalog.rows||[]).filter(x=>!inBook.has(String(x.product_id))).map(x=>({...x,sale_price:0})));
    }catch(e){showError(e.response?.data?.message||e.message||'Không thể mở bảng giá')}
    finally{setBookBusy(false)}
  };
  const setBookItem=(idx,patch)=>setBookItems(bookItems.map((r,i)=>i===idx?{...r,...patch}:r));
  const saveBook=async()=>{
    if(!bookDetail)return;
    // Row-level lock: the book header may be locked (bookDetail.can_edit false), but adding
    // new items or editing/deleting still-unlocked existing items must remain possible — the
    // backend enforces the per-item lock authoritatively and silently ignores any attempted
    // change to a locked row, so it's always safe to attempt a save here.
    setBookBusy(true);
    try{
      const newItems=bookAddItems.filter(x=>x.sale_price>0).map(x=>({product_id:x.product_id,sale_price:x.sale_price,note:x.note||null}));
      const r=(await api.put('/price-matrix/books/'+bookDetail.id,{...bookDetail,items:[...bookItems,...newItems]})).data;
      showSuccess((r.message||'Đã lưu')+(r.recalculated_orders?` Đã cập nhật lại ${r.recalculated_orders} bill chưa thu tiền.`:''));
      setBookDetail(null);setBookItems([]);setBookAddItems([]);await loadMatrix(cid);
    }catch(e){showError(e.response?.data?.message||e.message||'Không thể lưu bảng giá')}
    finally{setBookBusy(false)}
  };

  const normalizeExcelText=(v)=>String(v??'').trim().replace(/\s+/g,' ').toLowerCase();
  const parseMoneyNumber=(v)=>{
    if(v===null||v===undefined)return 0;
    if(typeof v==='number')return Number.isFinite(v)?v:0;
    const cleaned=String(v).replace(/đ|₫|vnd/gi,'').replace(/\s/g,'').replace(/,/g,'').trim();
    const n=Number(cleaned);
    return Number.isFinite(n)?n:0;
  };
  const isProductHeader=(v)=>['mặt hàng','mat hang','danh mục','danh muc','tên hàng','ten hang'].includes(normalizeExcelText(v));
  const isPriceHeader=(v)=>['đơn giá','don gia','giá','gia','giá riêng','gia rieng'].includes(normalizeExcelText(v));

  const readPriceExcel=async(file)=>{
    if(!cid)return showWarning('Chọn bạn hàng trước khi import bảng giá');
    if(!file)return;
    const readSeq=priceImportReadSeqRef.current+1;
    priceImportReadSeqRef.current=readSeq;
    setFileImport(null);
    try{
      const XLSX=await import('xlsx');
      const buf=await file.arrayBuffer();
      if(readSeq!==priceImportReadSeqRef.current)return;
      const wb=XLSX.read(buf,{type:'array'});
      if(readSeq!==priceImportReadSeqRef.current)return;
      const pickSheetNames=(allNames,filterText)=>{
        const raw=String(filterText||'').trim();
        if(!raw)return {names:allNames,missing:[]};
        const requested=raw.split(',').map(x=>x.trim()).filter(Boolean);
        const byLower=new Map(allNames.map(n=>[String(n).trim().toLowerCase(),n]));
        const names=[];
        const missing=[];
        requested.forEach(x=>{
          const found=byLower.get(x.toLowerCase());
          if(found){
            if(!names.includes(found))names.push(found);
          }else missing.push(x);
        });
        return {names,missing};
      };
      const sheetPick=pickSheetNames(wb.SheetNames,priceSheetFilter);
      if(sheetPick.missing.length){
        showWarning(`Không tìm thấy sheet: ${sheetPick.missing.join(', ')}. Các sheet có trong file: ${wb.SheetNames.join(', ')}`);
        return;
      }
      if(!sheetPick.names.length){
        showWarning(`Không có sheet nào được chọn. Các sheet có trong file: ${wb.SheetNames.join(', ')}`);
        return;
      }
      const productMap=new Map();
      const duplicateKeys=[];
      rows.forEach((r,idx)=>{
        const keys=[r.product_name,r.product_code].filter(Boolean).map(normalizeExcelText).filter(Boolean);
        keys.forEach(k=>{
          if(productMap.has(k)) duplicateKeys.push(k);
          else productMap.set(k,{...r,rowIndex:idx});
        });
      });
      const matched=[];
      const unmapped=[];
      const invalid=[];
      sheetPick.names.forEach(sheetName=>{
        const ws=wb.Sheets[sheetName];
        const matrix=XLSX.utils.sheet_to_json(ws,{header:1,defval:''});
        let headerRow=-1,nameCol=-1,priceCol=-1;
        for(let r=0;r<matrix.length;r++){
          const row=matrix[r]||[];
          for(let c=0;c<row.length;c++){
            if(isProductHeader(row[c])){
              const pIdx=row.findIndex(x=>isPriceHeader(x));
              if(pIdx>=0){headerRow=r;nameCol=c;priceCol=pIdx;break;}
            }
          }
          if(headerRow>=0)break;
        }
        if(headerRow<0){
          // fallback: use first two non-empty columns in the sheet
          const colCounts={};
          matrix.forEach(row=>row.forEach((cell,c)=>{if(String(cell??'').trim())colCounts[c]=(colCounts[c]||0)+1;}));
          const cols=Object.entries(colCounts).sort((a,b)=>Number(a[0])-Number(b[0])).map(([c])=>Number(c));
          nameCol=cols[0]??0; priceCol=cols[1]??1; headerRow=-1;
        }
        for(let r=headerRow+1;r<matrix.length;r++){
          const row=matrix[r]||[];
          const rawName=String(row[nameCol]??'').trim();
          const price=parseMoneyNumber(row[priceCol]);
          if(!rawName)continue;
          if(isProductHeader(rawName))continue;
          if(!price){invalid.push({sheetName,rowNumber:r+1,excelName:rawName,price});continue;}
          const key=normalizeExcelText(rawName);
          const found=productMap.get(key);
          if(!found){unmapped.push({sheetName,rowNumber:r+1,excelName:rawName,price});continue;}
          matched.push({sheetName,rowNumber:r+1,excelName:rawName,price,product_id:found.product_id,product_name:found.product_name,rowIndex:found.rowIndex});
        }
      });
      // last occurrence wins, but show all matched rows in preview for audit.
      const byProduct=new Map();
      matched.forEach(x=>byProduct.set(String(x.product_id),x));
      if(readSeq!==priceImportReadSeqRef.current)return;
      setFileImport({fileName:file.name,sheetNames:sheetPick.names,allSheetNames:wb.SheetNames,matched,unmapped,invalid,duplicateKeys:[...new Set(duplicateKeys)],byProduct:[...byProduct.values()]});
    }catch(e){
      if(readSeq===priceImportReadSeqRef.current)showError('Không đọc được file Excel: '+(e.message||e));
    }finally{
      resetPriceImportFileInput();
    }
  };

  const applyPriceExcel=()=>{
    if(!fileImport)return;
    const patch=new Map(fileImport.byProduct.map(x=>[String(x.product_id),x]));
    setRows(rows.map(r=>{
      const x=patch.get(String(r.product_id));
      return x?{...r,private_price:x.price,in_catalog:true}:r;
    }));
    showInfo(`Đã đưa ${fileImport.byProduct.length} mặt hàng vào bảng giá. Ngày hiệu lực: ${effectiveLabel}. Bấm “Lưu tất cả an toàn” để lưu xuống database.`);
    setFileImport(null);
  };

  const saveOrderOnly=async()=>{
    if(!cid)return;
    await api.put('/price-matrix/'+cid+'/catalog/reorder',{items:rows.map((x,i)=>({product_id:x.product_id,sort_order:i+1}))});
    showSuccess('Đã lưu thứ tự kéo thả');
    await loadMatrix(cid);
  };

  const filteredRows=useMemo(()=>{const q=String(rowSearch||'').trim().toLowerCase();if(!q)return rows;return rows.filter(r=>String(r.product_name||'').toLowerCase().includes(q)||String(r.product_code||'').toLowerCase().includes(q)||String(r.category_name||'').toLowerCase().includes(q));},[rows,rowSearch]);
  const rowTotalPages=Math.max(1,Math.ceil(filteredRows.length/rowPageSize));
  const rowCp=Math.min(rowPage,rowTotalPages);
  const visibleRows=filteredRows.slice((rowCp-1)*rowPageSize,rowCp*rowPageSize);
  return <SafePage loading={loading} error={error}>
    <div className="grid">
      <div className="card price-matrix-table-card">
        <h3>Price Matrix Agent - bảng giá riêng theo từng bạn hàng</h3>
        <div className="actions">
          <div style={{width:280,display:'inline-flex'}}>
            <EnterpriseAutocomplete
              items={customers}
              value={customers.find(c=>String(c.id)===String(cid))||null}
              onChange={item=>changeCustomer(item?String(item.id):'')}
              placeholder="Tìm bạn hàng..."
              displayField="name"
              secondaryFields={['customer_code','phone']}
              searchFields={['customer_code','name','phone','address']}
              filter={isBusinessPartner}
              disabled={customerLoading}
              loading={customerLoading}
              emptyText="Không tìm thấy bạn hàng"
              getItemKey={item=>item.id}
            />
          </div>
          <select className="select" style={{width:260}} value={copyTo} onChange={e=>changeCopyTo(e.target.value)}>
            <option value="">Copy bảng này sang bạn hàng...</option>
            {customers.filter(c=>String(c.id)!==String(cid)).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {copyTo&&(
            <label className="muted" style={{display:'flex',alignItems:'center',gap:6}}>
              Ngày hiệu lực cho {copyToCustomer.name||'bạn hàng nhận'} ({copyCalendarType==='LUNAR'?'Âm lịch':'Dương lịch'}):
              {copyCalendarType==='LUNAR'
                ? <input className="input" style={{width:140}} placeholder="DD/MM/YYYY" value={copyEffectiveLunarDateText} onChange={e=>setCopyEffectiveLunarDateText(e.target.value)}/>
                : <input className="input" type="date" style={{width:140}} value={copyEffectiveFrom} onChange={e=>setCopyEffectiveFrom(e.target.value)}/>
              }
            </label>
          )}
          <button className="btn secondary" onClick={copy}>Copy</button>
          <button className="btn secondary" onClick={saveOrderOnly}>Lưu thứ tự kéo thả</button>
          <input className="input" style={{width:360}} placeholder="Sheet import (trống = tất cả, nhiều sheet cách nhau dấu phẩy)" value={priceSheetFilter} onChange={e=>setPriceSheetFilter(e.target.value)}/>
          <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" style={{display:'none'}} onClick={e=>{e.currentTarget.value='';setFileImport(null);}} onChange={e=>{const file=e.target.files?.[0];e.target.value='';readPriceExcel(file);}}/>
          <button className="btn secondary" onClick={()=>{setFileImport(null);resetPriceImportFileInput();fileInputRef.current?.click();}}>Import giá từ Excel</button>
          <button className="btn" onClick={save}>Lưu tất cả an toàn</button>
        </div>

        {cid&&(
          <div className="actions" style={{marginTop:8,alignItems:'center'}}>
            <b className="muted">Danh mục giá:</b>
            {customerCategories.map(c=>(
              <div
                key={c.id}
                draggable
                onDragStart={()=>setCategoryDragId(c.id)}
                onDragOver={e=>e.preventDefault()}
                onDrop={()=>handleCategoryDrop(c.id)}
                className={'pill'+(String(categoryId)===String(c.category_id)?' ok':'')}
                style={{cursor:'move',display:'inline-flex',alignItems:'center',gap:6,padding:'4px 10px'}}
                title="Kéo thả để đổi thứ tự"
              >
                <span style={{cursor:'pointer'}} onClick={()=>changeCategory(c.category_id)}>{c.category_name}</span>
                <button
                  type="button"
                  title={c.is_default?'Danh mục mặc định':'Đặt làm danh mục mặc định'}
                  onClick={()=>setCategoryDefault(c.id)}
                  style={{background:'none',border:'none',cursor:'pointer',padding:0,color:c.is_default?'#f59e0b':'#cbd5e1',fontSize:16,lineHeight:1}}
                >★</button>
              </div>
            ))}
            <select className="select" style={{width:200}} value={addCategoryPickerId} onChange={e=>setAddCategoryPickerId(e.target.value)}>
              <option value="">+ Thêm danh mục...</option>
              {unassignedCustomerCategories.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {addCategoryPickerId&&<button type="button" className="btn tiny secondary" onClick={confirmAddCustomerCategory}>Thêm</button>}
          </div>
        )}

        {data&&<p className="muted">Kéo biểu tượng ☰ để đổi thứ tự danh mục khách. Tick “Dùng trong bill” để mặt hàng xuất hiện trong tạo bill. Giá riêng sẽ áp dụng từ ngày hiệu lực đã chọn. Nếu sửa bảng giá đã dùng cho bill chưa thu tiền, hệ thống tự cập nhật lại bill chưa thu; bill đã thu tiền sẽ khóa không cho sửa.</p>}
        {cid&&!categoryId&&<p className="notice">Chọn danh mục hàng hóa để xem/sửa bảng giá riêng. Mỗi bảng giá chỉ áp dụng cho một danh mục.</p>}
        {cid&&!customerCategories.length&&<p className="notice">Bạn hàng này chưa có danh mục giá nào. Chọn danh mục ở ô "+ Thêm danh mục..." để bắt đầu.</p>}
      </div>

      {/* CTO fix: persistent effective-date card — renders synchronously the instant
          newBookMode becomes true, never gated behind a network round trip, never only
          inside a temporary modal. Follows customers.billing_calendar_type: SOLAR shows the
          SOLAR date input and hides LUNAR, LUNAR shows the LUNAR input and hides SOLAR. Stays
          visible until Save succeeds or the user cancels. */}
      {newBookMode&&cid&&(
        <div className="card" style={{marginBottom:8}}>
          <h3 style={{marginTop:0}}>Tạo bảng giá mới</h3>
          <p className="muted">Bạn hàng <b>{selectedCustomer.name||''}</b> · Danh mục <b>{categories.find(c=>String(c.id)===String(categoryId))?.name||''}</b></p>
          <div className="actions" style={{alignItems:'center'}}>
            {effectiveCalendarType==='LUNAR'
              ? <label className="muted" style={{display:'flex',alignItems:'center',gap:8}}>Ngày hiệu lực Âm lịch:
                  <input className="input" style={{width:170}} placeholder="DD/MM/YYYY" value={effectiveLunarDateText} onChange={e=>setEffectiveLunarDateText(e.target.value)}/>
                </label>
              : <label className="muted" style={{display:'flex',alignItems:'center',gap:8}}>Ngày hiệu lực:
                  <input className="input" type="date" style={{width:170}} value={effectiveFrom} onChange={e=>setEffectiveFrom(e.target.value)}/>
                </label>
            }
            <button type="button" className="btn secondary" onClick={()=>{setNewBookMode(false);setRowsLoading(false);setData(null);setRows([]);}}>Hủy</button>
          </div>
        </div>
      )}
      <div className="card">
        <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:10}}><input className="input" style={{maxWidth:320}} placeholder="Tìm sản phẩm..." value={rowSearch} onChange={e=>{setRowSearch(e.target.value);setRowPage(1);}}/>{rowSearch&&<button className="btn secondary" onClick={()=>{setRowSearch('');setRowPage(1);}}>Xóa lọc</button>}<span className="muted">{filteredRows.length}/{rows.length} sản phẩm</span></div>
        {rowsLoading&&<p className="notice">Đang tải danh sách mặt hàng...</p>}
        <table className="table">
          <thead><tr><th></th><th>Dùng trong bill</th><th>STT</th><th>Mặt hàng</th><th>Giá chung</th><th>Giá riêng khách này</th><th>Mode</th></tr></thead>
          <tbody>{visibleRows.map(r=>{const idx=rows.findIndex(x=>x.product_id===r.product_id);return <tr key={r.product_id} draggable onDragStart={()=>setDragId(r.product_id)} onDragOver={e=>e.preventDefault()} onDrop={()=>handleDrop(r.product_id)} style={{cursor:'move'}}>
            <td>☰</td>
            <td><input type="checkbox" checked={!!r.in_catalog} onChange={e=>setRow(idx,{in_catalog:e.target.checked})}/></td>
            <td><input className="input" style={{width:70}} value={idx+1} readOnly/></td>
            <td><b>{r.product_name}</b><br/><span className="muted">{r.category_name} · {r.product_code}</span></td>
            <td>{moneyVnd(r.default_sale_price)}</td>
            <td><MoneyInput value={r.private_price??0} onChange={v=>setRow(idx,{private_price:v,...(newBookMode&&{in_catalog:Number(v)>0})})} data-pos-nav="true" onKeyDown={handlePosInputKeyNavigation}/></td>
            <td>{r.inventory_mode}</td>
          </tr>;})}</tbody>
        </table>
        <div style={{display:'flex',justifyContent:'flex-end',alignItems:'center',gap:8,marginTop:12,flexWrap:'wrap'}}><select className="select" value={rowPageSize} onChange={e=>{setRowPageSize(Number(e.target.value));setRowPage(1);}} style={{width:'auto'}}><option value={10}>10 / trang</option><option value={20}>20 / trang</option><option value={50}>50 / trang</option><option value={100}>100 / trang</option></select><span className="muted">Trang {rowCp} / {rowTotalPages}</span><button className="btn secondary" disabled={rowCp<=1} onClick={()=>setRowPage(p=>Math.max(1,p-1))}>Trước</button><button className="btn secondary" disabled={rowCp>=rowTotalPages} onClick={()=>setRowPage(p=>Math.min(rowTotalPages,p+1))}>Sau</button></div>
      </div>
    </div>


    {bookDetail&&<div className="modal-backdrop">
      <div className="modal-card book-detail-modal">
        <div className="modal-header">
          <div>
            <h2>Chi tiết bảng giá #{bookDetail.id}</h2>
            <p className="muted">Bill chưa thu tiền: {bookDetail.unpaid_bill_count||0}. Bill đã thu tiền: {bookDetail.paid_bill_count||0}. {bookDetail.can_edit?'Thông tin bảng giá được sửa.':'Thông tin bảng giá đã khóa (xem chi tiết từng dòng bên dưới).'}</p>
          </div>
          <button className="btn secondary" onClick={()=>{setBookDetail(null);setBookItems([]);setBookAddItems([])}}>Đóng</button>
        </div>
        <div className="book-detail-fields">
          <label className="field-label"><span>Tên bảng giá</span><input className="input" value={bookDetail.book_name||''} disabled={!bookDetail.can_edit} onChange={e=>setBookDetail({...bookDetail,book_name:e.target.value})}/></label>
          <label className="field-label"><span>Loại lịch</span><select className="select" value={bookDetail.effective_calendar_type||effectiveCalendarType} disabled={!bookDetail.can_edit} onChange={e=>setBookDetail({...bookDetail,effective_calendar_type:e.target.value})}><option value="SOLAR">Dương lịch</option><option value="LUNAR">Âm lịch</option></select></label>
          {String(bookDetail.effective_calendar_type||effectiveCalendarType)==='LUNAR'
            ? <label className="field-label"><span>Từ ngày (ÂL)</span><input className="input" placeholder="DD/MM/YYYY" value={bookDetail.effective_lunar_date_text||''} disabled={!bookDetail.can_edit} onChange={e=>setBookDetail({...bookDetail,effective_lunar_date_text:e.target.value})}/></label>
            : <label className="field-label"><span>Từ ngày</span><input className="input" type="date" value={String(bookDetail.effective_from||'').slice(0,10)} disabled={!bookDetail.can_edit} onChange={e=>setBookDetail({...bookDetail,effective_from:e.target.value})}/></label>
          }
          <label className="field-label"><span>Trạng thái</span><select className="select" value={bookDetail.status||'ACTIVE'} disabled={!bookDetail.can_edit} onChange={e=>setBookDetail({...bookDetail,status:e.target.value})}><option value="ACTIVE">ACTIVE</option><option value="CLOSED">CLOSED</option></select></label>
        </div>
        {!bookDetail.can_edit&&<p className="notice warn">Thông tin bảng giá (tên, ngày hiệu lực, loại lịch, trạng thái) đã khóa vì đã có bill phát sinh thu tiền. Từng mặt hàng bên dưới vẫn có thể thêm mới hoặc sửa/xóa nếu chưa từng dùng trong bill.</p>}
        <div className="book-detail-scroll">
          <table className="table"><thead><tr><th>Mặt hàng</th><th>Mã</th><th>Giá</th><th>Ghi chú</th><th></th></tr></thead>
          <tbody>{bookItems.map((it,idx)=><tr key={it.product_id}>
            <td><b>{it.product_name}</b>{!it.can_edit&&<span className="muted" style={{marginLeft:6,fontSize:12}}>{it.lock_reason||'🔒 Đã sử dụng trong bill'}</span>}</td><td>{it.product_code}</td>
            <td><MoneyInput value={it.sale_price} disabled={!it.can_edit} onChange={v=>setBookItem(idx,{sale_price:v})}/></td>
            <td><input className="input" value={it.note||''} disabled={!it.can_edit} onChange={e=>setBookItem(idx,{note:e.target.value})}/></td>
            <td>{it.can_delete&&<button title="Xóa dòng" style={{padding:0,width:34,height:34,display:'inline-flex',alignItems:'center',justifyContent:'center',background:'#fee2e2',border:'1px solid #fca5a5',borderRadius:8,cursor:'pointer',color:'#dc2626'}} onClick={()=>setBookItems(bookItems.filter((_,i)=>i!==idx))}><Trash2 size={14}/></button>}</td>
          </tr>)}</tbody></table>
          {bookAddItems.length>0
            ? <details style={{marginTop:16}}>
                <summary style={{cursor:'pointer',fontWeight:'bold',padding:'8px 0'}}>+ Thêm mặt hàng chưa có trong bảng giá ({bookAddItems.length})</summary>
                <table className="table"><thead><tr><th>Mặt hàng</th><th>Mã</th><th>Giá riêng mới</th></tr></thead>
                <tbody>{bookAddItems.map((it,idx)=><tr key={it.product_id}>
                  <td><b>{it.product_name}</b></td><td>{it.product_code}</td>
                  <td><MoneyInput value={it.sale_price} onChange={v=>setBookAddItems(bookAddItems.map((x,i)=>i===idx?{...x,sale_price:v}:x))}/></td>
                </tr>)}</tbody></table>
              </details>
            : <p className="muted" style={{marginTop:16}}>Tất cả mặt hàng trong danh mục đã có trong bảng giá.</p>
          }
        </div>
        <div className="modal-footer">
          <button className="btn secondary" onClick={()=>{setBookDetail(null);setBookItems([]);setBookAddItems([])}}>Đóng</button>
          <button className="btn" onClick={saveBook} disabled={bookBusy}>Lưu bảng giá</button>
        </div>
      </div>
    </div>}

    {showPickModal&&<div className="modal-backdrop">
      <div className="modal-card" style={{maxWidth:700}}>
        <div className="modal-header">
          <div>
            <h2>Bảng giá riêng — {selectedCustomer.name||''} · {categories.find(c=>String(c.id)===String(categoryId))?.name||''}</h2>
            <p className="muted">Chọn bảng giá để xem/sửa hoặc tạo bảng giá mới.</p>
          </div>
          <button className="btn secondary" onClick={()=>setShowPickModal(false)}>Đóng</button>
        </div>
        <table className="table">
          <thead><tr><th>Ngày hiệu lực</th><th>Lịch</th><th>Số SP</th><th>Trạng thái</th><th>Thao tác</th></tr></thead>
          <tbody>{[...books].filter(b=>String(b.status||'ACTIVE')!=='DELETED').sort((a,b)=>String(b.effective_from||'').localeCompare(String(a.effective_from||''))).map(b=><tr key={b.id}>
            <td>{String(b.effective_calendar_type||'SOLAR')==='LUNAR'?(b.effective_lunar_date_text+' ÂL'):String(b.effective_from||'').slice(0,10)}</td>
            <td>{String(b.effective_calendar_type||'SOLAR')==='LUNAR'?'Âm lịch':'Dương lịch'}</td>
            <td>{b.item_count||0}</td>
            <td>{b.can_edit?<span className="pill ok">Được sửa</span>:<span className="pill warn">Đã khóa</span>}</td>
            <td><button className="btn secondary" onClick={async()=>{setShowPickModal(false);await loadMatrix(cid,undefined,{refreshBooks:false});await openBook(b.id);}}>Xem/Sửa</button></td>
          </tr>)}</tbody>
        </table>
        <div className="modal-footer">
          <button className="btn" onClick={async()=>{setShowPickModal(false);await enterNewBookMode(cid,categoryId);}}>+ Thêm bảng giá mới</button>
        </div>
      </div>
    </div>}

    {fileImport&&<div className="modal-backdrop">
      <div className="modal-card excel-price-preview">
        <div className="modal-header">
          <div>
            <h2>Import bảng giá riêng từ Excel</h2>
            <p className="muted">File: {fileImport.fileName}. Đã đọc sheet: {(fileImport.sheetNames||[]).join(', ')}. Chỉ map đúng tên/mã mặt hàng trong database, không dùng alias. Khi bấm lưu, bảng giá sẽ áp dụng từ ngày hiệu lực đã chọn.</p>
          </div>
          <button className="btn secondary" onClick={()=>setFileImport(null)}>Đóng</button>
        </div>
        <div className="actions">
          <label className="muted" style={{display:'flex',alignItems:'center',gap:6}}>Ngày hiệu lực ({effectiveCalendarType==='LUNAR'?'Âm lịch':'Dương lịch'})
            {effectiveCalendarType==='LUNAR'
              ? <input className="input" style={{width:170}} placeholder="DD/MM/YYYY" value={effectiveLunarDateText} onChange={e=>setEffectiveLunarDateText(e.target.value)}/>
              : <input className="input" type="date" style={{width:170}} value={effectiveFrom} onChange={e=>setEffectiveFrom(e.target.value)}/>
            }
          </label>
          <span className="pill ok">Khớp: {fileImport.byProduct.length}</span>
          <span className="pill warn">Không mapping: {fileImport.unmapped.length}</span>
          <span className="pill">Giá lỗi/bằng 0: {fileImport.invalid.length}</span>
        </div>
        {fileImport.duplicateKeys.length>0&&<p className="notice warn">Có tên/mã sản phẩm bị trùng trong database: {fileImport.duplicateKeys.slice(0,8).join(', ')}. Nên kiểm tra lại trước khi lưu.</p>}
        <div className="excel-preview-grid">
          <div>
            <h3>Dòng đã mapping</h3>
            <div className="scroll-box">
              <table className="table"><thead><tr><th>Sheet</th><th>Dòng</th><th>Excel</th><th>Database</th><th>Giá riêng</th></tr></thead>
                <tbody>{fileImport.matched.map((x,i)=><tr key={i}><td>{x.sheetName}</td><td>{x.rowNumber}</td><td>{x.excelName}</td><td>{x.product_name}</td><td>{moneyVnd(x.price)}</td></tr>)}</tbody>
              </table>
            </div>
          </div>
          <div>
            <h3>Không mapping / bỏ qua</h3>
            <div className="scroll-box">
              <table className="table"><thead><tr><th>Sheet</th><th>Dòng</th><th>Mặt hàng Excel</th><th>Giá</th></tr></thead>
                <tbody>{fileImport.unmapped.map((x,i)=><tr key={i}><td>{x.sheetName}</td><td>{x.rowNumber}</td><td>{x.excelName}</td><td>{moneyVnd(x.price)}</td></tr>)}</tbody>
              </table>
              {fileImport.invalid.length>0&&<><h4>Giá lỗi/bằng 0</h4><table className="table"><tbody>{fileImport.invalid.map((x,i)=><tr key={i}><td>{x.sheetName}</td><td>{x.rowNumber}</td><td>{x.excelName}</td><td>{String(x.price)}</td></tr>)}</tbody></table></>}
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn secondary" onClick={()=>setFileImport(null)}>Hủy</button>
          <button className="btn" onClick={applyPriceExcel} disabled={!fileImport.byProduct.length}>Đưa dòng đã mapping vào bảng giá</button>
        </div>
      </div>
    </div>}
  </SafePage>;
}
