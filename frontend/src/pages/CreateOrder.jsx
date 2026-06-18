import React,{useEffect,useMemo,useRef,useState}from'react';
import api from'../api/api';
import SafePage from'../components/SafePage';
import MoneyInput from'../components/MoneyInput';
import POSProductTableAgent from'../components/pos/POSProductTableAgent';
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
  const toLocalIsoDate=(d=new Date())=>{
    const y=d.getFullYear();
    const m=String(d.getMonth()+1).padStart(2,'0');
    const day=String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${day}`;
  };
  const today=toLocalIsoDate();

  const[orderDate,setOrderDate]=useState(today);
  const[billCalendarType,setBillCalendarType]=useState('SOLAR');
  const[billLunarDateText,setBillLunarDateText]=useState('');
  const[shipDateModalOpen,setShipDateModalOpen]=useState(false);

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
  const[saveNotice,setSaveNotice]=useState('');
  const[saving,setSaving]=useState(false);
  const[pendingFocusQty,setPendingFocusQty]=useState(false);

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
  const[importSheetFilter,setImportSheetFilter]=useState('');
  const[excelBillQueue,setExcelBillQueue]=useState([]);
  const[excelBillIndex,setExcelBillIndex]=useState(-1);

  const qtyRefs=useRef({});
  const importExcelFileRef=useRef(null);
  const importImageFileRef=useRef(null);
  const importReadSeqRef=useRef(0);

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


  const isFutureIsoDate=(dateText)=>String(dateText||'').slice(0,10)>today;
  const validateShippingDate=(calendarType=billCalendarType,solarDate=orderDate,lunarText=billLunarDateText,{showAlert=true}={})=>{
    const ct=String(calendarType||'SOLAR').toUpperCase()==='LUNAR'?'LUNAR':'SOLAR';
    let resolvedSolar=String(solarDate||today).slice(0,10);
    if(ct==='LUNAR'){
      const parsed=parseLunarText(lunarText);
      const converted=lunarToSolarDate(parsed);
      if(!converted){
        if(showAlert)alert('Ngày âm lịch không hợp lệ. Vui lòng nhập dạng dd/mm/yyyy.');
        return {ok:false,solarDate:resolvedSolar,reason:'INVALID_LUNAR_DATE'};
      }
      resolvedSolar=converted;
    }
    if(isFutureIsoDate(resolvedSolar)){
      if(showAlert)alert('Không thể tạo bill cho ngày xuất hàng lớn hơn ngày hiện tại.');
      return {ok:false,solarDate:resolvedSolar,reason:'FUTURE_BILL_DATE'};
    }
    return {ok:true,solarDate:resolvedSolar};
  };


  useEffect(()=>{loadMonthlyInstallment(cid,orderDate,billCalendarType,billLunarDateText)},[cid,orderDate,billCalendarType,billLunarDateText]);

  useEffect(()=>{
    if(cid&&items.length)refreshCurrentItemPrices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[cid,orderDate,billCalendarType,billLunarDateText]);

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

  const loadEffectivePriceMap=async(productList,context={})=>{
    const customerId=context.customer_id||cid;
    if(!customerId||!productList?.length)return {};
    const product_ids=[...new Set(productList.map(x=>Number(x.product_id)).filter(Boolean))];
    if(!product_ids.length)return {};
    const calendarType=String(context.calendar_type||billCalendarType||'SOLAR').toUpperCase()==='LUNAR'?'LUNAR':'SOLAR';
    try{
      const r=await api.post(`/price-matrix/${customerId}/effective-prices`,{
        product_ids,
        order_date:context.order_date||orderDate,
        calendar_type:calendarType,
        lunar_date_text:calendarType==='LUNAR'?(context.lunar_date_text||billLunarDateText):''
      });
      return r.data?.prices||{};
    }catch(e){
      // If backend is not yet upgraded, do not block POS; save endpoint will still validate.
      return {};
    }
  };

  const applyEffectivePrices=async(productList,context={})=>{
    const priceMap=await loadEffectivePriceMap(productList,context);
    return (productList||[]).map(p=>{
      const price=priceMap[String(p.product_id)]||priceMap[p.product_id];
      if(price&&Number(price.sale_price)>0&&!p.manual_price){
        return {...p,sale_price:Number(price.sale_price),price_type:price.price_type,price_book_id:price.price_book_id||null};
      }
      return p;
    });
  };

  const refreshCurrentItemPrices=async(context={})=>{
    if(!cid||!items.length)return;
    const updated=await applyEffectivePrices(items,context);
    setItems(prev=>prev.map(x=>{
      const hit=updated.find(u=>String(u.product_id)===String(x.product_id));
      return hit?{...x,sale_price:hit.sale_price,price_type:hit.price_type,price_book_id:hit.price_book_id}:x;
    }));
  };


  const reloadCustomerCatalogKeepQty=async(id)=>{
    const oldByProduct=new Map(items.map(x=>[
      String(x.product_id),
      {quantity_expr:x.quantity_expr,quantity:x.quantity,selected:x.selected}
    ]));

    const r=(await api.get('/price-matrix/'+id+'/catalog/order')).data;
    setSource(r.source);
    const mapped=(r.products||[]).map((p,idx)=>{
      const old=oldByProduct.get(String(p.product_id));
      return {
        ...p,
        quantity_expr:old?.quantity_expr||'',
        quantity:old?.quantity||0,
        sale_price:p.sale_price,
        selected:old?.selected||false,
        sort_order:p.sort_order||idx+1
      };
    });
    setItems(await applyEffectivePrices(mapped));
  };


  const reloadCustomerCatalogClearQty=async(id)=>{
    if(!id){setItems([]);return;}
    const r=(await api.get('/price-matrix/'+id+'/catalog/order')).data;
    setSource(r.source);
    const mapped=(r.products||[]).map((p,idx)=>({
      ...p,
      quantity_expr:'',
      quantity:0,
      sale_price:p.sale_price,
      selected:false,
      sort_order:p.sort_order||idx+1
    }));
    setItems(await applyEffectivePrices(mapped,{customer_id:id,calendar_type:billCalendarType,order_date:orderDate,lunar_date_text:billCalendarType==='LUNAR'?billLunarDateText:''}));
    setPendingFocusQty(true);
  };

  const focusFirstQtyInput=()=>{
    setTimeout(()=>{
      const first=shown.find(x=>qtyRefs.current[x.product_id]);
      if(first&&qtyRefs.current[first.product_id]){
        qtyRefs.current[first.product_id].focus();
        qtyRefs.current[first.product_id].select?.();
      }
    },80);
  };


  const openShipDateModalForCustomer=(customer)=>{
    if(!customer)return;
    const preferred=String(customer.billing_calendar_type||'SOLAR').toUpperCase()==='LUNAR'?'LUNAR':'SOLAR';
    setBillCalendarType(preferred);
    if(preferred==='LUNAR'){
      setBillLunarDateText(formatLunarDate(orderDate||today).replace(/^ÂL\s*/,''));
    }else{
      setBillLunarDateText('');
    }
    setShipDateModalOpen(true);
  };

  const applyShipDateModal=()=>{
    if(!cid)return setShipDateModalOpen(false);
    if(billCalendarType==='LUNAR'&&!String(billLunarDateText||'').trim()){
      alert('Vui lòng chọn ngày xuất hàng âm lịch');
      return;
    }
    const checked=validateShippingDate(billCalendarType,orderDate,billLunarDateText);
    if(!checked.ok)return;
    if(checked.solarDate&&checked.solarDate!==orderDate)setOrderDate(checked.solarDate);
    setShipDateModalOpen(false);
    setSaveNotice(`Đã chọn ngày xuất hàng ${billCalendarType==='LUNAR'?`${billLunarDateText} ÂL`:(orderDate||today)}. Bảng giá sẽ lấy theo đúng ngày này.`);
    refreshCurrentItemPrices({calendar_type:billCalendarType,order_date:orderDate,lunar_date_text:billCalendarType==='LUNAR'?billLunarDateText:''});
  };

  const loadCustomerCatalog=async(id)=>{
    if(selected.length && id && String(id)!==String(cid)){
      const ok=await window.appConfirm('Bill hiện tại đang có số lượng. Đổi khách sẽ xóa bill đang nhập. Tiếp tục?',{title:'Đổi khách hàng',confirmText:'Tiếp tục',variant:'warning'});
      if(!ok)return;
    }
    setCid(id);
    setMsg('');
    setSaveNotice('');
    setPaid(0);
    setCashAmount(0);
    setBankAmount(0);
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

    const pickedCustomer=customers.find(c=>String(c.id)===String(id));
    const pickedCalendarType=String(pickedCustomer?.billing_calendar_type||'SOLAR').toUpperCase()==='LUNAR'?'LUNAR':'SOLAR';
    const pickedLunarText=pickedCalendarType==='LUNAR'?formatLunarDate(orderDate||today).replace(/^ÂL\s*/,''):'';
    openShipDateModalForCustomer(pickedCustomer);

    const r=(await api.get('/price-matrix/'+id+'/catalog/order')).data;
    setSource(r.source);
    const mapped=(r.products||[]).map((p,idx)=>({
      ...p,
      quantity_expr:'',
      quantity:0,
      sale_price:p.sale_price,
      selected:false,
      sort_order:p.sort_order||idx+1
    }));
    setItems(await applyEffectivePrices(mapped,{customer_id:id,calendar_type:billCalendarType,order_date:orderDate,lunar_date_text:billCalendarType==='LUNAR'?billLunarDateText:''}));
    setPendingFocusQty(true);
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

  useEffect(()=>{
    if(!pendingFocusQty||!cid||!shown.length)return;
    const t=setTimeout(()=>{
      const first=shown.find(x=>qtyRefs.current[x.product_id]);
      if(first&&qtyRefs.current[first.product_id]){
        qtyRefs.current[first.product_id].focus();
        qtyRefs.current[first.product_id].select?.();
      }
      setPendingFocusQty(false);
    },120);
    return()=>clearTimeout(t);
  },[pendingFocusQty,cid,shown.length]);

  const selected=items
    .map(i=>({...i,quantity:calcQtyExpression(i.quantity_expr)||Number(i.quantity||0)}))
    .filter(i=>i.selected&&Number(i.quantity)>0);

  const total=selected.reduce((s,i)=>s+Number(i.quantity||0)*Number(i.sale_price||0),0);


  const changeOrderDate=(v)=>{
    const next=String(v||today).slice(0,10);
    if(isFutureIsoDate(next)){
      alert('Không thể chọn ngày xuất hàng lớn hơn ngày hiện tại.');
      return;
    }
    setOrderDate(next);
    if(billCalendarType==='LUNAR'){
      setBillLunarDateText(formatLunarDate(next||today).replace(/^ÂL\s*/,''));
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
    if(solar){
      if(isFutureIsoDate(solar)){
        alert('Không thể chọn ngày xuất hàng âm lịch lớn hơn ngày hiện tại.');
        return;
      }
      setOrderDate(solar);
    }
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
    if(saving)return;
    setError('');
    setSaveNotice('');
    if(!cid)return alert('Chọn khách hàng');
    const checkedDate=validateShippingDate(billCalendarType,orderDate,billLunarDateText);
    if(!checkedDate.ok)return;
    if(checkedDate.solarDate&&checkedDate.solarDate!==orderDate)setOrderDate(checkedDate.solarDate);
    if(!selected.length)return alert('Nhập số lượng ít nhất 1 mặt hàng');

    const payloadItems=selected.map(i=>({
      product_id:i.product_id,
      product_name:i.product_name,
      unit:i.unit||'kg',
      quantity:Number(i.quantity||0),
      sale_price:Number(i.sale_price||0),
      price_type:i.price_type||'MANUAL_PRICE',
      price_book_id:i.price_book_id||null,
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

    setSaving(true);
    try{
      const r=await api.post('/orders',{
        customer_id:cid,
        order_date:checkedDate.solarDate||orderDate,
        calendar_type:billCalendarType,
        lunar_date_text:billCalendarType==='LUNAR'?billLunarDateText:'',
        current_bill_amount:total,
        monthly_installment_amount:monthlyInstallment,
        installment_amount:monthlyInstallment,
        monthly_installment_id:monthlyInstallmentId,
        paid_amount:0,
        items:payloadItems
      });

      // V65.47: Bill bán hàng không ghi tiền. Tiền mặt/chuyển khoản xử lý riêng ở menu Thu tiền.

      const code=r.data.order_code;
      setMsg(code);
      setSaveNotice(`Đã lưu ${code}. Đang giữ khách ${currentCustomer?.name||''}, có thể nhập bill tiếp theo ngay.`);
      await reloadCustomerCatalogClearQty(cid);
      setPaid(0);
      setCashAmount(0);
      setBankAmount(0);
      if(excelBillQueue.length&&excelBillIndex>=0){
        await goNextExcelSheetAfterSave();
      }else{
        setImportText('');
        setImportPreview([]);
        setImportMsg('');
      }
      focusFirstQtyInput();
    }catch(e){
      const data=e.response?.data||{};
      let message=data.message||e.message||'Không thể lưu bill';
      if(data.code==='PRICE_NOT_FOUND' && data.details?.items?.length){
        message='Không thể lưu bill. Khách hàng chưa có giá cho: '+data.details.items.map(x=>x.product_name||('ID '+x.product_id)).join(', ')+'. Vui lòng cập nhật bảng giá riêng trước.';
      }
      setError(message);
      alert(message);
    }finally{
      setSaving(false);
    }
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
    setExcelBillQueue([]);
    setExcelBillIndex(-1);
  };

  const resetImportFileInputs=()=>{
    if(importExcelFileRef.current)importExcelFileRef.current.value='';
    if(importImageFileRef.current)importImageFileRef.current.value='';
  };

  const startFreshImportSession=()=>{
    importReadSeqRef.current+=1;
    resetImportSession();
    resetImportFileInputs();
    setImportApplyMode('REPLACE');
  };

  const applyExcelBillDate=(bill)=>{
    if(!bill?.date)return '';
    const customerCalendar=String(currentCustomer?.billing_calendar_type||billCalendarType||'SOLAR').toUpperCase()==='LUNAR'?'LUNAR':'SOLAR';
    if(customerCalendar==='LUNAR'){
      const solar=lunarToSolarDate(parseLunarText(bill.date.ddmmyyyy));
      if(!solar){alert('Ngày âm lịch trong Excel không hợp lệ: '+bill.date.ddmmyyyy);return '';}
      if(isFutureIsoDate(solar)){alert('Không thể import bill có ngày xuất hàng lớn hơn ngày hiện tại: '+bill.date.ddmmyyyy+' Âm lịch');return '';}
      setBillCalendarType('LUNAR');
      setBillLunarDateText(bill.date.ddmmyyyy);
      setOrderDate(solar);
      setTimeout(()=>refreshCurrentItemPrices({calendar_type:'LUNAR',order_date:solar,lunar_date_text:bill.date.ddmmyyyy}),0);
      return `${bill.date.ddmmyyyy} Âm lịch`;
    }
    const solar=String(bill.date.iso||'').slice(0,10);
    if(solar&&isFutureIsoDate(solar)){alert('Không thể import bill có ngày xuất hàng lớn hơn ngày hiện tại: '+bill.date.ddmmyyyy+' Dương lịch');return '';}
    setBillCalendarType('SOLAR');
    setBillLunarDateText('');
    if(solar)setOrderDate(solar);
    setTimeout(()=>refreshCurrentItemPrices({calendar_type:'SOLAR',order_date:solar||orderDate,lunar_date_text:''}),0);
    return `${bill.date.ddmmyyyy} Dương lịch`;
  };

  const loadExcelBillToPreview=(queue,index)=>{
    const bill=queue?.[index];
    if(!bill)return;
    const dateText=applyExcelBillDate(bill);
    setImportText((bill.rows||[]).map(r=>`${r.name} ${r.qtyExpr}`).join('\n'));
    setImportPreview(bill.matched||[]);
    const ok=(bill.matched||[]).filter(x=>x.canApply).length;
    const fail=(bill.matched||[]).length-ok;
    setImportMsg(`Excel sheet ${index+1}/${queue.length}: ${bill.sheetName}. Ngày xuất hàng: ${dateText||'không tìm thấy trong file'}. Đọc ${(bill.rows||[]).length} dòng, khớp ${ok}, chưa mapping ${fail}. Bấm "Đưa dòng đã chọn vào bill" để nạp bill này, sau đó bấm "Lưu bill". Sau khi lưu sẽ hỏi xử lý sheet tiếp theo.`);
    if(!importOpen)setImportOpen(true);
  };

  const goNextExcelSheetAfterSave=async()=>{
    if(!excelBillQueue.length||excelBillIndex<0)return;
    const nextIndex=excelBillIndex+1;
    if(nextIndex>=excelBillQueue.length){
      setExcelBillQueue([]);
      setExcelBillIndex(-1);
      setImportMsg('Đã xử lý hết tất cả sheet trong file Excel.');
      return;
    }
    const next=excelBillQueue[nextIndex];
    const ok=await window.appConfirm(`Đã lưu bill hiện tại. Tiếp tục xử lý sheet tiếp theo?\n\nSheet: ${next.sheetName}${next.date?.ddmmyyyy?`\nNgày trong Excel: ${next.date.ddmmyyyy}`:''}`,{title:'Import Excel nhiều sheet',confirmText:'Xử lý sheet tiếp',cancelText:'Dừng import',variant:'info'});
    if(!ok){
      setExcelBillQueue([]);
      setExcelBillIndex(-1);
      setImportMsg('Đã dừng import Excel theo yêu cầu.');
      return;
    }
    setExcelBillIndex(nextIndex);
    loadExcelBillToPreview(excelBillQueue,nextIndex);
  };


  const clearCurrentBillQty=async()=>{
    if(!await window.appConfirm('Xóa toàn bộ số lượng đang nhập trong bill hiện tại?',{title:'Xóa số lượng bill',confirmText:'Xóa',variant:'danger'}))return;
    setItems(prev=>prev.map(x=>({...x,quantity_expr:'',quantity:0,selected:false})));
    setPaid(0);
    setCashAmount(0);
    setBankAmount(0);
    setMsg('');
  };


  const startChangeCustomer=async()=>{
    if(selected.length){
      const ok=await window.appConfirm('Bill hiện tại đang có số lượng. Đổi khách sẽ xóa bill đang nhập. Tiếp tục?',{title:'Đổi khách hàng',confirmText:'Tiếp tục',variant:'warning'});
      if(!ok)return;
    }
    setCid('');
    setItems([]);
    setFilter('');
    setSource('');
    setMsg('');
    setSaveNotice('');
    setPaid(0);
    setCashAmount(0);
    setBankAmount(0);
    setCustomerOpen(true);
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

  const getProductKey=(obj)=>{
    const id=obj?.product_id??obj?.id??obj?.productId;
    return id===undefined||id===null?'':String(id);
  };

  const applyImport=async()=>{
    if(!importPreview.length)return;
    const rowsToApply=importPreview.filter(x=>x.selected&&x.canApply);
    if(!rowsToApply.length){
      alert('Không có dòng hợp lệ được chọn');
      return;
    }

    const warnRows=rowsToApply.filter(x=>x.warnings&&x.warnings.length);
    if(warnRows.length){
      const ok=await window.appConfirm('Có dòng import cảnh báo. Bạn đã kiểm tra kỹ chưa?',{title:'Xác nhận import',confirmText:'Đã kiểm tra',variant:'warning'});
      if(!ok)return;
    }

    // Gom theo product_id trước khi đưa vào bill.
    // Tránh lỗi file Excel có 2 dòng cùng mặt hàng (ví dụ Rìa) bị ghi đè hoặc lệch dòng.
    const grouped=new Map();
    for(const r of rowsToApply){
      const product=r.product||{};
      const key=getProductKey(product)||String(r.product_id||'');
      if(!key)continue;
      const old=grouped.get(key)||{product,row:r,qty:0,count:0,names:[]};
      old.qty=Number((Number(old.qty||0)+Number(r.qty||0)).toFixed(3));
      old.count+=1;
      old.names.push(r.name||r.raw||product.product_name||'');
      grouped.set(key,old);
    }

    let arr=[...items];
    let applied=0;
    let missing=0;
    for(const [key,g] of grouped.entries()){
      const idx=arr.findIndex(x=>getProductKey(x)===key);
      if(idx>=0){
        const oldQty=importApplyMode==='ADD'?Number(arr[idx].quantity||0):0;
        const newQty=Number((oldQty+Number(g.qty||0)).toFixed(3));
        arr[idx]={...arr[idx],quantity:newQty,quantity_expr:String(newQty),selected:newQty>0};
        applied+=g.count;
      }else{
        missing+=g.count;
      }
    }
    setItems(arr);
    setImportPreview(prev=>prev.map(x=>rowsToApply.includes(x)?{...x,selected:false,applied:true}:x));
    const duplicateCount=rowsToApply.length-grouped.size;
    setImportMsg(`Đã đưa ${applied} dòng đã chọn vào bill (${grouped.size} mặt hàng${duplicateCount>0?', đã gộp '+duplicateCount+' dòng trùng':''}, ${importApplyMode==='ADD'?'cộng thêm':'ghi đè'}). Đã bỏ chọn các dòng vừa đưa vào bill để tránh bấm nhầm lần 2.${missing?` Có ${missing} dòng không tìm thấy trong danh mục khách.`:''}`);
  };

  const readExcelFile=async(file)=>{
    if(!file)return;
    if(!cid){
      resetImportFileInputs();
      return alert('Chọn khách trước khi import Excel');
    }
    const readSeq=importReadSeqRef.current+1;
    importReadSeqRef.current=readSeq;
    resetImportSession();
    setImportApplyMode('REPLACE');
    setImportMsg('Đang đọc file Excel mới, đã xóa cache import cũ...');
    try{
      const XLSX=await import('xlsx');
      const buf=await file.arrayBuffer();
      if(readSeq!==importReadSeqRef.current)return;
      const wb=XLSX.read(buf,{cellDates:true});
      if(readSeq!==importReadSeqRef.current)return;

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
      const sheetPick=pickSheetNames(wb.SheetNames,importSheetFilter);
      if(readSeq!==importReadSeqRef.current)return;
      if(sheetPick.missing.length){
        setImportMsg(`Không tìm thấy sheet: ${sheetPick.missing.join(', ')}. Các sheet có trong file: ${wb.SheetNames.join(', ')}`);
        return;
      }
      if(!sheetPick.names.length){
        setImportMsg(`Không có sheet nào được chọn. Các sheet có trong file: ${wb.SheetNames.join(', ')}`);
        return;
      }

      const normalizeHeader=(v)=>String(v||'')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g,'')
        .replace(/đ/g,'d')
        .replace(/[^a-z0-9]+/g,' ')
        .trim();

      const isQtyHeader=(v)=>{
        const h=normalizeHeader(v);
        return h==='so luong'||h==='sl'||h.includes('so luong')||h.includes('s luong')||h.includes('quantity');
      };
      const isNameHeader=(v)=>{
        const h=normalizeHeader(v);
        return h==='danh muc'||h==='mat hang'||h==='hang'||h==='ten hang'||h.includes('danh muc')||h.includes('mat hang')||h.includes('ten hang');
      };
      const toNumberText=(v)=>String(v??'')
        .replace(/[，]/g,'.')
        .replace(/,/g,'')
        .replace(/kg|đ|vnd/gi,'')
        .trim();
      const isNumericCell=(v)=>{
        const t=toNumberText(v);
        return /^-?\d+(?:\.\d+)?$/.test(t) && Number(t)>0;
      };
      const isMoneyLike=(v)=>{
        const n=Number(toNumberText(v));
        return Number.isFinite(n)&&n>=1000;
      };
      const pad=n=>String(n).padStart(2,'0');
      const ddmmyyyyToIso=(text)=>{
        const m=String(text||'').match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
        if(!m)return '';
        return `${m[3]}-${pad(Number(m[2]))}-${pad(Number(m[1]))}`;
      };
      const isoToDdmmyyyy=(iso)=>{
        const m=String(iso||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if(!m)return '';
        return `${m[3]}/${m[2]}/${m[1]}`;
      };
      const parseExcelDate=(v)=>{
        if(v instanceof Date&&!Number.isNaN(v.getTime())){
          const iso=`${v.getFullYear()}-${pad(v.getMonth()+1)}-${pad(v.getDate())}`;
          return {iso,ddmmyyyy:isoToDdmmyyyy(iso)};
        }
        if(typeof v==='number'&&Number.isFinite(v)){
          const d=XLSX.SSF?.parse_date_code?.(v);
          if(d&&d.y&&d.m&&d.d){
            const iso=`${d.y}-${pad(d.m)}-${pad(d.d)}`;
            return {iso,ddmmyyyy:isoToDdmmyyyy(iso)};
          }
        }
        const text=String(v||'').trim();
        const m=text.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
        if(m){
          const ddmmyyyy=`${pad(Number(m[1]))}/${pad(Number(m[2]))}/${m[3]}`;
          return {iso:ddmmyyyyToIso(ddmmyyyy),ddmmyyyy};
        }
        return null;
      };
      const findSheetBillDate=(data)=>{
        // Ưu tiên vùng đầu phiếu: thường là tên khách + ngày + loại lịch ở dòng 2.
        for(let r=0;r<Math.min(data.length,8);r++){
          const row=data[r]||[];
          for(let c=0;c<row.length;c++){
            const d=parseExcelDate(row[c]);
            if(d)return d;
          }
        }
        for(let r=0;r<data.length;r++){
          const row=data[r]||[];
          for(let c=0;c<row.length;c++){
            const d=parseExcelDate(row[c]);
            if(d)return d;
          }
        }
        return null;
      };

      const parseSheetRows=(sheetName)=>{
        const ws=wb.Sheets[sheetName];
        const data=XLSX.utils.sheet_to_json(ws,{header:1,defval:'',raw:true});
        let headerRow=-1,nameCol=-1,qtyCol=-1;
        for(let r=0;r<data.length;r++){
          const row=data[r]||[];
          let rowNameCol=-1,rowQtyCol=-1;
          for(let c=0;c<row.length;c++){
            if(rowNameCol<0&&isNameHeader(row[c]))rowNameCol=c;
            if(rowQtyCol<0&&isQtyHeader(row[c]))rowQtyCol=c;
          }
          if(rowNameCol>=0&&rowQtyCol>=0){headerRow=r;nameCol=rowNameCol;qtyCol=rowQtyCol;break;}
        }

        // Fallback: tìm cặp cột text + số lượng, tránh cột đơn giá/thành tiền.
        if(nameCol<0||qtyCol<0){
          let best={score:-1,nameCol:-1,qtyCol:-1};
          const maxCols=Math.max(...data.map(r=>(r||[]).length),0);
          for(let nc=0;nc<maxCols;nc++){
            for(let qc=0;qc<maxCols;qc++){
              if(nc===qc)continue;
              let score=0;
              for(let r=0;r<data.length;r++){
                const name=String((data[r]||[])[nc]||'').trim();
                const qty=(data[r]||[])[qc];
                if(name&&!isNumericCell(name)&&isNumericCell(qty)&&!isMoneyLike(qty))score++;
              }
              if(score>best.score)best={score,nameCol:nc,qtyCol:qc};
            }
          }
          if(best.score>0){nameCol=best.nameCol;qtyCol=best.qtyCol;headerRow=-1;}
        }

        if(nameCol<0||qtyCol<0)return {sheetName,rows:[],date:findSheetBillDate(data),error:`Sheet ${sheetName}: không tìm thấy cột Danh mục/Số lượng`};

        const rows=[];
        for(let r=(headerRow>=0?headerRow+1:0);r<data.length;r++){
          const row=data[r]||[];
          const name=String(row[nameCol]||'').trim();
          const qtyText=toNumberText(row[qtyCol]);
          if(!name||!isNumericCell(qtyText))continue;
          if(isNameHeader(name)||isQtyHeader(name))continue;
          rows.push({
            name,
            qtyExpr:String(qtyText),
            qty:Number(qtyText),
            raw:`[${sheetName}] ${name} ${qtyText}`,
            sourceType:'excel',
            sheetName,
            warnings:[],
            errors:[],
            selected:true
          });
        }
        return {sheetName,rows,date:findSheetBillDate(data),error:''};
      };

      const sheetResults=sheetPick.names.map(parseSheetRows);
      const billQueue=sheetResults
        .filter(x=>x.rows&&x.rows.length)
        .map(x=>({
          sheetName:x.sheetName||x.rows?.[0]?.sheetName||'',
          rows:x.rows,
          date:x.date,
          error:x.error||'',
          matched:matchImportedRows(x.rows,items)
        }));
      if(!billQueue.length){
        setImportMsg('Không tìm thấy dòng hàng hợp lệ trong Excel. Kiểm tra lại cột Danh mục/Số lượng ở các sheet.');
        return;
      }
      if(readSeq!==importReadSeqRef.current)return;
      const errText=sheetResults.filter(x=>x.error).map(x=>x.error).join(' ');
      setExcelBillQueue(billQueue);
      setExcelBillIndex(0);
      loadExcelBillToPreview(billQueue,0);
      setImportMsg(prev=>`${prev} Đã đọc ${sheetPick.names.length}/${wb.SheetNames.length} sheet${importSheetFilter?` theo chỉ định: ${sheetPick.names.join(', ')}`:''}. Có ${billQueue.length} sheet có dữ liệu = ${billQueue.length} bill riêng. ${errText?' '+errText:''}`);
    }catch(e){
      if(readSeq===importReadSeqRef.current)setImportMsg('Không đọc được Excel: '+e.message);
    }finally{
      resetImportFileInputs();
    }
  };

  const readImageFile=async(file)=>{
    if(!file)return;
    const readSeq=importReadSeqRef.current+1;
    importReadSeqRef.current=readSeq;
    resetImportSession();
    setImportApplyMode('REPLACE');
    try{
      setImportMsg('Đang OCR hình ảnh mới, đã xóa cache import cũ...');
      const Tesseract=await import('tesseract.js');
      const res=await Tesseract.recognize(file,'vie+eng');
      if(readSeq!==importReadSeqRef.current)return;
      setImportText(res.data.text||'');
      setImportMsg('Đã OCR ảnh. Kiểm tra lại text rồi bấm Xem trước OCR ảnh.');
    }catch(e){
      if(readSeq===importReadSeqRef.current)setImportMsg('OCR ảnh chưa chạy được trên máy này: '+e.message+'. Có thể nhập/copy text vào ô bên dưới.');
    }finally{
      resetImportFileInputs();
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
        {shipDateModalOpen&&currentCustomer&&(
          <div className="modal-backdrop pos-ship-date-backdrop">
            <div className="modal-card pos-ship-date-modal">
              <div className="modal-header">
                <div>
                  <h2>Chọn ngày xuất hàng</h2>
                  <p className="muted">Khách <b>{currentCustomer.name}</b> tính bill theo <b>{billCalendarType==='LUNAR'?'Âm lịch':'Dương lịch'}</b>. Bảng giá riêng sẽ lấy theo ngày xuất hàng này.</p>
                </div>
                <button type="button" className="btn secondary" onClick={()=>setShipDateModalOpen(false)}>Đóng</button>
              </div>

              {billCalendarType==='LUNAR'?(
                <div className="form-grid">
                  <label className="field-label">
                    <span>Ngày xuất hàng âm lịch</span>
                    <input className="input" value={billLunarDateText||''} onChange={e=>changeBillLunarDateText(e.target.value)} placeholder="VD: 08/01/2026" autoFocus/>
                  </label>
                  <label className="field-label">
                    <span>Ngày dương quy đổi</span>
                    <input className="input" type="date" max={today} value={orderDate||today} onChange={e=>changeOrderDate(e.target.value)}/>
                  </label>
                  <div className="ai-alert" style={{gridColumn:'1 / -1'}}>
                    POS sẽ lấy bảng giá âm lịch gần nhất trước hoặc bằng <b>{billLunarDateText||'ngày âm đã chọn'}</b>.
                  </div>
                </div>
              ):(
                <div className="form-grid">
                  <label className="field-label">
                    <span>Ngày xuất hàng dương lịch</span>
                    <input className="input" type="date" max={today} value={orderDate||today} onChange={e=>changeOrderDate(e.target.value)} autoFocus/>
                  </label>
                  <div className="ai-alert" style={{gridColumn:'1 / -1'}}>
                    POS sẽ lấy bảng giá dương lịch gần nhất trước hoặc bằng <b>{orderDate||today}</b>.
                  </div>
                </div>
              )}

              <div className="modal-footer">
                <button type="button" className="btn secondary" onClick={()=>setShipDateModalOpen(false)}>Chọn sau</button>
                <button type="button" className="btn" onClick={applyShipDateModal}>Áp dụng ngày xuất hàng</button>
              </div>
            </div>
          </div>
        )}

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
              {currentCustomer&&(
                <div className="pos-bill-context-row">
                  <div className="pos-bill-context-pill" title="Ngày xuất hàng dùng để lấy bảng giá riêng đúng thời gian bill">
                    <span className="pos-bill-context-icon">📅</span>
                    <span>
                      <b>Ngày bill:</b>{' '}
                      {billCalendarType==='LUNAR'
                        ? `${billLunarDateText||'chưa chọn'} ÂL${orderDate ? ' / DL '+String(orderDate).slice(0,10).split('-').reverse().join('/') : ''}`
                        : `${String(orderDate||today).slice(0,10).split('-').reverse().join('/')} DL`}
                    </span>
                  </div>
                  <button type="button" className="btn tiny secondary" onClick={()=>openShipDateModalForCustomer(currentCustomer)}>
                    Đổi ngày
                  </button>
                </div>
              )}

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
                    <input inputMode="decimal" className="input" placeholder="Đơn vị" value={quick.unit||'kg'} onChange={e=>setQuick({...quick,unit:e.target.value})}/>
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
                    <input className="input" style={{maxWidth:360}} placeholder="Sheet cần đọc (trống = tất cả, nhiều sheet cách nhau dấu phẩy)" value={importSheetFilter} onChange={e=>setImportSheetFilter(e.target.value)}/>
                    <input ref={importExcelFileRef} type="file" accept=".xlsx,.xls,.csv" onClick={e=>{e.currentTarget.value='';startFreshImportSession();}} onChange={e=>{const file=e.target.files?.[0];e.target.value='';readExcelFile(file);}}/>
                    <input ref={importImageFileRef} type="file" accept="image/*" onClick={e=>{e.currentTarget.value='';startFreshImportSession();}} onChange={e=>{const file=e.target.files?.[0];e.target.value='';readImageFile(file);}}/>
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
                                <input inputMode="decimal" className="input" style={{width:120}} value={r.qtyExpr||r.quantity_expr||r.qty||''} onChange={e=>updateImportRow(idx,{qtyExpr:e.target.value})}/>
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

            {currentCustomer&&(
              <div className="pos-customer-session-banner">
                <div>
                  <span className="pos-session-label">Đang tạo bill cho</span>
                  <b>{currentCustomer.name}</b>
                  <span className="muted"> • {billCalendarType==='LUNAR'?'Âm lịch':'Dương lịch'} {billCalendarType==='LUNAR'?billLunarDateText:orderDate}</span>
                </div>
                <div className="actions">
                  <button type="button" className="btn secondary" onClick={focusFirstQtyInput}>Nhập bill tiếp</button>
                  <button type="button" className="btn secondary" onClick={startChangeCustomer}>Đổi khách</button>
                </div>
              </div>
            )}

            {saveNotice&&<div className="ai-alert success pos-save-session-notice">✔ {saveNotice}</div>}

            <POSProductTableAgent
              shown={shown}
              items={items}
              filter={filter}
              setFilter={setFilter}
              saveOrder={saveOrder}
              cid={cid}
              qtyRefs={qtyRefs}
              focusNext={focusNext}
              focusFirstFilteredItem={focusFirstQtyInput}
              updateQtyExpr={updateQtyExpr}
              dragId={dragId}
              setDragId={setDragId}
              handleDrop={handleDrop}
            />
          </main>

          <aside className="card pos-payment-panel">
            <h3>Thông tin thanh toán</h3>
            <p className="muted">Từ V65.47, Bill chỉ quản lý hàng và giá. Tiền mặt/chuyển khoản xử lý ở menu <b>Thu tiền</b> để công nợ và phân bổ bill cũ không bị rối.</p>
            <div className="payment-total-box"><div>Tổng bill</div><b>{money(total)}</b><span>Góp/ngày: {money(monthlyInstallment)}</span><span>Thanh toán: vào menu Thu tiền</span></div>
            <div className="actions" style={{marginTop:12}}><button type="button" className="btn" disabled={saving||!cid||!selected.length} onClick={save}>{saving?'Đang lưu...':'Lưu bill'}</button><button type="button" className="btn secondary" onClick={clearCurrentBillQty}>Xóa số lượng</button></div>
            {msg&&<div className="ai-alert success" style={{marginTop:12}}>Đã lưu: <b>{msg}</b></div>}
          </aside>
        </div>

        <div className="pos-bottom-ai-tools">
          <AIBusinessPanel compact title="AI nhập hàng / tồn kho"/>
          <AIVoicePOSPanel sessionId={`POS_${cid||'NO_CUSTOMER'}`}/>
        </div>
      </div>
    </SafePage>
  );
}
