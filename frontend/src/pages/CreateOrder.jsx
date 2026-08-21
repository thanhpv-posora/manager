import React,{useEffect,useMemo,useRef,useState}from'react';
import api from'../api/api';
import SafePage from'../components/SafePage';
import MoneyInput from'../components/MoneyInput';
import POSProductTableAgent from'../components/pos/POSProductTableAgent';
import POSBillContextBar from'../components/pos/POSBillContextBar';
import POSAdvancedTools from'../components/pos/POSAdvancedTools';
import POSBillSummary from'../components/pos/POSBillSummary';
import AIBusinessPanel from'../components/ai/AIBusinessPanel';
import AIVoicePOSPanel from'../components/ai/AIVoicePOSPanel';
import {calcQtyExpression,roundQty}from'../utils/qtyExpression';
import {isOverStock}from'../utils/quantity';
import {formatLunarDate,solarToLunar,parseLunarText,lunarToSolarDate}from'../utils/lunarDate';
import {createSpeechRecognition,parseVoiceBillCommand,voiceSupported} from'../utils/voiceBillParser';
import {matchImportedRows,parseOrderText,rematchOne,getProductKey,groupImportRowsByProduct} from'../utils/orderImportParser';
import {parseHandwritingText} from'../utils/handwritingBillParser';
import CalendarDialog from'../components/common/CalendarDialog';
import Dialog from'../components/common/Dialog';
import {showWarning,showSuccess,showError}from'../utils/toast';

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
// FEAT (same-day bill warning): primary/secondary date text for the
// confirm dialog, following the customer's own billing calendar — same
// solarToLunar()/lunar-text convention every other calendar display in this
// app uses (utils/lunarDate.js), never a second conversion implementation.
// SOLAR customer: solar primary, lunar (ÂL) secondary in parens.
// LUNAR customer: lunar (ÂL) primary, solar (DL) secondary in parens.
const sameDayBillDateLabel=(solarDateIso,calendarType,lunarDateText)=>{
  const m=String(solarDateIso||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const solarLabel=m?`${m[3]}/${m[2]}/${m[1]}`:String(solarDateIso||'');
  if(String(calendarType).toUpperCase()==='LUNAR'){
    const lunarLabel=lunarDateText||formatLunarDate(solarDateIso).replace(/^ÂL\s*/,'');
    return `${lunarLabel} ÂL\n(${solarLabel} DL)`;
  }
  const l=solarToLunar(solarDateIso);
  const lunarLabel=`${String(l.day).padStart(2,'0')}/${String(l.month).padStart(2,'0')}/${l.year}`;
  return `${solarLabel}\n(${lunarLabel} ÂL)`;
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
  const[billLunarDraftText,setBillLunarDraftText]=useState('');
  const[shipDateDialogError,setShipDateDialogError]=useState('');
  const[shipDateModalOpen,setShipDateModalOpen]=useState(false);

  const[customers,setCustomers]=useState([]);
  const[categories,setCategories]=useState([]);
  const[items,setItemsRaw]=useState([]);
  // ENTRY-ORDER-RULE: line_no is assigned once, the first time a row's quantity
  // goes positive (rule A), and is never reassigned afterward — including a
  // zero->positive->zero->positive round-trip before save (rules B/C/D). This
  // wraps the single setItems setter (instead of touching every call site that
  // can set a quantity — POS table typing, quick-add/other-flow merge,
  // Excel/OCR import, voice bill, +/- steppers) so no current or future entry
  // path can bypass it. `selected` is set in lockstep with quantity by every
  // one of those call sites, so `selected && quantity>0` is the same "really
  // entered" signal already used by the selected/payloadItems totals below.
  // This function only ever adds a line_no, never removes one (rule C) — a
  // genuinely new bill instead constructs fresh item objects with no line_no
  // field at all (the catalog-load setItems([])/mapped(...) paths below).
  const setItems=updater=>{
    setItemsRaw(prev=>{
      const next=typeof updater==='function'?updater(prev):updater;
      let maxLineNo=next.reduce((m,x)=>Math.max(m,Number(x.line_no)||0),0);
      return next.map(x=>{
        if(x.selected&&Number(x.quantity)>0&&!x.line_no){
          maxLineNo+=1;
          return {...x,line_no:maxLineNo};
        }
        return x;
      });
    });
  };
  const[cid,setCid]=useState('');
  const[selectedCategoryId,setSelectedCategoryId]=useState('');
  const[categorySelection,setCategorySelection]=useState({categories:[],auto_selected_category_id:null,requires_selection:false,needs_initialization:false});
  const[categoryChooserOpen,setCategoryChooserOpen]=useState(false);
  const[addCategoryPickerId,setAddCategoryPickerId]=useState('');
  const[addCategoryBusy,setAddCategoryBusy]=useState(false);
  const[paid,setPaid]=useState(0);
  const[cashAmount,setCashAmount]=useState(0);
  const[bankAmount,setBankAmount]=useState(0);
  const[monthlyInstallment,setMonthlyInstallment]=useState(0);
  const[monthlyInstallmentId,setMonthlyInstallmentId]=useState(null);
  // FEAT (manual góp bill, per-bill contribution override): monthlyInstallment
  // above stays exactly what it always was — the customer's CONFIGURED daily
  // default, loaded read-only via loadMonthlyInstallment(). billInstallmentAmount
  // is the ACTUAL amount that will be saved on THIS bill's orders.installment_amount
  // — normally mirrors the default, but the operator may edit it for exceptions
  // (e.g. covering a missed day). Editing it never writes back to the customer's
  // configured default (no PUT/POST to /installments/monthly/* happens here).
  // installmentManuallyEditedRef tracks whether the operator has touched the
  // field for the bill currently being entered, mirroring the existing
  // manual_price/force_manual_price convention used for line-item prices
  // elsewhere in this file — a manual entry survives an unrelated re-render,
  // but is cleared (falls back to auto-sync with the default) on customer
  // switch or after a successful save, so the NEXT bill always starts from
  // the configured default again.
  const[billInstallmentAmount,setBillInstallmentAmount]=useState(0);
  const installmentManuallyEditedRef=useRef(false);
  const[msg,setMsg]=useState('');
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState('');
  const[filter,setFilter]=useState('');
  const[toolsOpen,setToolsOpen]=useState(false);
  const[saveNotice,setSaveNotice]=useState('');
  const[saving,setSaving]=useState(false);
  const[noPrivatePrice,setNoPrivatePrice]=useState(false);
  const[catalogLoading,setCatalogLoading]=useState(false);
  const[pendingFocusQty,setPendingFocusQty]=useState(false);

  const[quickOpen,setQuickOpen]=useState(false);
  const[voiceOpen,setVoiceOpen]=useState(false);
  const[importOpen,setImportOpen]=useState(false);

  // Patch 01 (Unified POS Product Entry refactor) — dialog-framework scaffolding.
  // Add Product's and Quick Add's Patch-01 placeholder flags are gone — Patch 02
  // and Patch 03 reuse otherFlowOpen/quickOpen as each dialog's open flag
  // directly, since each of those had exactly one production surface to begin
  // with. Import is different by CTO decision: legacy Import (POSAdvancedTools,
  // gated by toolsOpen/importOpen, untouched) and the new Excel Import dialog
  // shell are two independent workflows kept alive side by side until the final
  // Excel migration patch unifies them. excelImportDialogOpen is therefore its
  // own, separate flag — never importOpen, never touching POSAdvancedTools.
  const[excelImportDialogOpen,setExcelImportDialogOpen]=useState(false);

  const[quick,setQuick]=useState({unit:'kg'});
  const[dragId,setDragId]=useState(null);

  // Unified Sales V1: default_sales_flow only decides which catalog loads first —
  // sellers may always add products from the other flow into the same bill via the
  // browser panel below. Backend (deriveItemsSalesFlow/recomputeOrderSalesFlow)
  // remains the sole authority on the resulting per-item and order-header sales_flow.
  const[otherFlowOpen,setOtherFlowOpen]=useState(false);
  const[otherFlowCategorySelection,setOtherFlowCategorySelection]=useState({categories:[],auto_selected_category_id:null,requires_selection:false,needs_initialization:false});
  const[otherFlowSelectedCategoryId,setOtherFlowSelectedCategoryId]=useState('');
  const[otherFlowAddCategoryPickerId,setOtherFlowAddCategoryPickerId]=useState('');
  const[otherFlowAddCategoryBusy,setOtherFlowAddCategoryBusy]=useState(false);
  const[otherFlowItems,setOtherFlowItems]=useState([]);
  const[otherFlowCatalogLoading,setOtherFlowCatalogLoading]=useState(false);
  const[otherFlowFilter,setOtherFlowFilter]=useState('');

  const[voiceText,setVoiceText]=useState('');
  const[voiceProductId,setVoiceProductId]=useState('');
  const[voiceMsg,setVoiceMsg]=useState('');
  const[listening,setListening]=useState(false);

  const[importText,setImportText]=useState('');
  const[importPreview,setImportPreview]=useState([]);
  const[importMsg,setImportMsg]=useState('');
  const[importApplying,setImportApplying]=useState(false);
  const[allProducts,setAllProducts]=useState([]);
  const[ocrAliases,setOcrAliases]=useState([]);
  const[importApplyMode,setImportApplyMode]=useState('REPLACE');
  const[importSheetFilter,setImportSheetFilter]=useState('');
  const[excelBillQueue,setExcelBillQueue]=useState([]);
  const[excelBillIndex,setExcelBillIndex]=useState(-1);
  // PRODUCTION HOTFIX — POS Excel Import candidate pool, independent of the
  // customer-catalog-scoped `items` (POS grid). See loadImportCandidates().
  const[importCandidates,setImportCandidates]=useState([]);

  const qtyRefs=useRef({});
  const priceRefs=useRef({});
  const otherFlowQtyRefs=useRef({});
  const searchInputRef=useRef(null);
  // True only for the one qty input that search-Enter just focused, so its own
  // Enter returns to search instead of falling through to grid navigation.
  // Reset the moment focus moves anywhere else (see onFocus in POSProductTableAgent).
  const fastEntryFromSearchRef=useRef(false);
  // S6.5: stable per-bill-attempt key sent to /orders so a double-click or a
  // network retry of the SAME save() attempt resolves to the same order instead
  // of creating a second one. Generated lazily on first use, rotated only after
  // that attempt actually succeeds (see save()) — never regenerated on retry.
  const billIdempotencyKeyRef=useRef(null);
  const customerAutocompleteRef=useRef(null);
  const categorySelectRef=useRef(null);
  const[pendingFocusCustomer,setPendingFocusCustomer]=useState(false);
  const importExcelFileRef=useRef(null);
  const importImageFileRef=useRef(null);
  const importReadSeqRef=useRef(0);
  // Patch 04B — the Excel Import dialog's own copy of the Import Center controls
  // (see the dialog JSX below) calls the exact same readExcelFile/readImageFile
  // functions as Legacy Import, but needs its OWN file-input refs: Legacy Import
  // was restored to full production function (see the Patch 04B report's
  // REQUIRES_CTO_DECISION — removing it would have made Excel/OCR/Handwriting
  // unreachable in production, since the new dialog is still dev-only), so both
  // copies can be simultaneously mounted. Reusing importExcelFileRef/
  // importImageFileRef across two mounted <input type="file"> elements is
  // exactly what File Input Safety forbids.
  const excelImportDialogExcelFileRef=useRef(null);
  const excelImportDialogImageFileRef=useRef(null);

  const quickNameInputRef=useRef(null);
  const quickUnitInputRef=useRef(null);
  const quickAddSaveBtnRef=useRef(null);
  const quickAddSectionRef=useRef(null);
  const toolsFirstInputRef=useRef(null);
  const[pendingFocusQuickName,setPendingFocusQuickName]=useState(false);
  const[pendingFocusTools,setPendingFocusTools]=useState(false);

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

  // S1I Patch A: monthlyInstallment (fetched separately via loadMonthlyInstallment,
  // backend snake_case installment_amount already converted to a number above) is
  // normalized onto currentCustomer here — the single adapter boundary — so every
  // consumer reads the canonical camelCase currentCustomer.monthlyInstallment
  // instead of threading a second, disconnected prop through the tree.
  const currentCustomer=useMemo(()=>{
    const base=customers.find(c=>String(c.id)===String(cid));
    return base?{...base,monthlyInstallment}:base;
  },[customers,cid,monthlyInstallment]);

  // Customer Default Model: default_sales_flow only picks which catalog loads by
  // default (CARCASS_POS for NULL/legacy customers, same Legacy Model used
  // everywhere else) — it is never a restriction. The "other flow" browser below
  // lets the seller add products from the opposite flow into the same bill.
  const flowForCustomerId=(custId)=>{
    const c=customers.find(x=>String(x.id)===String(custId));
    return c?.default_sales_flow==='INVENTORY_SALE'?'INVENTORY_SALE':'CARCASS_POS';
  };
  const flowLabel=(f)=>f==='INVENTORY_SALE'?'Hàng Kho':'Bò Xô';
  const primaryFlow=flowForCustomerId(cid);
  const otherFlow=primaryFlow==='INVENTORY_SALE'?'CARCASS_POS':'INVENTORY_SALE';

  const assignedCategoryIds=useMemo(()=>new Set((categorySelection.categories||[]).map(c=>String(c.category_id))),[categorySelection]);
  const unassignedCategories=useMemo(()=>categories.filter(c=>!assignedCategoryIds.has(String(c.id))),[categories,assignedCategoryIds]);
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
        if(showAlert)showWarning('Ngày âm lịch không hợp lệ. Vui lòng nhập dạng dd/mm/yyyy.');
        return {ok:false,solarDate:resolvedSolar,reason:'INVALID_LUNAR_DATE'};
      }
      resolvedSolar=converted;
    }
    if(isFutureIsoDate(resolvedSolar)){
      if(showAlert)showWarning('Không thể tạo bill cho ngày xuất hàng lớn hơn ngày hiện tại.');
      return {ok:false,solarDate:resolvedSolar,reason:'FUTURE_BILL_DATE'};
    }
    return {ok:true,solarDate:resolvedSolar};
  };


  useEffect(()=>{loadMonthlyInstallment(cid,orderDate,billCalendarType,billLunarDateText)},[cid,orderDate,billCalendarType,billLunarDateText]);

  // FEAT (manual góp bill): keep the editable billInstallmentAmount in sync
  // with the loaded configured default UNLESS the operator has explicitly
  // edited it for the bill currently being entered (installmentManuallyEditedRef).
  useEffect(()=>{
    if(!installmentManuallyEditedRef.current)setBillInstallmentAmount(monthlyInstallment);
  },[monthlyInstallment]);

  // Switching customer starts a fresh bill context — any manual override
  // belonged to the previous customer's bill, so drop it and let the new
  // customer's own configured default apply as soon as it loads.
  useEffect(()=>{installmentManuallyEditedRef.current=false},[cid]);

  const changeBillInstallmentAmount=v=>{
    // Never let a negative number reach the payload/total (see backend guard
    // in OrderAgent.create() too) — clamp instead of silently accepting it.
    const n=Math.max(0,Number(v||0));
    installmentManuallyEditedRef.current=true;
    setBillInstallmentAmount(n);
  };

  useEffect(()=>{
    if(cid&&items.length)refreshCurrentItemPrices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[cid,orderDate,billCalendarType,billLunarDateText]);

  // PERF (A5, perf-bill-contribution): GET /products (full, unfiltered,
  // all-columns product table) used to load on EVERY POS mount, before a
  // customer is even selected — audited to have exactly one consumer on
  // this screen, previewHandwriting()'s category-scoped OCR-alias matching,
  // a deliberate low-frequency action (operator explicitly opens the
  // handwriting-import tool). Deferred instead of loaded eagerly:
  // ensureAllProductsLoaded() below fetches it lazily, once, only when that
  // tool is actually used. Every OTHER consumer of GET /products in this
  // codebase (Products.jsx, InventoryAdjustments.jsx, InventoryPurchases.jsx,
  // StockLedger.jsx) has its OWN separate api.get('/products') call — this
  // endpoint itself is untouched, still returns the full shape for them.
  const ensureAllProductsLoaded=async()=>{
    if(allProducts.length)return allProducts;
    try{
      const r=await api.get('/products');
      setAllProducts(r.data||[]);
      return r.data||[];
    }catch(e){
      return allProducts;
    }
  };

  useEffect(()=>{
    let mounted=true;
    (async()=>{
      try{
        const [c,cat]=await Promise.all([
          api.get('/partners',{params:{role:'customer'}}),
          api.get('/products/categories')
        ]);
        if(mounted){
          setCustomers(c.data||[]);
          setCategories(cat.data||[]);
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
        return {...p,sale_price:Number(price.sale_price),price_type:price.price_type,price_book_id:price.price_book_id||null,effective_from:price.effective_from||null};
      }
      return p;
    });
  };

  const refreshCurrentItemPrices=async(context={})=>{
    if(!cid||!items.length)return;
    const updated=await applyEffectivePrices(items,context);
    setItems(prev=>prev.map(x=>{
      const hit=updated.find(u=>String(u.product_id)===String(x.product_id));
      return hit?{...x,sale_price:hit.sale_price,price_type:hit.price_type,price_book_id:hit.price_book_id,effective_from:hit.effective_from}:x;
    }));
  };


  const reloadCustomerCatalogKeepQty=async(id)=>{
    if(!selectedCategoryId){setItems([]);return;}
    const oldByProduct=new Map(items.map(x=>[
      String(x.product_id),
      {quantity_expr:x.quantity_expr,quantity:x.quantity,selected:x.selected}
    ]));
    // Rows merged in from the other sales flow's catalog (see openOtherFlowBrowser)
    // are not part of this category's fetch below — preserve them as-is so Quick
    // Add / catalog reorder never silently drops them from the bill.
    const extraOtherFlowItems=items.filter(x=>x._extraFlow);

    setCatalogLoading(true);
    try{
      const r=(await api.get('/price-matrix/'+id+'/catalog/order',{params:{category_id:selectedCategoryId,order_date:orderDate||today,sales_flow:flowForCustomerId(id),lunar_date_text:billCalendarType==='LUNAR'?billLunarDateText:''}})).data;
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
      setItems(await applyEffectivePrices([...mapped,...extraOtherFlowItems]));
      setNoPrivatePrice(!!r.no_private_prices);
    }finally{
      setCatalogLoading(false);
    }
  };


  const reloadCustomerCatalogClearQty=async(id)=>{
    fastEntryFromSearchRef.current=false;
    if(!id||!selectedCategoryId){setItems([]);return;}
    setCatalogLoading(true);
    try{
      const r=(await api.get('/price-matrix/'+id+'/catalog/order',{params:{category_id:selectedCategoryId,order_date:orderDate||today,sales_flow:flowForCustomerId(id),lunar_date_text:billCalendarType==='LUNAR'?billLunarDateText:''}})).data;
      const mapped=(r.products||[]).map((p,idx)=>({
        ...p,
        quantity_expr:'',
        quantity:0,
        sale_price:p.sale_price,
        selected:false,
        sort_order:p.sort_order||idx+1
      }));
      setItems(await applyEffectivePrices(mapped,{customer_id:id,calendar_type:billCalendarType,order_date:orderDate,lunar_date_text:billCalendarType==='LUNAR'?billLunarDateText:''}));
      setNoPrivatePrice(!!r.no_private_prices);
      setPendingFocusQty(true);
    }finally{
      setCatalogLoading(false);
    }
  };

  // Keyboard fast-entry: resolve which visible product Enter in the search box
  // should jump to — exact code match, then exact name match (case-insensitive,
  // accent-sensitive), then the first visible filtered row. Scoped to `shown` so
  // it only ever lands on a product the cashier can currently see.
  const resolveSearchTargetProduct=()=>{
    const q=filter.trim().toLowerCase();
    if(!q)return shown.find(x=>qtyRefs.current[x.product_id])||null;
    const byCode=shown.find(x=>String(x.product_code||'').trim().toLowerCase()===q&&qtyRefs.current[x.product_id]);
    if(byCode)return byCode;
    const byName=shown.find(x=>String(x.product_name||'').trim().toLowerCase()===q&&qtyRefs.current[x.product_id]);
    if(byName)return byName;
    return shown.find(x=>qtyRefs.current[x.product_id])||null;
  };

  // `fromSearch` is only true for the search box's own Enter — that's the sole
  // trigger that should arm fastEntryFromSearchRef. The post-save "keep going"
  // auto-focus reuses this same function but must NOT arm it, or the very next
  // plain grid Enter would wrongly jump back to search instead of the next row.
  const focusFirstQtyInput=(fromSearch=false)=>{
    setTimeout(()=>{
      const target=resolveSearchTargetProduct();
      if(target&&qtyRefs.current[target.product_id]){
        qtyRefs.current[target.product_id].focus();
        qtyRefs.current[target.product_id].select?.();
        fastEntryFromSearchRef.current=fromSearch;
      }
    },80);
  };

  // Fast-entry loop: after a valid (non-overstock, >0) quantity is committed with
  // Enter, hand focus straight back to search with the old keyword cleared so the
  // next product code/name can be typed immediately — no mouse needed.
  const returnToSearchAfterQty=()=>{
    fastEntryFromSearchRef.current=false;
    setFilter('');
    requestAnimationFrame(()=>{
      searchInputRef.current?.focus();
      searchInputRef.current?.select?.();
    });
  };

  // F2 = jump to product search from anywhere on this screen (including from a
  // quantity input, to abandon sequential entry and search another product).
  // Scoped to this page only — the listener is added/removed with the component.
  // Suppressed while a real dialog is open, during the keyboard-guided category
  // step, or while typing in a textarea, since stealing focus there would be unsafe.
  useEffect(()=>{
    const handleF2=(e)=>{
      if(e.key!=='F2')return;
      if(shipDateModalOpen||categoryChooserOpen||excelImportDialogOpen||quickOpen||otherFlowOpen)return;
      if(document.activeElement&&document.activeElement.tagName==='TEXTAREA')return;
      e.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select?.();
    };
    window.addEventListener('keydown',handleF2);
    return()=>window.removeEventListener('keydown',handleF2);
  },[shipDateModalOpen,categoryChooserOpen,excelImportDialogOpen,quickOpen,otherFlowOpen]);

  const openShipDateModalForCustomer=(customer)=>{
    if(!customer)return;
    const preferred=String(customer.billing_calendar_type||'SOLAR').toUpperCase()==='LUNAR'?'LUNAR':'SOLAR';
    setBillCalendarType(preferred);
    if(preferred==='LUNAR'){
      const defaultLunarText=formatLunarDate(orderDate||today).replace(/^ÂL\s*/,'');
      setBillLunarDateText(defaultLunarText);
      setBillLunarDraftText(defaultLunarText);
    }else{
      setBillLunarDateText('');
      setBillLunarDraftText('');
    }
    setShipDateDialogError('');
    setShipDateModalOpen(true);
  };

  const applyShipDateModal=async()=>{
    if(!cid)return setShipDateModalOpen(false);
    setShipDateDialogError('');
    if(billCalendarType==='LUNAR'&&!String(billLunarDraftText||'').trim()){
      setShipDateDialogError('Vui lòng nhập ngày xuất hàng âm lịch (dd/mm/yyyy).');
      return;
    }
    const checked=validateShippingDate(billCalendarType,orderDate,billLunarDraftText,{showAlert:false});
    if(!checked.ok){
      setShipDateDialogError(checked.reason==='FUTURE_BILL_DATE'
        ? 'Không thể chọn ngày xuất hàng lớn hơn ngày hiện tại.'
        : 'Ngày âm lịch không hợp lệ. Vui lòng nhập dạng dd/mm/yyyy.'
      );
      return;
    }
    const nextOrderDate=checked.solarDate||orderDate;
    const nextCalendarType=billCalendarType;
    const nextLunarDateText=billCalendarType==='LUNAR'?billLunarDraftText:'';
    setBillLunarDateText(nextLunarDateText);
    if(nextOrderDate!==orderDate)setOrderDate(nextOrderDate);
    setShipDateModalOpen(false);
    const dateLabel=nextCalendarType==='LUNAR'?`${billLunarDraftText} ÂL`:(nextOrderDate||today);
    // Only show price-book lookup notice when customer actually has a price matrix.
    // Manual-price mode (no price matrix, walk-in) has nothing to look up.
    setSaveNotice((!noPrivatePrice&&!walkInCustomer)
      ? `Đã chọn ngày xuất hàng ${dateLabel}. Bảng giá sẽ lấy theo đúng ngày này.`
      : `Đã chọn ngày xuất hàng ${dateLabel}.`
    );
    // The effect watching [cid,orderDate,billCalendarType,billLunarDateText] performs the
    // single required price refresh once the state above commits — no need to also await
    // refreshCurrentItemPrices here (that was firing a redundant second request per confirm).
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
    setSelectedCategoryId('');
    setItems([]);
    setNoPrivatePrice(false);
    resetImportSession();
    setImportApplyMode('REPLACE');
    try{
      const a=await api.get('/handwriting/aliases?customer_id='+id);
      setOcrAliases(a.data||[]);
    }catch(e){
      setOcrAliases([]);
    }

    if(!id)return;

    // Danh mục hàng hóa (category) is chosen next — 1 bill = 1 customer + 1 category,
    // so the product catalog is not loaded until a category is resolved/picked
    // (see loadCustomerCategorySelection — Customer Price Category Case 0/1/2/3).
    const pickedCustomer=customers.find(c=>String(c.id)===String(id));
    openShipDateModalForCustomer(pickedCustomer);
    await loadCustomerCategorySelection(id);
  };

  // PRODUCTION HOTFIX — POS Excel Import candidate pool. `items` (the POS
  // grid, loaded below) is intentionally scoped to what this customer
  // already has cataloged/priced — correct for manual entry, but it silently
  // hid real, active, correctly-classified products from Excel-import name
  // matching whenever a customer simply hadn't been individually cataloged/
  // priced for that product yet (confirmed live: BO0026 "Tủy"). This loads a
  // SEPARATE, independent candidate list — every active product in the same
  // category matching the customer's resolved sales_flow — from the new
  // /catalog/import-candidates endpoint (server-side reuses the exact same
  // cross-flow isolation guard customerCatalogForOrder() already enforces,
  // not a re-implementation of it). Does not touch `items`/the POS grid at
  // all. Best-effort: a failure here degrades matchImportedRows() back to
  // whatever `items` already has (see previewImport/updateImportRow below),
  // it must never block the POS grid itself from loading.
  const loadImportCandidates=async(id,categoryId)=>{
    if(!id||!categoryId){setImportCandidates([]);return;}
    try{
      const rows=(await api.get('/price-matrix/'+id+'/catalog/import-candidates',{params:{category_id:categoryId,sales_flow:flowForCustomerId(id)}})).data;
      setImportCandidates(rows||[]);
    }catch(e){
      setImportCandidates([]);
    }
  };

  const loadCategoryCatalog=async(id,categoryId)=>{
    if(!id||!categoryId){setItems([]);setImportCandidates([]);return;}
    setCatalogLoading(true);
    try{
      const pickedCustomer=customers.find(c=>String(c.id)===String(id));
      const pickedCalendarType=String(pickedCustomer?.billing_calendar_type||'SOLAR').toUpperCase()==='LUNAR'?'LUNAR':'SOLAR';
      const pickedLunarText=pickedCalendarType==='LUNAR'?formatLunarDate(orderDate||today).replace(/^ÂL\s*/,''):'';
      const r=(await api.get('/price-matrix/'+id+'/catalog/order',{params:{category_id:categoryId,order_date:orderDate||today,sales_flow:flowForCustomerId(id),lunar_date_text:pickedLunarText}})).data;
      const mapped=(r.products||[]).map((p,idx)=>({
        ...p,
        quantity_expr:'',
        quantity:0,
        sale_price:p.sale_price,
        selected:false,
        sort_order:p.sort_order||idx+1
      }));
      const catalog=await applyEffectivePrices(mapped,{customer_id:id,calendar_type:pickedCalendarType,order_date:orderDate,lunar_date_text:pickedCalendarType==='LUNAR'?pickedLunarText:''});
      setItems(catalog);
      setNoPrivatePrice(!!r.no_private_prices);
      setPendingFocusQty(true);
      loadImportCandidates(id,categoryId);
    }finally{
      setCatalogLoading(false);
    }
  };

  // S4.3: Customer Price Category resolution — POS Case 0/1/2/3.
  // Case 0 (0 categories): needs_initialization, guided init prompt required.
  // Case 1 (1 category) / Case 2 (2+ with a default): auto_selected_category_id is set.
  // Case 3 (2+, no default): requires_selection, chooser stays open.
  const refreshCategoryList=async(id)=>{
    const sel=(await api.get('/price-matrix/'+id+'/categories',{params:{sales_flow:flowForCustomerId(id)}})).data;
    setCategorySelection(sel);
    return sel;
  };

  const loadCustomerCategorySelection=async(id)=>{
    if(!id){
      setCategorySelection({categories:[],auto_selected_category_id:null,requires_selection:false,needs_initialization:false});
      setCategoryChooserOpen(false);
      return;
    }
    const sel=await refreshCategoryList(id);
    setAddCategoryPickerId('');
    if(sel.auto_selected_category_id){
      setCategoryChooserOpen(false);
      setSelectedCategoryId(String(sel.auto_selected_category_id));
      await loadCategoryCatalog(id,sel.auto_selected_category_id);
    }else{
      setSelectedCategoryId('');
      setItems([]);
        setNoPrivatePrice(false);
      setCategoryChooserOpen(true);
    }
  };

  const pickExistingCategory=async(categoryId)=>{
    if(!cid||!categoryId)return;
    const catId=String(categoryId);
    if(selected.length && catId!==String(selectedCategoryId)){
      const ok=await window.appConfirm('Bill hiện tại đang có số lượng. Đổi danh mục hàng hóa sẽ xóa bill đang nhập. Tiếp tục?',{title:'Đổi danh mục hàng hóa',confirmText:'Tiếp tục',variant:'warning'});
      if(!ok)return;
    }
    setSelectedCategoryId(catId);
    setCategoryChooserOpen(false);
    await loadCategoryCatalog(cid,catId);
  };

  // Guided init (Case 0) and "add another category" (customer already has categories but
  // wants one not yet assigned) share this single explicit-confirm entry point — a
  // CustomerPriceCategory is never created silently.
  const confirmAddCategory=async()=>{
    if(!cid||!addCategoryPickerId)return showWarning('Chọn danh mục hàng hóa cần thêm');
    const catName=categories.find(c=>String(c.id)===String(addCategoryPickerId))?.name||'';
    const ok=await window.appConfirm(`Xác nhận thêm danh mục "${catName}" cho khách hàng này?`,{title:'Thêm danh mục giá',confirmText:'Xác nhận',variant:'info'});
    if(!ok)return;
    setAddCategoryBusy(true);
    try{
      const newCategoryId=addCategoryPickerId;
      await api.post('/price-matrix/'+cid+'/categories',{category_id:newCategoryId,sales_flow:primaryFlow});
      await refreshCategoryList(cid);
      setAddCategoryPickerId('');
      setCategoryChooserOpen(false);
      setSelectedCategoryId(String(newCategoryId));
      await loadCategoryCatalog(cid,newCategoryId);
    }catch(e){
      showError(e.response?.data?.message||e.message||'Không thể thêm danh mục');
    }finally{
      setAddCategoryBusy(false);
    }
  };

  // ── Unified Sales V1: browse the OTHER sales flow's catalog and add products
  // into the SAME bill. The backend already supports one bill spanning both
  // flows (assertItemsCategoryPerFlow allows at most one Customer Price Category
  // per flow) — this is the UI for that, deliberately a simple bolt-on rather
  // than a second full POS screen. Price/stock/sales_flow are still entirely
  // resolved server-side; this panel only reuses the same catalog/price-category
  // endpoints CreateOrder already calls for the primary flow. ────────────────
  const refreshOtherFlowCategoryList=async(id,flow)=>{
    const sel=(await api.get('/price-matrix/'+id+'/categories',{params:{sales_flow:flow}})).data;
    setOtherFlowCategorySelection(sel);
    return sel;
  };

  const loadOtherFlowCatalog=async(id,categoryId,flow)=>{
    if(!id||!categoryId){setOtherFlowItems([]);return;}
    setOtherFlowCatalogLoading(true);
    try{
      const pickedCustomer=customers.find(c=>String(c.id)===String(id));
      const pickedCalendarType=String(pickedCustomer?.billing_calendar_type||'SOLAR').toUpperCase()==='LUNAR'?'LUNAR':'SOLAR';
      const pickedLunarText=pickedCalendarType==='LUNAR'?formatLunarDate(orderDate||today).replace(/^ÂL\s*/,''):'';
      const r=(await api.get('/price-matrix/'+id+'/catalog/order',{params:{category_id:categoryId,order_date:orderDate||today,sales_flow:flow,lunar_date_text:pickedLunarText}})).data;
      const mapped=(r.products||[]).map((p,idx)=>({...p,quantity_expr:'',quantity:0,sort_order:p.sort_order||idx+1}));
      setOtherFlowItems(await applyEffectivePrices(mapped,{customer_id:id,calendar_type:pickedCalendarType,order_date:orderDate,lunar_date_text:pickedCalendarType==='LUNAR'?pickedLunarText:''}));
    }finally{
      setOtherFlowCatalogLoading(false);
    }
  };

  const openOtherFlowBrowser=async()=>{
    if(!cid)return showWarning('Chọn khách hàng trước');
    if(!selectedCategoryId)return showWarning('Chọn danh mục hàng hóa trước');
    setOtherFlowFilter('');
    setOtherFlowOpen(true);
    const flow=otherFlow;
    const sel=await refreshOtherFlowCategoryList(cid,flow);
    setOtherFlowAddCategoryPickerId('');
    if(sel.auto_selected_category_id){
      setOtherFlowSelectedCategoryId(String(sel.auto_selected_category_id));
      await loadOtherFlowCatalog(cid,sel.auto_selected_category_id,flow);
    }else{
      setOtherFlowSelectedCategoryId('');
      setOtherFlowItems([]);
    }
  };

  const pickOtherFlowCategory=async(categoryId)=>{
    setOtherFlowSelectedCategoryId(String(categoryId));
    await loadOtherFlowCatalog(cid,categoryId,otherFlow);
  };

  const confirmAddOtherFlowCategory=async()=>{
    if(!cid||!otherFlowAddCategoryPickerId)return showWarning('Chọn danh mục hàng hóa cần thêm');
    const catName=categories.find(c=>String(c.id)===String(otherFlowAddCategoryPickerId))?.name||'';
    const ok=await window.appConfirm(`Xác nhận thêm danh mục "${catName}" cho khách hàng này (${flowLabel(otherFlow)})?`,{title:'Thêm danh mục giá',confirmText:'Xác nhận',variant:'info'});
    if(!ok)return;
    setOtherFlowAddCategoryBusy(true);
    try{
      const newCategoryId=otherFlowAddCategoryPickerId;
      await api.post('/price-matrix/'+cid+'/categories',{category_id:newCategoryId,sales_flow:otherFlow});
      await refreshOtherFlowCategoryList(cid,otherFlow);
      setOtherFlowAddCategoryPickerId('');
      setOtherFlowSelectedCategoryId(String(newCategoryId));
      await loadOtherFlowCatalog(cid,newCategoryId,otherFlow);
    }catch(e){
      showError(e.response?.data?.message||e.message||'Không thể thêm danh mục');
    }finally{
      setOtherFlowAddCategoryBusy(false);
    }
  };

  const updateOtherFlowQty=(productId,value)=>{
    setOtherFlowItems(prev=>prev.map(x=>{
      if(x.product_id!==productId)return x;
      const qty=calcQtyExpression(value)||0;
      return {...x,quantity_expr:value,quantity:qty};
    }));
  };

  const otherFlowUnassignedCategories=useMemo(()=>{
    const assigned=new Set((otherFlowCategorySelection.categories||[]).map(c=>String(c.category_id)));
    return categories.filter(c=>!assigned.has(String(c.id)));
  },[categories,otherFlowCategorySelection]);

  const otherFlowShown=useMemo(()=>{
    const q=otherFlowFilter.trim().toLowerCase();
    if(!q)return otherFlowItems;
    return otherFlowItems.filter(x=>String(x.product_name||'').toLowerCase().includes(q)||String(x.product_code||'').toLowerCase().includes(q));
  },[otherFlowItems,otherFlowFilter]);

  const addOtherFlowSelectionToBill=()=>{
    const picked=otherFlowItems.filter(i=>Number(i.quantity)>0);
    if(!picked.length)return showWarning('Nhập số lượng ít nhất 1 mặt hàng');
    setItems(prev=>{
      const next=[...prev];
      for(const p of picked){
        const idx=next.findIndex(x=>String(x.product_id)===String(p.product_id));
        if(idx>=0){
          const newQty=roundQty(Number(next[idx].quantity||0)+Number(p.quantity||0));
          next[idx]={...next[idx],quantity:newQty,quantity_expr:String(newQty),selected:true};
        }else{
          next.push({...p,selected:true,_extraFlow:true});
        }
      }
      return next;
    });
    setOtherFlowItems(prev=>prev.map(x=>({...x,quantity_expr:'',quantity:0})));
    setOtherFlowOpen(false);
    showSuccess(`Đã thêm ${picked.length} mặt hàng ${flowLabel(otherFlow)} vào bill`);
    setPendingFocusQty(true);
  };

  // Patch 02 — Add Product dialog keyboard support. New behavior (the old inline
  // panel had no keyboard nav beyond native tab order): Enter/double-click "add"
  // a row by routing through the exact same updateOtherFlowQty() path typing
  // already uses — never a separate quantity-setting code path — and only when
  // the row has no quantity yet, so a manually-typed value is never clobbered.
  const addOrSelectOtherFlowRow=(productId)=>{
    const row=otherFlowItems.find(x=>x.product_id===productId);
    if(row&&Number(row.quantity||0)<=0)updateOtherFlowQty(productId,'1');
  };

  const focusOtherFlowRow=(productId)=>{
    const el=otherFlowQtyRefs.current[productId];
    if(el){el.focus();el.select?.();}
  };

  const handleOtherFlowRowKeyDown=(e,productId)=>{
    if(e.key==='Enter'){
      e.preventDefault();
      addOrSelectOtherFlowRow(productId);
      const idx=otherFlowShown.findIndex(x=>x.product_id===productId);
      const next=otherFlowShown[idx+1];
      if(next)focusOtherFlowRow(next.product_id);
    }else if(e.key==='ArrowDown'){
      e.preventDefault();
      const idx=otherFlowShown.findIndex(x=>x.product_id===productId);
      const next=otherFlowShown[idx+1];
      if(next)focusOtherFlowRow(next.product_id);
    }else if(e.key==='ArrowUp'){
      e.preventDefault();
      const idx=otherFlowShown.findIndex(x=>x.product_id===productId);
      const prev=otherFlowShown[idx-1];
      if(prev)focusOtherFlowRow(prev.product_id);
    }
  };

  const update=(idx,patch)=>{
    if(idx<0)return;
    setItems(prev=>prev.map((x,i)=>i===idx?{...x,...patch}:x));
  };

  const updateQtyExpr=(idx,expr)=>{
    const qty=calcQtyExpression(expr);
    update(idx,{quantity_expr:expr,quantity:qty,selected:qty>0});
  };

  const updatePrice=(idx,priceStr)=>{
    const price=Number(String(priceStr||'').replace(/[^0-9]/g,''))||0;
    update(idx,{sale_price:price,manual_price:true});
  };

  const clearRow=(idx)=>{
    update(idx,{quantity_expr:'',quantity:0,quantity_note:'',selected:false});
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

  useEffect(()=>{
    if(!pendingFocusCustomer)return;
    const t=setTimeout(()=>{
      customerAutocompleteRef.current?.focus();
      setPendingFocusCustomer(false);
    },80);
    return()=>clearTimeout(t);
  },[pendingFocusCustomer]);

  useEffect(()=>{
    if(!pendingFocusQuickName||!quickOpen)return;
    const raf=requestAnimationFrame(()=>{
      quickAddSectionRef.current?.scrollIntoView?.({block:'nearest'});
      quickNameInputRef.current?.focus();
      quickNameInputRef.current?.select?.();
      setPendingFocusQuickName(false);
    });
    return()=>cancelAnimationFrame(raf);
  },[pendingFocusQuickName,quickOpen]);

  useEffect(()=>{
    if(!pendingFocusTools||!toolsOpen)return;
    const raf=requestAnimationFrame(()=>{
      toolsFirstInputRef.current?.scrollIntoView?.({block:'nearest'});
      toolsFirstInputRef.current?.focus();
      setPendingFocusTools(false);
    });
    return()=>cancelAnimationFrame(raf);
  },[pendingFocusTools,toolsOpen]);

  // Keyboard-only flow: Customer -> (ship-date modal, already autoFocus) -> Category -> Quantity.
  // Once the ship-date modal closes and a category still needs to be picked (Case 0/3), move
  // focus straight to the category select so Enter/arrow keys can complete the bill with no mouse.
  useEffect(()=>{
    if(shipDateModalOpen||!currentCustomer||!categoryChooserOpen)return;
    const t=setTimeout(()=>{categorySelectRef.current?.focus();},100);
    return()=>clearTimeout(t);
  },[shipDateModalOpen,currentCustomer,categoryChooserOpen]);

  const selected=items
    .map(i=>({...i,quantity:calcQtyExpression(i.quantity_expr)||Number(i.quantity||0)}))
    .filter(i=>i.selected&&Number(i.quantity)>0);

  const total=selected.reduce((s,i)=>s+Number(i.quantity||0)*Number(i.sale_price||0),0);
  const totalQty=selected.reduce((s,i)=>s+Number(i.quantity||0),0);

  const activeBookEffectiveFrom=useMemo(()=>{
    const dates=items.filter(i=>i.price_type==='PRICE_BOOK'&&i.effective_from).map(i=>String(i.effective_from).slice(0,10));
    if(!dates.length)return null;
    return dates.reduce((max,d)=>d>max?d:max);
  },[items]);


  const changeOrderDate=(v)=>{
    const next=String(v||today).slice(0,10);
    if(isFutureIsoDate(next)){
      showWarning('Không thể chọn ngày xuất hàng lớn hơn ngày hiện tại.');
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
    if(!cid)return showWarning('Chọn khách hàng');
    if(!selectedCategoryId)return showWarning('Chọn danh mục hàng hóa');
    const checkedDate=validateShippingDate(billCalendarType,orderDate,billLunarDateText);
    if(!checkedDate.ok)return;
    if(checkedDate.solarDate&&checkedDate.solarDate!==orderDate)setOrderDate(checkedDate.solarDate);
    if(!selected.length)return showWarning('Nhập số lượng ít nhất 1 mặt hàng');

    // FEAT (same-day bill warning): one bounded backend check. Advisory
    // only — never blocks (a failed check falls through to normal create
    // rather than trap the user; two sessions racing this same check is
    // expected/allowed, see OrderAgent.existingForDate()). window.appConfirm
    // blocks this same save() call until answered, so "Vẫn tạo bill" simply
    // lets execution continue straight into the one POST /orders below —
    // no second create path, no re-submit, no extra dialog state.
    {
      const checkDate=checkedDate.solarDate||orderDate;
      try{
        const dup=(await api.get('/orders/existing-for-date',{params:{customer_id:cid,date:checkDate}})).data;
        if(dup?.count>0){
          const dateLabel=sameDayBillDateLabel(checkDate,billCalendarType,billLunarDateText);
          const ok=await window.appConfirm(
            `Khách hàng này đã có ${dup.count} bill trong ngày ${dateLabel}.\n\nBạn có muốn tiếp tục tạo thêm bill mới không?`,
            {title:'Đã có bill trong ngày',confirmText:'Vẫn tạo bill',cancelText:'Hủy',variant:'warning'}
          );
          if(!ok)return;
        }
      }catch(e){ /* advisory only — never block bill creation on a failed check */ }
    }

    // Non-blocking nudge only — row highlight + inline warning already show live in
    // POSProductTableAgent as the cashier types. Save is NEVER blocked here;
    // InventoryService/postOut() remains the sole authority on whether a sale is
    // actually allowed.
    const overStockItem=selected.find(i=>isOverStock(i.inventory_mode,i.allow_negative_stock,i.stock_quantity,i.quantity));
    if(overStockItem)qtyRefs.current[overStockItem.product_id]?.focus();

    const needManualPrice=walkInCustomer||noPrivatePrice;
    const wasNoPrivatePrice=noPrivatePrice;
    const payloadItems=selected.map(i=>({
      product_id:i.product_id,
      product_name:i.product_name,
      unit:i.unit||'kg',
      quantity:Number(i.quantity||0),
      sale_price:Number(i.sale_price||0),
      price_type:i.price_type||'MANUAL_PRICE',
      price_book_id:i.price_book_id||null,
      note:i.quantity_expr&&i.quantity_expr!==String(i.quantity)?`SL nhập: ${i.quantity_expr}`:'',
      line_no:i.line_no||null,
      ...(needManualPrice?{manual_price:true}:{})
    }));

    let actualPaid=Number(cashAmount||0)+Number(bankAmount||0);

    if(walkInCustomer && actualPaid<Number(total||0)){
      showWarning('Khách vãng lai phải thu đủ tiền ngay tại POS trước khi lưu bill.');
      return;
    }

    if(!walkInCustomer && actualPaid>0){
      showWarning('Khách hàng thường chỉ tạo bill công nợ tại POS. Vui lòng thu tiền ở màn Thu tiền.');
      return;
    }

    setSaving(true);
    try{
      // S6.5: lazily mint the key for THIS bill-save attempt — reused verbatim if
      // this exact call is retried (double-click before setSaving(true) re-renders
      // the disabled button, or a network-level retry of the same request).
      if(!billIdempotencyKeyRef.current){
        billIdempotencyKeyRef.current=(crypto.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random().toString(36).slice(2)}`);
      }
      const r=await api.post('/orders',{
        customer_id:cid,
        order_date:checkedDate.solarDate||orderDate,
        calendar_type:billCalendarType,
        lunar_date_text:billCalendarType==='LUNAR'?billLunarDateText:'',
        current_bill_amount:total,
        // FEAT (manual góp bill): send the operator's ACTUAL amount for this
        // bill, not the raw configured default — billInstallmentAmount starts
        // equal to monthlyInstallment and only diverges from it if the
        // operator explicitly edited the field (see effects above).
        // monthly_installment_id still points at the config the default was
        // resolved from, for traceability, even when the amount was overridden.
        monthly_installment_amount:billInstallmentAmount,
        installment_amount:billInstallmentAmount,
        monthly_installment_id:monthlyInstallmentId,
        paid_amount:0,
        items:payloadItems,
        idempotency_key:billIdempotencyKeyRef.current
      });

      // V65.47: Bill bán hàng không ghi tiền. Tiền mặt/chuyển khoản xử lý riêng ở menu Thu tiền.

      // This attempt succeeded — rotate the key so the NEXT bill (POS "keep going"
      // flow) gets a fresh one, instead of ever being mistaken for a replay of this one.
      billIdempotencyKeyRef.current=null;
      const code=r.data.order_code;
      setMsg(code);
      setSaveNotice(`Đã lưu ${code}. Đang giữ khách ${currentCustomer?.name||''}, có thể nhập bill tiếp theo ngay.`);
      await reloadCustomerCatalogClearQty(cid);
      setPaid(0);
      setCashAmount(0);
      setBankAmount(0);
      // FEAT (manual góp bill): this bill is done — the NEXT bill (same
      // customer, "keep going" flow above) must start from the configured
      // default again, not silently reuse this bill's manual override.
      installmentManuallyEditedRef.current=false;
      setBillInstallmentAmount(monthlyInstallment);
      if(excelBillQueue.length&&excelBillIndex>=0){
        await goNextExcelSheetAfterSave();
      }else{
        setImportText('');
        setImportPreview([]);
        setImportMsg('');
      }
      focusFirstQtyInput();
      if(wasNoPrivatePrice&&payloadItems.length){
        const savedCid=cid;
        const yes=await window.appConfirm(
          'Khách hàng này chưa có bảng giá riêng.\nBạn có muốn sử dụng các mức giá vừa nhập để tạo bảng giá riêng cho khách hàng này không?',
          {title:'Tạo bảng giá riêng',confirmText:'Có, tạo ngay',cancelText:'Không',variant:'info'}
        );
        if(yes){
          try{
            await api.put('/price-matrix/'+savedCid,{
              items:payloadItems.map(i=>({product_id:i.product_id,in_catalog:1,sort_order:0,private_price:i.sale_price})),
              effective_calendar_type:billCalendarType,
              effective_from:checkedDate.solarDate||orderDate,
              effective_lunar_date_text:billCalendarType==='LUNAR'?billLunarDateText:''
            });
            setNoPrivatePrice(false);
            showSuccess('Đã tạo bảng giá riêng cho khách hàng.');
          }catch(_){}
        }
      }
    }catch(e){
      const data=e.response?.data||{};
      let message=data.message||e.message||'Không thể lưu bill';
      if(data.code==='PRICE_NOT_FOUND' && data.details?.items?.length){
        message='Không thể lưu bill. Khách hàng chưa có giá cho: '+data.details.items.map(x=>x.product_name||('ID '+x.product_id)).join(', ')+'. Vui lòng cập nhật bảng giá riêng trước.';
      }
      // `error` feeds SafePage's error prop, which replaces this entire POS screen with a
      // full-page "Lỗi màn hình" box AND fires its own showError toast (SafePage.jsx) — using
      // it here for a single save failure was a double-notification bug that also wiped the
      // in-progress bill from view. A single toast is enough; the form must stay open.
      showError(message);
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

  // Thêm nhanh mặt hàng luôn dùng đúng danh mục hàng hóa đang chọn cho bill này.
  useEffect(()=>{
    if(quickOpen&&selectedCategoryId)loadNextCode(selectedCategoryId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[quickOpen,selectedCategoryId]);

  const addQuickProduct=async()=>{
    if(!cid)return showWarning('Chọn khách trước');
    if(!selectedCategoryId)return showWarning('Chọn danh mục hàng hóa trước');
    if(!quick.name)return showWarning('Nhập tên mặt hàng');

    try{
      // Quick Add always creates a product for the bill's currently-selected
      // (primary) category/flow — inventory_mode is derived from that flow, never
      // user-picked, since CARCASS_POS/INVENTORY_SALE each pair with exactly one
      // valid inventory_mode (see productSalesFlow.js's compatibility matrix).
      const quickInventoryMode=primaryFlow==='INVENTORY_SALE'?'TRACK_STOCK':'NON_STOCK';
      const r=await api.post('/products/quick',{
        ...quick,
        inventory_mode:quickInventoryMode,
        allow_negative_stock:primaryFlow==='INVENTORY_SALE'?0:1,
        sales_flow:primaryFlow,
        category_id:selectedCategoryId,
        customer_id:cid
      });

      showSuccess(r.data.message+' - '+r.data.product_code);
      setQuick(q=>({
        unit:q.unit||'kg',
        category_id:q.category_id
      }));
      if(selectedCategoryId)loadNextCode(selectedCategoryId);
      setPendingFocusQuickName(true);
      await reloadCustomerCatalogKeepQty(cid);
    }catch(e){
      const backendMsg=e.response?.data?.message||e.message||'';
      // Quick Add must survive a duplicate-name rejection: keep the panel open, keep what
      // the user typed (quick state is untouched here), and refocus the name field so they
      // can correct it immediately instead of losing their place.
      showWarning(/đã tồn tại/i.test(backendMsg)
        ? `Mặt hàng '${quick.name}' đã tồn tại.`
        : (backendMsg||'Không thể thêm mặt hàng nhanh')
      );
      setPendingFocusQuickName(true);
    }
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
    if(!cid)return showWarning('Chọn khách');
    await api.put('/price-matrix/'+cid+'/catalog/reorder',{
      items:items.map((x,i)=>({product_id:x.product_id,sort_order:i+1}))
    });
    showSuccess('Đã lưu thứ tự danh mục khách');
    await reloadCustomerCatalogKeepQty(cid);
  };

  const applyVoiceCommand=(text)=>{
    if(!cid){
      setVoiceMsg('Chọn khách hàng trước khi nhập giọng nói');
      return;
    }
    if(!selectedCategoryId){
      setVoiceMsg('Chọn danh mục hàng hóa trước khi nhập giọng nói');
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
        update(idx,{quantity_expr:'',quantity:0,quantity_note:'',selected:false});
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
    const newQty=roundQty(oldQty+Number(result.quantity||0));
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
    // The rendered Import dialog's file inputs are excelImportDialogExcelFileRef/
    // excelImportDialogImageFileRef (see the Dialog JSX below) — importExcelFileRef/
    // importImageFileRef are legacy refs no longer attached to any mounted
    // element, kept only so nothing else referencing them breaks.
    if(importExcelFileRef.current)importExcelFileRef.current.value='';
    if(importImageFileRef.current)importImageFileRef.current.value='';
    if(excelImportDialogExcelFileRef.current)excelImportDialogExcelFileRef.current.value='';
    if(excelImportDialogImageFileRef.current)excelImportDialogImageFileRef.current.value='';
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
      if(!solar){showWarning('Ngày âm lịch trong Excel không hợp lệ: '+bill.date.ddmmyyyy);return '';}
      if(isFutureIsoDate(solar)){showWarning('Không thể import bill có ngày xuất hàng lớn hơn ngày hiện tại: '+bill.date.ddmmyyyy+' Âm lịch');return '';}
      setBillCalendarType('LUNAR');
      setBillLunarDateText(bill.date.ddmmyyyy);
      setOrderDate(solar);
      setTimeout(()=>refreshCurrentItemPrices({calendar_type:'LUNAR',order_date:solar,lunar_date_text:bill.date.ddmmyyyy}),0);
      return `${bill.date.ddmmyyyy} Âm lịch`;
    }
    const solar=String(bill.date.iso||'').slice(0,10);
    if(solar&&isFutureIsoDate(solar)){showWarning('Không thể import bill có ngày xuất hàng lớn hơn ngày hiện tại: '+bill.date.ddmmyyyy+' Dương lịch');return '';}
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
    setItems(prev=>prev.map(x=>({...x,quantity_expr:'',quantity:0,quantity_note:'',selected:false})));
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
    resetImportSession();
    setCid('');
    setSelectedCategoryId('');
    setCategorySelection({categories:[],auto_selected_category_id:null,requires_selection:false,needs_initialization:false});
    setCategoryChooserOpen(false);
    setAddCategoryPickerId('');
    setItems([]);
    setFilter('');
    setMsg('');
    setSaveNotice('');
    setNoPrivatePrice(false);
    setPaid(0);
    setCashAmount(0);
    setBankAmount(0);
    setPendingFocusCustomer(true);
  };

  // PRODUCTION HOTFIX: matching now targets importCandidates (every active
  // product in the category/sales_flow, independent of this customer's own
  // catalog membership) instead of `items` (the customer-catalog-scoped POS
  // grid) — see loadImportCandidates(). Falls back to `items` only if
  // importCandidates hasn't loaded/failed to load, so a transient load
  // failure degrades to the old (pre-fix) behavior rather than matching
  // nothing at all. The matching algorithm itself (findExactProductCandidates
  // / scoreProduct in orderImportParser.js) is completely unchanged.
  const previewImport=(sourceType='text')=>{
    if(!cid)return showWarning('Chọn khách trước');
    if(!selectedCategoryId)return showWarning('Chọn danh mục hàng hóa trước');
    const candidates=importCandidates.length?importCandidates:items;
    const rows=parseOrderText(importText,sourceType);
    const matched=matchImportedRows(rows,candidates);
    setImportPreview(matched);
    setImportMsg(`Đọc được ${rows.length} dòng, khớp chắc chắn ${matched.filter(x=>x.ok).length} dòng, lỗi ${matched.filter(x=>x.errors?.length).length} dòng`);
  };

  const updateImportRow=(idx,patch)=>{
    const candidates=importCandidates.length?importCandidates:items;
    setImportPreview(prev=>prev.map((r,i)=>{
      if(i!==idx)return r;
      const updated={...r,...patch};
      const qty=calcQtyExpression(updated.qtyExpr);
      return rematchOne({...updated,qty,sourceType:'manual',errors:[],warnings:[]},candidates);
    }));
  };

  const applyImport=async()=>{
    // Double-click / repeat-click guard: while a previous call is still
    // processing (e.g. awaiting the warning-confirmation dialog below),
    // ignore further clicks entirely rather than starting a second apply.
    if(importApplying)return;
    if(!importPreview.length)return;
    const rowsToApply=importPreview.filter(x=>x.selected&&x.canApply);
    if(!rowsToApply.length){
      // No valid row selected: dialog stays open, existing validation
      // message shown, bill unchanged — nothing else to do.
      showWarning('Không có dòng hợp lệ được chọn');
      return;
    }

    setImportApplying(true);
    try{
      const warnRows=rowsToApply.filter(x=>x.warnings&&x.warnings.length);
      if(warnRows.length){
        const ok=await window.appConfirm('Có dòng import cảnh báo. Bạn đã kiểm tra kỹ chưa?',{title:'Xác nhận import',confirmText:'Đã kiểm tra',variant:'warning'});
        if(!ok)return; // user declined: dialog stays open, nothing applied
      }

      // Gom theo product_id trước khi đưa vào bill (never by name — two rows
      // only ever merge when their resolved product_id is identical).
      // Tránh lỗi file Excel có 2 dòng cùng mặt hàng (ví dụ Rìa) bị ghi đè hoặc lệch dòng.
      const grouped=groupImportRowsByProduct(rowsToApply);

      let arr=[...items];
      let applied=0;
      let missing=0;
      // PRODUCTION HOTFIX (Bug 2): a row can be a confirmed exact match
      // (g.product set, resolved from importCandidates — every active
      // product in this category+sales_flow) while still being absent from
      // `items` (the customer-catalog-scoped POS grid) — that's precisely
      // the "matched but never cataloged/priced for this customer yet" case
      // the previous fix made matchable. Previously such a row was silently
      // counted as "missing" here and never reached the bill at all, even
      // though preview showed a real match (confirmed live: Tủy). Track
      // these separately so their price can be resolved once, in a single
      // batch, right after the loop — never trusted from Excel either way.
      const newlyAddedRows=[];
      for(const [key,g] of grouped.entries()){
        const idx=arr.findIndex(x=>getProductKey(x)===key);
        if(idx>=0){
          const oldQty=importApplyMode==='ADD'?Number(arr[idx].quantity||0):0;
          const newQty=roundQty(oldQty+Number(g.qty||0));
          // Preserve the original Excel/text expression(s) as a note distinct
          // from the input value itself (input shows the evaluated newQty;
          // the note below it may show "= 10+12") — never the other way round.
          const newNote=g.qtyExprs.join(' + ');
          const existingNote=importApplyMode==='ADD'
            ? (arr[idx].quantity_note || (oldQty>0 ? String(oldQty) : ''))
            : '';
          arr[idx]={...arr[idx],quantity:newQty,quantity_expr:String(newQty),quantity_note:existingNote?`${existingNote} + ${newNote}`:newNote,selected:newQty>0};
          applied+=g.count;
        }else if(g.product&&g.product.product_id){
          // Matched (product_id resolved) but not yet a bill line — add it as
          // a NEW row instead of dropping it. This does NOT add the product
          // to the customer's own catalog; "Thêm vào DM khách" stays a
          // separate, explicit action for that.
          const qty=roundQty(Number(g.qty||0));
          const newRow={
            product_id:g.product.product_id,
            product_code:g.product.product_code,
            product_name:g.product.product_name,
            unit:g.product.unit||'kg',
            stock_quantity:g.product.stock_quantity,
            inventory_mode:g.product.inventory_mode,
            allow_negative_stock:g.product.allow_negative_stock,
            sale_price:0,
            price_type:'MANUAL_PRICE',
            price_book_id:null,
            quantity:qty,
            quantity_expr:String(qty),
            quantity_note:g.qtyExprs.join(' + '),
            selected:qty>0,
            sort_order:arr.length+1
          };
          arr.push(newRow);
          newlyAddedRows.push(newRow);
          applied+=g.count;
        }else{
          missing+=g.count;
        }
      }
      if(newlyAddedRows.length){
        // Same price-resolution call loadCategoryCatalog()/refreshCurrentItemPrices()
        // already use for every other catalog row — server-side authority,
        // never the Excel value. A product with no resolvable price yet
        // (e.g. no price book entry at all) simply keeps sale_price:0 here,
        // same as the existing manual-price/no-private-price flow already
        // handles elsewhere; final save() re-resolves it again regardless.
        const pickedCustomer=customers.find(c=>String(c.id)===String(cid));
        const pickedCalendarType=String(pickedCustomer?.billing_calendar_type||'SOLAR').toUpperCase()==='LUNAR'?'LUNAR':'SOLAR';
        const priced=await applyEffectivePrices(newlyAddedRows,{customer_id:cid,calendar_type:pickedCalendarType,order_date:orderDate,lunar_date_text:pickedCalendarType==='LUNAR'?billLunarDateText:''});
        arr=arr.map(x=>{
          const hit=priced.find(p=>String(p.product_id)===String(x.product_id));
          return hit?{...x,sale_price:hit.sale_price,price_type:hit.price_type,price_book_id:hit.price_book_id,effective_from:hit.effective_from}:x;
        });
      }
      setItems(arr);
      const duplicateCount=rowsToApply.length-grouped.size;
      const successMsg=`Đã đưa ${applied} dòng đã chọn vào bill (${grouped.size} mặt hàng${duplicateCount>0?', đã gộp '+duplicateCount+' dòng trùng':''}, ${importApplyMode==='ADD'?'cộng thêm':'ghi đè'}).${missing?` Có ${missing} dòng không tìm thấy trong database.`:''}`;

      if(excelBillQueue.length>0){
        // A multi-sheet Excel import is in progress (one bill per sheet).
        // That workflow is driven separately, from save() ->
        // goNextExcelSheetAfterSave(), AFTER this bill is actually saved —
        // not here. Keep the dialog open and the queue intact; only mark
        // these rows as consumed so re-clicking apply can't double-add them.
        setImportPreview(prev=>prev.map(x=>rowsToApply.includes(x)?{...x,selected:false,applied:true}:x));
        setImportMsg(successMsg);
      }else{
        // Single-sheet / pasted-text / OCR import: bill state has been
        // updated and there is no further sheet queued — reset the
        // temporary import/dialog state and close automatically. Order
        // matters — the preview rows are only cleared AFTER arr/items has
        // already consumed them above, never before.
        resetImportSession();
        resetImportFileInputs();
        setImportApplyMode('REPLACE');
        setExcelImportDialogOpen(false);
        setToolsOpen(false);
        setPendingFocusQty(true);
        showSuccess(successMsg);
      }
    }catch(e){
      // Processing failure: dialog stays open, nothing partially applied
      // (setItems above never ran), existing error handling surfaces it.
      showError(e?.response?.data?.message||e?.message||'Không thể đưa dòng đã chọn vào bill');
    }finally{
      setImportApplying(false);
    }
  };

  const readExcelFile=async(file)=>{
    if(!file)return;
    if(!cid){
      resetImportFileInputs();
      return showWarning('Chọn khách trước khi import Excel');
    }
    if(!selectedCategoryId){
      resetImportFileInputs();
      return showWarning('Chọn danh mục hàng hóa trước khi import Excel');
    }
    const readSeq=importReadSeqRef.current+1;
    importReadSeqRef.current=readSeq;
    resetImportSession();
    setItems(prev=>prev.map(x=>({...x,quantity:0,quantity_expr:'',quantity_note:'',selected:false})));
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
          // Raw Excel numeric cells can themselves carry IEEE754 storage
          // artifacts (e.g. a formula-computed cell cached as
          // 51.99999999999999) — round once here, at the point the value
          // enters the preview-row model, so qty/qtyExpr are always clean
          // downstream (preview input, "= " note, and the add-to-bill
          // payload all read from this same already-rounded value).
          const cleanQty=roundQty(Number(qtyText));
          rows.push({
            name,
            qtyExpr:String(cleanQty),
            rawQuantityText:qtyText,
            qty:cleanQty,
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

      // PRODUCTION HOTFIX: match against importCandidates (every active
      // product in the category/sales_flow, independent of this customer's
      // own catalog membership), same as previewImport()/updateImportRow()
      // above — see loadImportCandidates(). Same fallback-to-items safety.
      const matchCandidates=importCandidates.length?importCandidates:items;
      const sheetResults=sheetPick.names.map(parseSheetRows);
      const noDateSheets=sheetResults.filter(x=>x.rows&&x.rows.length&&!x.date);
      const billQueue=sheetResults
        .filter(x=>x.rows&&x.rows.length&&x.date)
        .map(x=>({
          sheetName:x.sheetName||x.rows?.[0]?.sheetName||'',
          rows:x.rows,
          date:x.date,
          error:x.error||'',
          matched:matchImportedRows(x.rows,matchCandidates)
        }));
      const rejectedMsg=noDateSheets.map(x=>`Sheet "${x.sheetName}" chưa có ngày xuất hàng. Vui lòng bổ sung ngày trong Excel rồi import lại.`).join(' ');
      if(!billQueue.length){
        setImportMsg((rejectedMsg||'Không tìm thấy dòng hàng hợp lệ trong Excel. Kiểm tra lại cột Danh mục/Số lượng ở các sheet.'));
        return;
      }
      if(readSeq!==importReadSeqRef.current)return;
      const errText=sheetResults.filter(x=>x.error).map(x=>x.error).join(' ');
      setExcelBillQueue(billQueue);
      setExcelBillIndex(0);
      loadExcelBillToPreview(billQueue,0);
      setImportMsg(prev=>`${prev} Đã đọc ${sheetPick.names.length}/${wb.SheetNames.length} sheet${importSheetFilter?` theo chỉ định: ${sheetPick.names.join(', ')}`:''}. Có ${billQueue.length} sheet hợp lệ = ${billQueue.length} bill riêng.${rejectedMsg?' '+rejectedMsg:''} ${errText?' '+errText:''}`);
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

  const previewHandwriting=async()=>{
    if(!cid)return showWarning('Chọn khách trước');
    if(!selectedCategoryId)return showWarning('Chọn danh mục hàng hóa trước');
    // Only match against products in the selected category — never let handwriting OCR
    // pull a product from another category into this bill.
    const products=await ensureAllProductsLoaded();
    const categoryProducts=products.filter(p=>String(p.category_id)===String(selectedCategoryId));
    const rows=parseHandwritingText(importText,items,categoryProducts,ocrAliases);
    setImportPreview(rows);
    setImportMsg(`Viết tay: đọc ${rows.length} dòng, OK ${rows.filter(x=>x.status==='OK').length}, vàng ${rows.filter(x=>x.status==='WARN').length}, đỏ ${rows.filter(x=>x.status==='ERROR').length}`);
  };

  const addMissingToCatalog=async(row)=>{
    if(!cid||!row.product_id)return;
    await api.post('/price-matrix/'+cid+'/catalog',{product_id:row.product_id,sort_order:999});
    await api.post('/handwriting/aliases',{customer_id:cid,alias_text:row.name,product_id:row.product_id,source:'HANDWRITING'});
    showSuccess('Đã thêm vào danh mục khách và học alias');
    await reloadCustomerCatalogKeepQty(cid);
  };

  const toggleQuickAddPanel=()=>{
    if(quickOpen){
      setQuickOpen(false);
      return;
    }
    setToolsOpen(false);
    setQuickOpen(true);
    setPendingFocusQuickName(true);
  };

  const toggleToolsPanel=()=>{
    if(toolsOpen){
      setToolsOpen(false);
      return;
    }
    setQuickOpen(false);
    setToolsOpen(true);
    setPendingFocusTools(true);
  };

  return (
    <SafePage loading={loading} error={error}>
      <div className="pos-agent-shell pos-real-shell">
        <CalendarDialog
          open={shipDateModalOpen&&!!currentCustomer}
          calendarType={billCalendarType}
          title="Chọn ngày xuất hàng"
          subtitle={currentCustomer&&<>Khách <b>{currentCustomer.name}</b> tính bill theo <b>{billCalendarType==='LUNAR'?'Âm lịch':'Dương lịch'}</b>. Bảng giá riêng sẽ lấy theo ngày xuất hàng này.</>}
          inputLabel="Ngày xuất hàng"
          solarDate={orderDate||today}
          lunarDateText={billLunarDraftText||''}
          onSolarDateChange={changeOrderDate}
          onLunarDateTextChange={setBillLunarDraftText}
          maxSolarDate={today}
          onConfirm={applyShipDateModal}
          onCancel={()=>{setShipDateModalOpen(false);setShipDateDialogError('');}}
          confirmLabel="Áp dụng ngày xuất hàng"
          cancelLabel="Chọn sau"
          errorText={shipDateDialogError}
        />

        <div className="pos-page-header-row">
          <h2 className="pos-page-title">Tạo bill POS</h2>
          <div className="actions">
            <button type="button" className="btn" disabled={saving||!cid||!selectedCategoryId||!selected.length} onClick={save}>{saving?'Đang lưu...':'Lưu bill'}</button>
          </div>
        </div>

        {saveNotice&&<div className="ai-alert success pos-save-session-notice">✔ {saveNotice}</div>}

        <div className="pos-agent-layout pos-real-layout">
          <main className="pos-agent-main pos-real-main">
            <POSBillContextBar
              customers={customers}
              cid={cid}
              currentCustomer={currentCustomer}
              customerAutocompleteRef={customerAutocompleteRef}
              onChangeCustomer={id=>loadCustomerCatalog(id)}
              walkInCustomer={walkInCustomer}
              paymentPolicyText={paymentPolicyText}
              orderDate={orderDate}
              today={today}
              billCalendarType={billCalendarType}
              billLunarDateText={billLunarDateText}
              onOpenShipDateModal={openShipDateModalForCustomer}
              selectedCategoryId={selectedCategoryId}
              categories={categories}
              categorySelection={categorySelection}
              categoryChooserOpen={categoryChooserOpen}
              setCategoryChooserOpen={setCategoryChooserOpen}
              unassignedCategories={unassignedCategories}
              addCategoryPickerId={addCategoryPickerId}
              setAddCategoryPickerId={setAddCategoryPickerId}
              addCategoryBusy={addCategoryBusy}
              onPickExistingCategory={pickExistingCategory}
              onConfirmAddCategory={confirmAddCategory}
              noPrivatePrice={noPrivatePrice}
              catalogLoading={catalogLoading}
              activeBookEffectiveFrom={activeBookEffectiveFrom}
              categorySelectRef={categorySelectRef}
              onStartChangeCustomer={startChangeCustomer}
            />

            {selectedCategoryId ? (
              <POSProductTableAgent
                shown={shown}
                items={items}
                filter={filter}
                setFilter={setFilter}
                qtyRefs={qtyRefs}
                searchInputRef={searchInputRef}
                fastEntryFromSearchRef={fastEntryFromSearchRef}
                focusNext={focusNext}
                focusFirstFilteredItem={()=>focusFirstQtyInput(true)}
                onQtyCommitEnter={returnToSearchAfterQty}
                updateQtyExpr={updateQtyExpr}
                dragId={dragId}
                setDragId={setDragId}
                handleDrop={handleDrop}
                allowManualPrice={walkInCustomer||noPrivatePrice}
                updatePrice={updatePrice}
                priceRefs={priceRefs}
                onQuickAdd={toggleQuickAddPanel}
                onOpenTools={toggleToolsPanel}
                onClearRow={clearRow}
                quickOpen={quickOpen}
                toolsOpen={toolsOpen}
                onBrowseOtherFlow={openOtherFlowBrowser}
                otherFlowLabel={flowLabel(otherFlow)}
                onOpenImportDialog={()=>setExcelImportDialogOpen(true)}
              />
            ) : currentCustomer && (
              <div className="card">
                <p className="muted">Chọn danh mục hàng hóa ở trên để tải mặt hàng và bảng giá đúng danh mục.</p>
              </div>
            )}

            {/* Patch 04C — production cutover. This is now the sole copy of the
                Import Center (POSAdvancedTools's inline card and all its Import
                Center props were removed in this same patch). The
                "+ Import Excel/Ảnh/Viết tay" button (still in POSAdvancedTools,
                unchanged position/role) opens excelImportDialogOpen directly —
                no more importOpen toggle. importOpen itself is untouched and
                still exists: readExcelFile/loadExcelBillToPreview still set it
                exactly as before (neither function was modified, per mission),
                it simply has no UI left anywhere that reads it for visibility.
                File inputs keep their dedicated refs from Patch 04B
                (excelImportDialogExcelFileRef/excelImportDialogImageFileRef) —
                no longer required for File Input Safety now that only one copy
                exists, but left as-is since renaming was not requested and
                would be diff beyond "remove the obsolete presentation layer". */}
            <Dialog open={excelImportDialogOpen} title="Import" onClose={()=>setExcelImportDialogOpen(false)}>
                <h3>Import đơn từ Excel / hình ảnh</h3>
                <p className="muted">
                  File chỉ cần 2 cột: <b>Tên mặt hàng</b> và <b>Số lượng</b>.
                </p>
                <div className="actions">
                  <input className="input" style={{ maxWidth: 360 }} placeholder="Sheet cần đọc (trống = tất cả, nhiều sheet cách nhau dấu phẩy)" value={importSheetFilter} onChange={e => setImportSheetFilter(e.target.value)} />
                  <input ref={excelImportDialogExcelFileRef} type="file" accept=".xlsx,.xls,.csv" onClick={e => { e.currentTarget.value = ''; startFreshImportSession(); }} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; readExcelFile(file); }} />
                  <input ref={excelImportDialogImageFileRef} type="file" accept="image/*" onClick={e => { e.currentTarget.value = ''; startFreshImportSession(); }} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; readImageFile(file); }} />
                </div>
                <textarea className="input" style={{ minHeight: 120, marginTop: 10 }} placeholder={'Bò búp 10+12\nĐùi bò 5.5'} value={importText} onChange={e => setImportText(e.target.value)} />
                <div className="actions" style={{ marginTop: 10 }}>
                  <select className="select" style={{ width: 220 }} value={importApplyMode} onChange={e => setImportApplyMode(e.target.value)}>
                    <option value="REPLACE">Ghi đè số lượng trong bill</option>
                    <option value="ADD">Cộng thêm vào số lượng cũ</option>
                  </select>
                  <button className="btn secondary" onClick={() => previewImport('text')}>Xem trước import text/excel</button>
                  <button className="btn secondary" onClick={() => previewImport('image')}>Xem trước OCR ảnh</button>
                  <button className="btn secondary" onClick={previewHandwriting}>Xem ảnh viết tay</button>
                  <button className="btn" onClick={applyImport} disabled={!importPreview.length||importApplying}>{importApplying?'Đang xử lý...':'Đưa dòng đã chọn vào bill'}</button>
                  <button className="btn danger" onClick={clearCurrentBillQty}>Xóa SL bill hiện tại</button>
                </div>
                {importMsg && <p className="muted">{importMsg}</p>}

                {importPreview.length > 0 && (
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
                        {importPreview.map((r, idx) => (
                          <tr key={idx} style={{ background: r.status === 'ERROR' ? '#fee2e2' : (r.status === 'WARN' ? '#fef3c7' : '#dcfce7') }}>
                            <td>
                              <input type="checkbox" checked={!!r.selected} disabled={!r.canApply} onChange={e => updateImportRow(idx, { selected: e.target.checked })} />
                            </td>
                            <td><b>{r.name || r.raw || ''}</b><br /><span className="muted">{r.raw || ''}</span></td>
                            <td>{r.product ? <span>{r.product.product_code} - {r.product.product_name}</span> : <span className="muted">Chưa khớp danh mục</span>}</td>
                            <td>
                              <input inputMode="decimal" className="input" style={{ width: 120 }} value={r.qtyExpr || r.quantity_expr || r.qty || ''} onChange={e => updateImportRow(idx, { qtyExpr: e.target.value })} />
                            </td>
                            <td>
                              {r.errors?.length ? <span>🔴 {r.errors.join(', ')}</span> : r.warnings?.length ? <span>🟡 {r.warnings.join(', ')}</span> : <span>🟢 OK</span>}
                            </td>
                            <td>
                              {r.product_id && !r.inCustomerCatalog && (
                                <button className="btn secondary" onClick={() => addMissingToCatalog(r)}>
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
              </Dialog>

            {/* Patch 03 — Quick Add dialog. Reuses quickOpen as the single open/close
                flag (no separate dialog-only flag) so there is exactly one production
                entry point for this workflow — the existing "+ Thêm nhanh" toolbar
                button (onQuickAdd={toggleQuickAddPanel}) already sets quickOpen=true,
                unchanged. Content below is the same quick state/addQuickProduct/
                keyboard flow unchanged, only relocated out of the old inline card. */}
            <Dialog open={quickOpen} title="Thêm nhanh mặt hàng" onClose={()=>setQuickOpen(false)}>
              <div ref={quickAddSectionRef}>
                {!selectedCategoryId && <p className="muted">Chọn danh mục hàng hóa ở trên trước khi thêm nhanh mặt hàng.</p>}
                <div className="form-grid">
                  <input className="input" disabled value={categories.find(c=>String(c.id)===String(selectedCategoryId))?.name||'Chưa chọn danh mục'} />
                  <input className="input" placeholder="Mã tự sinh" value={quick.product_code||''} onChange={e=>setQuick({...quick,product_code:e.target.value})} />
                  <input
                    ref={quickNameInputRef}
                    className="input"
                    placeholder="Tên mặt hàng mới"
                    value={quick.name||''}
                    onChange={e=>setQuick({...quick,name:e.target.value})}
                    onKeyDown={e=>{
                      if(e.key==='Enter'){
                        e.preventDefault();
                        quickUnitInputRef.current?.focus();
                        quickUnitInputRef.current?.select?.();
                      }
                    }}
                  />
                  <input
                    ref={quickUnitInputRef}
                    inputMode="decimal"
                    className="input"
                    placeholder="Đơn vị"
                    value={quick.unit||'kg'}
                    onChange={e=>setQuick({...quick,unit:e.target.value})}
                    onKeyDown={e=>{
                      if(e.key==='Enter'){
                        e.preventDefault();
                        quickAddSaveBtnRef.current?.focus();
                      }
                    }}
                  />
                  <input className="input" disabled value={primaryFlow==='INVENTORY_SALE'?'Quản tồn kho (Hàng Kho)':'Bò xô không kiểm tồn'} />
                </div>
                <button ref={quickAddSaveBtnRef} className="btn secondary" style={{marginTop:10}} disabled={!selectedCategoryId} onClick={addQuickProduct}>
                  + Thêm vào danh mục khách
                </button>
              </div>
            </Dialog>

            {/* Patch 02 — Add Product dialog. Reuses otherFlowOpen as the single
                open/close flag (no separate dialog-only flag) so there is exactly
                one production entry point for this workflow. Content below is the
                same otherFlow* state/handlers unchanged, only relocated out of the
                old inline card into the Patch-01 Dialog shell, plus new keyboard
                wiring (ref/onKeyDown/onDoubleClick) on each row. */}
            <Dialog open={otherFlowOpen} title={`Thêm hàng ${flowLabel(otherFlow)}`} onClose={()=>setOtherFlowOpen(false)}>
              {otherFlowCategorySelection.needs_initialization && (
                <p className="notice">Khách hàng này chưa có danh mục giá {flowLabel(otherFlow)} nào. Chọn danh mục hàng hóa để bắt đầu.</p>
              )}
              {otherFlowCategorySelection.requires_selection && (
                <p className="notice">Khách hàng có nhiều danh mục giá {flowLabel(otherFlow)} và chưa đặt mặc định. Vui lòng chọn danh mục.</p>
              )}

              {otherFlowCategorySelection.categories.length>0 && (
                <div className="pos-bill-context-row">
                  <b>Chọn danh mục đã có:</b>
                  <select className="select" value={otherFlowSelectedCategoryId} onChange={e=>pickOtherFlowCategory(e.target.value)}>
                    <option value="">-- Chọn danh mục --</option>
                    {otherFlowCategorySelection.categories.map(c=>(
                      <option key={c.id} value={c.category_id}>{c.category_name}{c.is_default?' (mặc định)':''}</option>
                    ))}
                  </select>
                </div>
              )}

              <div className="pos-bill-context-row" style={{marginTop:8}}>
                <b>{otherFlowCategorySelection.categories.length>0?'+ Thêm danh mục khác:':'Chọn danh mục hàng hóa mới:'}</b>
                <select className="select" value={otherFlowAddCategoryPickerId} onChange={e=>setOtherFlowAddCategoryPickerId(e.target.value)}>
                  <option value="">-- Chọn danh mục --</option>
                  {otherFlowUnassignedCategories.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <button type="button" className="btn secondary" disabled={!otherFlowAddCategoryPickerId||otherFlowAddCategoryBusy} onClick={confirmAddOtherFlowCategory}>
                  {otherFlowAddCategoryBusy?'Đang tạo...':'Xác nhận tạo'}
                </button>
              </div>

              {otherFlowSelectedCategoryId && (
                <>
                  <input className="input" style={{marginTop:10}} placeholder="Tìm mã, tên mặt hàng..." value={otherFlowFilter} onChange={e=>setOtherFlowFilter(e.target.value)} />
                  <div className="pos-agent-table-scroll" style={{marginTop:8}}>
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Mã hàng</th><th>Tên mặt hàng</th><th>ĐVT</th>
                          {otherFlow==='INVENTORY_SALE' && <th>Tồn kho</th>}
                          <th>Số lượng</th><th>Đơn giá</th><th>Thành tiền</th>
                        </tr>
                      </thead>
                      <tbody>
                        {otherFlowCatalogLoading && <tr><td colSpan={7} style={{textAlign:'center'}}>Đang tải...</td></tr>}
                        {!otherFlowCatalogLoading && !otherFlowShown.length && (
                          <tr><td colSpan={7} style={{textAlign:'center'}} className="muted">Không có mặt hàng trong danh mục này</td></tr>
                        )}
                        {otherFlowShown.map(i=>{
                          const overStock=i.quantity_expr&&isOverStock(i.inventory_mode,i.allow_negative_stock,i.stock_quantity,i.quantity);
                          return (
                            <tr
                              key={i.product_id}
                              style={overStock?{background:'#fef2f2'}:undefined}
                              onDoubleClick={()=>addOrSelectOtherFlowRow(i.product_id)}
                            >
                              <td className="muted">{i.product_code}</td>
                              <td><b>{i.product_name}</b></td>
                              <td className="muted">{i.unit||'kg'}</td>
                              {otherFlow==='INVENTORY_SALE' && <td>{i.stock_quantity}</td>}
                              <td>
                                <input
                                  ref={el=>otherFlowQtyRefs.current[i.product_id]=el}
                                  className="input"
                                  style={overStock?{borderColor:'#dc2626'}:undefined}
                                  inputMode="decimal"
                                  value={i.quantity_expr||''}
                                  onChange={e=>updateOtherFlowQty(i.product_id,e.target.value)}
                                  onKeyDown={e=>handleOtherFlowRowKeyDown(e,i.product_id)}
                                  placeholder="0"
                                />
                                {overStock && <div style={{color:'#dc2626',fontSize:11,marginTop:2}}>Vượt tồn: còn {i.stock_quantity}</div>}
                              </td>
                              <td>{Number(i.sale_price||0).toLocaleString('en-US')}đ</td>
                              <td><b>{(Number(i.quantity||0)*Number(i.sale_price||0)).toLocaleString('en-US')}đ</b></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <button type="button" className="btn" style={{marginTop:10}} onClick={addOtherFlowSelectionToBill}>
                    Đưa vào bill
                  </button>
                </>
              )}
            </Dialog>

            <POSAdvancedTools
              toolsOpen={toolsOpen}
              setToolsOpen={setToolsOpen}
              cid={cid}
              saveOrder={saveOrder}
              toolsFirstInputRef={toolsFirstInputRef}
              onOpenExcelImportDialog={()=>setExcelImportDialogOpen(true)}
            />
          </main>

          <POSBillSummary
            totalQty={totalQty}
            total={total}
            monthlyInstallment={currentCustomer?.monthlyInstallment}
            billInstallmentAmount={billInstallmentAmount}
            showInstallment={Boolean(monthlyInstallmentId)||Number(billInstallmentAmount)>0}
            onInstallmentChange={changeBillInstallmentAmount}
            saving={saving}
            cid={cid}
            selectedCategoryId={selectedCategoryId}
            selectedCount={selected.length}
            onSave={save}
            onClear={clearCurrentBillQty}
            msg={msg}
          />
        </div>

        <div className="pos-bottom-ai-tools">
          <AIBusinessPanel compact title="AI nhập hàng / tồn kho"/>
          <AIVoicePOSPanel sessionId={`POS_${cid||'NO_CUSTOMER'}`}/>
        </div>
      </div>
    </SafePage>
  );
}
