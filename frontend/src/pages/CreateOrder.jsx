import React,{useEffect,useMemo,useRef,useState}from'react';
import api from'../api/api';
import SafePage from'../components/SafePage';
import MoneyInput from'../components/MoneyInput';
import POSHeaderAgent from'../components/pos/POSHeaderAgent';
import POSProductTableAgent from'../components/pos/POSProductTableAgent';
import POSPaymentPanelAgent from'../components/pos/POSPaymentPanelAgent';
import AIBusinessPanel from'../components/ai/AIBusinessPanel';
import AIVoicePOSPanel from'../components/ai/AIVoicePOSPanel';
import {calcQtyExpression}from'../utils/qtyExpression';
import {formatLunarDate,solarToLunar,parseLunarText,lunarToSolarDate}from'../utils/lunarDate';
import {createSpeechRecognition,parseVoiceBillCommand,voiceSupported} from'../utils/voiceBillParser';
import {matchImportedRows,parseOrderText,rematchOne} from'../utils/orderImportParser';
import {parseHandwritingText} from'../utils/handwritingBillParser';

const money=n=>Number(n||0).toLocaleString('en-US')+'đ';

const parseLunarMonthYear=(text)=>{
  const m=String(text||'').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if(!m)return null;
  return {month:Number(m[2]),year:Number(m[3])};
};
const solarMonthYearLocal=(dateText)=>{
  const m=String(dateText||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(m)return {month:Number(m[2]),year:Number(m[1])};
  const d=dateText?new Date(dateText):new Date();
  return {month:d.getMonth()+1,year:d.getFullYear()};
};

export default function CreateOrder(){
  const today=new Date().toISOString().slice(0,10);

  const[orderDate,setOrderDate]=useState(today);
  const[billCalendarType,setBillCalendarType]=useState('SOLAR');
  const[billLunarDateText,setBillLunarDateText]=useState('');
  const[dateOpen,setDateOpen]=useState(false);

  const[customers,setCustomers]=useState([]);
  const[categories,setCategories]=useState([]);
  const[items,setItems]=useState([]);
  const[cid,setCid]=useState('');
  const[paid,setPaid]=useState(0);
  const[cashAmount,setCashAmount]=useState(0);
  const[bankAmount,setBankAmount]=useState(0);
  const[monthlyInstallment,setMonthlyInstallment]=useState(0);
  const[monthlyInstallmentId,setMonthlyInstallmentId]=useState(null);
  const[msg,setMsg]=useState('');
  const[source,setSource]=useState('');
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState('');
  const[filter,setFilter]=useState('');
  const[customerOpen,setCustomerOpen]=useState(false);

  const[quickOpen,setQuickOpen]=useState(false);
  const[voiceOpen,setVoiceOpen]=useState(false);
  const[importOpen,setImportOpen]=useState(false);

  const[quick,setQuick]=useState({unit:'kg',inventory_mode:'CARCASS_PART',allow_negative_stock:1});
  const[dragId,setDragId]=useState(null);

  const[voiceText,setVoiceText]=useState('');
  const[voiceProductId,setVoiceProductId]=useState('');
  const[voiceMsg,setVoiceMsg]=useState('');
  const[listening,setListening]=useState(false);

  const[importText,setImportText]=useState('');
  const[importPreview,setImportPreview]=useState([]);
  const[importMsg,setImportMsg]=useState('');
  const[allProducts,setAllProducts]=useState([]);
  const[ocrAliases,setOcrAliases]=useState([]);
  const[importApplyMode,setImportApplyMode]=useState('REPLACE');

  const qtyRefs=useRef({});

  const isBusinessCustomer=(customer)=>{
    if(!customer)return false;
    const text=[
      customer.customer_type,
      customer.type,
      customer.group_type,
      customer.price_mode,
      customer.tax_code,
      customer.company_name,
      customer.invoice_type
    ].map(x=>String(x||'').toUpperCase()).join(' ');
    return text.includes('BUSINESS')||text.includes('COMPANY')||text.includes('DOANH')||!!customer.tax_code||!!customer.company_name;
  };

  const normalizeCustomerText=(value)=>String(value||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d');
  const isWalkInCustomer=(customer)=>{
    if(!customer)return false;
    const text=[customer.customer_type,customer.type,customer.group_type,customer.customer_group,customer.name,customer.customer_code,customer.code,customer.note].map(normalizeCustomerText).join(' ');
    return text.includes('walk')||text.includes('vang lai')||text.includes('khach le')||text.includes('khach vang');
  };

  const currentCustomer=useMemo(()=>customers.find(c=>String(c.id)===String(cid)),[customers,cid]);
  const currentCustomerLabel=currentCustomer
    ? `${currentCustomer.name} • ${String(currentCustomer.billing_calendar_type||'SOLAR').toUpperCase()==='LUNAR'?'Âm lịch':'Dương lịch'}`
    : 'Chưa chọn khách';
  const walkInCustomer=isWalkInCustomer(currentCustomer);
  const paymentPolicyText=currentCustomer
    ? (walkInCustomer?'Khách vãng lai: thu tiền ngay tại POS':'Khách thường: tạo bill công nợ, thu tiền ở màn Thu tiền')
    : 'Chọn khách để áp dụng đúng chính sách thanh toán';

  const loadMonthlyInstallment=async(customerId,dateText=orderDate,calendarType=billCalendarType,lunarText=billLunarDateText)=>{
    if(!customerId){setMonthlyInstallment(0);setMonthlyInstallmentId(null);return;}
    try{
      const params=new URLSearchParams({
        customer_id:String(customerId),
        date:String(dateText||''),
        calendar_type:String(calendarType||'SOLAR'),
        lunar_date_text:calendarType==='LUNAR'?String(lunarText||''):''
      });
      const r=await api.get(`/installments/monthly/active?${params.toString()}`);
      setMonthlyInstallment(Number(r.data?.installment_amount||0));
      setMonthlyInstallmentId(r.data?.id||null);
    }catch(e){setMonthlyInstallment(0);setMonthlyInstallmentId(null)}
  };


  useEffect(()=>{loadMonthlyInstallment(cid,orderDate,billCalendarType,billLunarDateText)},[cid,orderDate,billCalendarType,billLunarDateText]);

  useEffect(()=>{
    let mounted=true;
    (async()=>{
      try{
        const [c,cat,prod]=await Promise.all([
          api.get('/customers'),
          api.get('/products/categories'),
          api.get('/products')
        ]);
        if(mounted){
          setCustomers(c.data||[]);
          setCategories(cat.data||[]);
          setAllProducts(prod.data||[]);
        }
      }catch(e){
        if(mounted)setError(e.response?.data?.message||e.message);
      }finally{
        if(mounted)setLoading(false);
      }
    })();
    return()=>{mounted=false};
  },[]);

  useEffect(()=>{
    if(!cid||!currentCustomer)return;
    const preferred=String(currentCustomer.billing_calendar_type||'SOLAR').toUpperCase()==='LUNAR'?'LUNAR':'SOLAR';
    setBillCalendarType(preferred);
    if(preferred==='LUNAR'){
      setBillLunarDateText(formatLunarDate(orderDate||today).replace(/^ÂL\s*/,''));
    }
  },[cid,currentCustomer,orderDate]);

  const reloadCustomerCatalogKeepQty=async(id)=>{
    const oldByProduct=new Map(items.map(x=>[
      String(x.product_id),
      {quantity_expr:x.quantity_expr,quantity:x.quantity,selected:x.selected}
    ]));

    const r=(await api.get('/price-matrix/'+id+'/catalog/order')).data;
    setSource(r.source);
    setItems((r.products||[]).map((p,idx)=>{
      const old=oldByProduct.get(String(p.product_id));
      return {
        ...p,
        quantity_expr:old?.quantity_expr||'',
        quantity:old?.quantity||0,
        sale_price:p.sale_price,
        selected:old?.selected||false,
        sort_order:p.sort_order||idx+1
      };
    }));
  };

  const loadCustomerCatalog=async(id)=>{
    setCid(id);
    setMsg('');
    setImportText('');
    setImportPreview([]);
    setImportMsg('');
    setImportApplyMode('REPLACE');
    try{
      const a=await api.get('/handwriting/aliases?customer_id='+id);
      setOcrAliases(a.data||[]);
    }catch(e){
      setOcrAliases([]);
    }

    if(!id){
      setItems([]);
      return;
    }

    const r=(await api.get('/price-matrix/'+id+'/catalog/order')).data;
    setSource(r.source);
    setItems((r.products||[]).map((p,idx)=>({
      ...p,
      quantity_expr:'',
      quantity:0,
      sale_price:p.sale_price,
      selected:false,
      sort_order:p.sort_order||idx+1
    })));
  };

  const update=(idx,patch)=>{
    if(idx<0)return;
    setItems(prev=>prev.map((x,i)=>i===idx?{...x,...patch}:x));
  };

  const updateQtyExpr=(idx,expr)=>{
    const qty=calcQtyExpression(expr);
    update(idx,{quantity_expr:expr,quantity:qty,selected:qty>0});
  };

  const shown=useMemo(()=>{
    const q=filter.trim().toLowerCase();
    if(!q)return items;
    return items.filter(x=>
      String(x.product_name).toLowerCase().includes(q)||
      String(x.product_code).toLowerCase().includes(q)||
      String(x.category_name).toLowerCase().includes(q)
    );
  },[items,filter]);

  const selected=items
    .map(i=>({...i,quantity:calcQtyExpression(i.quantity_expr)||Number(i.quantity||0)}))
    .filter(i=>i.selected&&Number(i.quantity)>0);

  const total=selected.reduce((s,i)=>s+Number(i.quantity||0)*Number(i.sale_price||0),0);


  const changeOrderDate=(v)=>{
    setOrderDate(v);
    if(billCalendarType==='LUNAR'){
      setBillLunarDateText(formatLunarDate(v||today).replace(/^ÂL\s*/,''));
    }
  };

  const changeBillCalendarType=(ct)=>{
    const next=ct==='LUNAR'?'LUNAR':'SOLAR';
    setBillCalendarType(next);
    if(next==='LUNAR'){
      setBillLunarDateText(formatLunarDate(orderDate||today).replace(/^ÂL\s*/,''));
    }
  };

  const changeBillLunarDateText=(v)=>{
    setBillLunarDateText(v);
    const solar=lunarToSolarDate(parseLunarText(v));
    if(solar)setOrderDate(solar);
  };

  useEffect(()=>{
    if(!items.length){setVoiceProductId('');return;}
    if(!items.some(x=>String(x.product_id)===String(voiceProductId))){
      setVoiceProductId(String(items[0].product_id));
    }
  },[items,voiceProductId]);

  const focusNext=(productId)=>{
    const idx=shown.findIndex(x=>x.product_id===productId);
    const next=shown[idx+1];
    if(next&&qtyRefs.current[next.product_id])qtyRefs.current[next.product_id].focus();
  };

  const save=async()=>{
    if(!cid)return alert('Chọn khách hàng');
    if(!selected.length)return alert('Nhập số lượng ít nhất 1 mặt hàng');

    const payloadItems=selected.map(i=>({
      product_id:i.product_id,
      product_name:i.product_name,
      unit:i.unit||'kg',
      quantity:Number(i.quantity||0),
      sale_price:Number(i.sale_price||0),
      price_type:i.price_type||'MANUAL_PRICE',
      note:i.quantity_expr&&i.quantity_expr!==String(i.quantity)?`SL nhập: ${i.quantity_expr}`:''
    }));

    let actualPaid=Number(cashAmount||0)+Number(bankAmount||0);

    if(walkInCustomer && actualPaid<Number(total||0)){
      alert('Khách vãng lai phải thu đủ tiền ngay tại POS trước khi lưu bill.');
      return;
    }

    if(!walkInCustomer && actualPaid>0){
      alert('Khách hàng thường chỉ tạo bill công nợ tại POS. Vui lòng thu tiền ở màn Thu tiền.');
      return;
    }

    const r=await api.post('/orders',{
      customer_id:cid,
      order_date:orderDate,
      calendar_type:billCalendarType,
      lunar_date_text:billCalendarType==='LUNAR'?billLunarDateText:'',
      current_bill_amount:total,
      monthly_installment_amount:monthlyInstallment,
      installment_amount:monthlyInstallment,
      monthly_installment_id:monthlyInstallmentId,
      paid_amount:0,
      items:payloadItems
    });

    if(actualPaid>0){
      const actualInstallmentPaid = Math.max(0, Math.min(Number(monthlyInstallment||0), actualPaid - Number(total||0)));
      await api.post('/payments',{
        customer_id:cid,
        order_id:r.data.order_id,
        payment_date:orderDate,
        calendar_type:billCalendarType,
        current_bill_amount:total,
        monthly_installment_amount:monthlyInstallment,
        installment_amount:monthlyInstallment,
        installment_paid_amount:actualInstallmentPaid,
        monthly_installment_id:monthlyInstallmentId,
        cash_amount:cashAmount,
        bank_amount:bankAmount,
        amount:actualPaid,
        note:`Thu tiền POS ${r.data.order_code}`
      });
    }

    setMsg(r.data.order_code);
    await reloadCustomerCatalogKeepQty(cid);
    setPaid(0);
    setCashAmount(0);
    setBankAmount(0);
  };

  const loadNextCode=async(categoryId)=>{
    if(!categoryId)return;
    try{
      const r=await api.get('/products/next-code/'+categoryId);
      setQuick(q=>({...q,category_id:categoryId,product_code:r.data.product_code}));
    }catch(e){
      setQuick(q=>({...q,category_id:categoryId}));
    }
  };

  const addQuickProduct=async()=>{
    if(!cid)return alert('Chọn khách trước');
    if(!quick.name)return alert('Nhập tên mặt hàng');

    const r=await api.post('/products/quick',{
      ...quick,
      customer_id:cid
    });

    alert(r.data.message+' - '+r.data.product_code);
    setQuick(q=>({
      unit:q.unit||'kg',
      inventory_mode:q.inventory_mode||'CARCASS_PART',
      allow_negative_stock:q.allow_negative_stock??1,
      category_id:q.category_id
    }));
    setQuickOpen(false);
    await reloadCustomerCatalogKeepQty(cid);
  };

  const handleDrop=(targetId)=>{
    if(!dragId||dragId===targetId)return;
    const arr=[...items];
    const from=arr.findIndex(x=>String(x.product_id)===String(dragId));
    const to=arr.findIndex(x=>String(x.product_id)===String(targetId));
    if(from<0||to<0)return;
    const[moved]=arr.splice(from,1);
    arr.splice(to,0,moved);
    setItems(arr.map((x,i)=>({...x,sort_order:i+1})));
    setDragId(null);
  };

  const saveOrder=async()=>{
    if(!cid)return alert('Chọn khách');
    await api.put('/price-matrix/'+cid+'/catalog/reorder',{
      items:items.map((x,i)=>({product_id:x.product_id,sort_order:i+1}))
    });
    alert('Đã lưu thứ tự danh mục khách');
    await reloadCustomerCatalogKeepQty(cid);
  };

  const applyVoiceCommand=(text)=>{
    if(!cid){
      setVoiceMsg('Chọn khách hàng trước khi nhập giọng nói');
      return;
    }

    let result=parseVoiceBillCommand(text,items);
    if(!result.ok && voiceProductId){
      // Nếu câu chỉ nói số lượng hoặc tên nhận diện không khớp, áp vào mặt hàng đang chọn trong danh mục khách.
      const selectedVoiceProduct=items.find(x=>String(x.product_id)===String(voiceProductId));
      const qtyOnly=parseVoiceBillCommand(`${selectedVoiceProduct?.product_name||''} ${text}`,items);
      if(qtyOnly.ok) result=qtyOnly;
    }
    if(!result.ok){
      setVoiceMsg(result.message);
      return;
    }

    if(result.action==='SAVE_BILL'){
      save();
      return;
    }

    if(result.action==='CLEAR_ITEM'){
      const idx=items.findIndex(x=>x.product_id===result.product.product_id);
      if(idx>=0){
        update(idx,{quantity_expr:'',quantity:0,selected:false});
        setVoiceMsg(`Đã xóa ${result.product.product_name}`);
      }
      return;
    }

    const idx=items.findIndex(x=>x.product_id===result.product.product_id);
    if(idx<0){
      setVoiceMsg('Không tìm thấy dòng mặt hàng trong danh mục khách');
      return;
    }

    const oldQty=Number(items[idx].quantity||0);
    const newQty=Number((oldQty+Number(result.quantity||0)).toFixed(3));
    update(idx,{quantity_expr:String(newQty),quantity:newQty,selected:newQty>0});
    setVoiceMsg(`Đã thêm ${result.product.product_name}: ${result.expression||result.quantity} = ${result.quantity} kg`);
  };

  const startVoice=()=>{
    if(!voiceSupported()){
      setVoiceMsg('Trình duyệt chưa hỗ trợ nhập giọng nói. Dùng Chrome/Edge bản mới.');
      return;
    }

    const rec=createSpeechRecognition();
    if(!rec){
      setVoiceMsg('Không khởi tạo được microphone');
      return;
    }

    setListening(true);
    setVoiceMsg('Đang nghe...');
    rec.onresult=e=>{
      const text=e.results?.[0]?.[0]?.transcript||'';
      setVoiceText(text);
      applyVoiceCommand(text);
    };
    rec.onerror=e=>setVoiceMsg('Lỗi microphone: '+(e.error||'unknown'));
    rec.onend=()=>setListening(false);
    rec.start();
  };

  const applyManualVoiceText=()=>{
    if(voiceText.trim())applyVoiceCommand(voiceText);
  };

  const resetImportSession=()=>{
    setImportText('');
    setImportPreview([]);
    setImportMsg('');
  };

  const clearCurrentBillQty=()=>{
    if(!confirm('Xóa toàn bộ số lượng đang nhập trong bill hiện tại?'))return;
    setItems(prev=>prev.map(x=>({...x,quantity_expr:'',quantity:0,selected:false})));
    setPaid(0);
    setCashAmount(0);
    setBankAmount(0);
    setMsg('');
  };

  const previewImport=(sourceType='text')=>{
    if(!cid)return alert('Chọn khách trước');
    const rows=parseOrderText(importText,sourceType);
    const matched=matchImportedRows(rows,items);
    setImportPreview(matched);
    setImportMsg(`Đọc được ${rows.length} dòng, khớp chắc chắn ${matched.filter(x=>x.ok).length} dòng, lỗi ${matched.filter(x=>x.errors?.length).length} dòng`);
  };

  const updateImportRow=(idx,patch)=>{
    setImportPreview(prev=>prev.map((r,i)=>{
      if(i!==idx)return r;
      const updated={...r,...patch};
      const qty=calcQtyExpression(updated.qtyExpr);
      return rematchOne({...updated,qty,sourceType:'manual',errors:[],warnings:[]},items);
    }));
  };

  const applyImport=()=>{
    if(!importPreview.length)return;
    const rowsToApply=importPreview.filter(x=>x.selected&&x.canApply);
    if(!rowsToApply.length){
      alert('Không có dòng hợp lệ được chọn');
      return;
    }

    const warnRows=rowsToApply.filter(x=>x.warnings&&x.warnings.length);
    if(warnRows.length){
      const ok=confirm('Có dòng import cảnh báo. Bạn đã kiểm tra kỹ chưa?');
      if(!ok)return;
    }

    let arr=[...items];
    for(const r of rowsToApply){
      const idx=arr.findIndex(x=>x.product_id===(r.product?.product_id||r.product_id));
      if(idx>=0){
        const oldQty=importApplyMode==='ADD'?Number(arr[idx].quantity||0):0;
        const newQty=Number((oldQty+Number(r.qty||0)).toFixed(3));
        arr[idx]={...arr[idx],quantity:newQty,quantity_expr:String(newQty),selected:newQty>0};
      }
    }
    setItems(arr);
    setImportMsg(`Đã đưa ${rowsToApply.length} dòng đã chọn vào bill (${importApplyMode==='ADD'?'cộng thêm':'ghi đè'})`);
  };

  const readExcelFile=async(file)=>{
    if(!file)return;
    resetImportSession();
    try{
      const XLSX=await import('xlsx');
      const buf=await file.arrayBuffer();
      const wb=XLSX.read(buf);
      const ws=wb.Sheets[wb.SheetNames[0]];
      const data=XLSX.utils.sheet_to_json(ws,{header:1});
      const text=data.map(r=>`${r[0]||''} ${r[1]||''}`.trim()).filter(Boolean).join('\n');
      setImportText(text);
      setImportMsg('Đã đọc file Excel. Bấm Xem trước import text/excel.');
    }catch(e){
      setImportMsg('Không đọc được Excel: '+e.message);
    }
  };

  const readImageFile=async(file)=>{
    if(!file)return;
    resetImportSession();
    try{
      setImportMsg('Đang OCR hình ảnh, vui lòng chờ...');
      const Tesseract=await import('tesseract.js');
      const res=await Tesseract.recognize(file,'vie+eng');
      setImportText(res.data.text||'');
      setImportMsg('Đã OCR ảnh. Kiểm tra lại text rồi bấm Xem trước OCR ảnh.');
    }catch(e){
      setImportMsg('OCR ảnh chưa chạy được trên máy này: '+e.message+'. Có thể nhập/copy text vào ô bên dưới.');
    }
  };

  const previewHandwriting=()=>{
    if(!cid)return alert('Chọn khách trước');
    const rows=parseHandwritingText(importText,items,allProducts,ocrAliases);
    setImportPreview(rows);
    setImportMsg(`Viết tay: đọc ${rows.length} dòng, OK ${rows.filter(x=>x.status==='OK').length}, vàng ${rows.filter(x=>x.status==='WARN').length}, đỏ ${rows.filter(x=>x.status==='ERROR').length}`);
  };

  const addMissingToCatalog=async(row)=>{
    if(!cid||!row.product_id)return;
    await api.post('/price-matrix/'+cid+'/catalog',{product_id:row.product_id,sort_order:999});
    await api.post('/handwriting/aliases',{customer_id:cid,alias_text:row.name,product_id:row.product_id,source:'HANDWRITING'});
    alert('Đã thêm vào danh mục khách và học alias');
    await reloadCustomerCatalogKeepQty(cid);
  };

  return (
    <SafePage loading={loading} error={error}>
      <div className="pos-agent-shell pos-real-shell">
        <POSHeaderAgent
          orderDate={orderDate}
          setOrderDate={changeOrderDate}
          calendarType={billCalendarType}
          setCalendarType={changeBillCalendarType}
          lunarDateText={billLunarDateText}
          setLunarDateText={changeBillLunarDateText}
          dateOpen={dateOpen}
          setDateOpen={setDateOpen}
        />

        <AIBusinessPanel compact title="AI nhập hàng / tồn kho"/>
        <AIVoicePOSPanel sessionId={`POS_${cid||'NO_CUSTOMER'}`}/>

        <div className="pos-agent-layout pos-real-layout">
          <main className="pos-agent-main pos-real-main">
            <div className="card pos-customer-card pos-customer-collapse-card">
              <div className="pos-customer-collapse-head">
                <div>
                      <div className="muted pos-customer-summary">
                    {currentCustomerLabel}{source ? ` • ${source}` : ''}
                  </div>
                </div>

                <button
                  type="button"
                  className="btn secondary"
                  onClick={()=>setCustomerOpen(!customerOpen)}
                >
                  {customerOpen?'Thu gọn':'Chọn khách / chức năng'}
                </button>
              </div>

              {currentCustomer&&(<div className={walkInCustomer?'ai-alert warn':'ai-alert'} style={{marginTop:12}}>{paymentPolicyText}</div>)}

              {customerOpen&&(
                <div className="pos-customer-collapse-body">

              <select className="select" value={cid} onChange={e=>loadCustomerCatalog(e.target.value)}>
                <option value="">Chọn khách</option>
                {customers.map(c=><option key={c.id} value={c.id}>{c.name} • {String(c.billing_calendar_type||'SOLAR').toUpperCase()==='LUNAR'?'Âm lịch':'Dương lịch'}</option>)}
              </select>

              <p className="muted">
                Nguồn danh mục: {source||'chưa chọn'}. Enter nhảy dòng tiếp theo. Kéo thả dòng để đổi thứ tự.
              </p>

              <div className="actions pos-agent-action-row">
                <button className="btn secondary" onClick={()=>setQuickOpen(!quickOpen)}>
                  {quickOpen?'− Thu gọn thêm nhanh':'+ Thêm nhanh mặt hàng'}
                </button>
                <button className="btn secondary" onClick={()=>setImportOpen(!importOpen)}>
                  {importOpen?'− Thu gọn import':'+ Import Excel/Ảnh'}
                </button>
              </div>

              {quickOpen&&(
                <div className="card inner-card">
                  <h3>Thêm nhanh mặt hàng vào danh mục khách này</h3>
                  <div className="form-grid">
                    <select className="select" value={quick.category_id||''} onChange={e=>loadNextCode(e.target.value)}>
                      <option value="">Chọn nhóm</option>
                      {categories.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    <input className="input" placeholder="Mã tự sinh" value={quick.product_code||''} onChange={e=>setQuick({...quick,product_code:e.target.value})}/>
                    <input className="input" placeholder="Tên mặt hàng mới" value={quick.name||''} onChange={e=>setQuick({...quick,name:e.target.value})}/>
                    <input className="input" placeholder="Đơn vị" value={quick.unit||'kg'} onChange={e=>setQuick({...quick,unit:e.target.value})}/>
                    <select className="select" value={quick.inventory_mode||'CARCASS_PART'} onChange={e=>setQuick({...quick,inventory_mode:e.target.value,allow_negative_stock:e.target.value==='STOCK'?0:1})}>
                      <option value="STOCK">Quản tồn kho</option>
                      <option value="NON_STOCK">Bò xô không kiểm tồn</option>
                      <option value="CARCASS_PART">Phần pha lóc không kiểm tồn</option>
                    </select>
                  </div>
                  <button className="btn secondary" style={{marginTop:10}} onClick={addQuickProduct}>
                    + Thêm vào danh mục khách
                  </button>
                </div>
              )}

              {importOpen&&(
                <div className="card inner-card">
                  <h3>Import đơn từ Excel / hình ảnh</h3>
                  <p className="muted">
                    File chỉ cần 2 cột: <b>Tên mặt hàng</b> và <b>Số lượng</b>.
                  </p>
                  <div className="actions">
                    <input type="file" accept=".xlsx,.xls,.csv" onChange={e=>readExcelFile(e.target.files?.[0])}/>
                    <input type="file" accept="image/*" onChange={e=>readImageFile(e.target.files?.[0])}/>
                  </div>
                  <textarea className="input" style={{minHeight:120,marginTop:10}} placeholder={"Bò búp 10+12\nĐùi bò 5.5"} value={importText} onChange={e=>setImportText(e.target.value)}/>
                  <div className="actions" style={{marginTop:10}}>
                    <select className="select" style={{width:220}} value={importApplyMode} onChange={e=>setImportApplyMode(e.target.value)}>
                      <option value="REPLACE">Ghi đè số lượng trong bill</option>
                      <option value="ADD">Cộng thêm vào số lượng cũ</option>
                    </select>
                    <button className="btn secondary" onClick={()=>previewImport('text')}>Xem trước import text/excel</button>
                    <button className="btn secondary" onClick={()=>previewImport('image')}>Xem trước OCR ảnh</button>
                    <button className="btn secondary" onClick={previewHandwriting}>Xem ảnh viết tay</button>
                    <button className="btn" onClick={applyImport} disabled={!importPreview.length}>Đưa dòng đã chọn vào bill</button>
                    <button className="btn danger" onClick={clearCurrentBillQty}>Xóa SL bill hiện tại</button>
                  </div>
                  {importMsg&&<p className="muted">{importMsg}</p>}

                  {importPreview.length>0&&(
                    <div className="card inner-card">
                      <h3>Preview import</h3>
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Chọn</th>
                            <th>Raw</th>
                            <th>Mặt hàng khớp</th>
                            <th>Số lượng</th>
                            <th>Trạng thái</th>
                            <th>Thao tác</th>
                          </tr>
                        </thead>
                        <tbody>
                          {importPreview.map((r,idx)=>(
                            <tr key={idx} style={{background:r.status==='ERROR'?'#fee2e2':(r.status==='WARN'?'#fef3c7':'#dcfce7')}}>
                              <td>
                                <input type="checkbox" checked={!!r.selected} disabled={!r.canApply} onChange={e=>updateImportRow(idx,{selected:e.target.checked})}/>
                              </td>
                              <td><b>{r.name||r.raw||''}</b><br/><span className="muted">{r.raw||''}</span></td>
                              <td>{r.product?<span>{r.product.product_code} - {r.product.product_name}</span>:<span className="muted">Chưa khớp danh mục</span>}</td>
                              <td>
                                <input className="input" style={{width:120}} value={r.qtyExpr||r.quantity_expr||r.qty||''} onChange={e=>updateImportRow(idx,{qtyExpr:e.target.value})}/>
                              </td>
                              <td>
                                {r.errors?.length?<span>🔴 {r.errors.join(', ')}</span>:r.warnings?.length?<span>🟡 {r.warnings.join(', ')}</span>:<span>🟢 OK</span>}
                              </td>
                              <td>
                                {r.product_id&&!r.inCustomerCatalog&&(
                                  <button className="btn secondary" onClick={()=>addMissingToCatalog(r)}>
                                    Thêm vào DM khách
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
                </div>
              )}
            </div>

            <POSProductTableAgent
              shown={shown}
              items={items}
              filter={filter}
              setFilter={setFilter}
              saveOrder={saveOrder}
              cid={cid}
              qtyRefs={qtyRefs}
              focusNext={focusNext}
              updateQtyExpr={updateQtyExpr}
              dragId={dragId}
              setDragId={setDragId}
              handleDrop={handleDrop}
            />
          </main>

          <POSPaymentPanelAgent
            total={total}
            monthlyInstallment={monthlyInstallment}
            cashAmount={cashAmount}
            bankAmount={bankAmount}
            setCashAmount={setCashAmount}
            setBankAmount={setBankAmount}
            paid={paid}
            setPaid={setPaid}
            onSave={save}
            onClear={clearCurrentBillQty}
            paymentPolicyText={paymentPolicyText}
            walkInCustomer={walkInCustomer}
            disabled={!cid||!selected.length}
            message={msg}
          />
        </div>
      </div>
    </SafePage>
  );
}
