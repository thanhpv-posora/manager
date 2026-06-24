import React,{useEffect,useRef,useState}from'react';
import api from'../api/api';
import SafePage from'../components/SafePage';
import MoneyInput from'../components/MoneyInput';
import {calcExpression} from'../utils/expr';
import {showSuccess,showError} from'../utils/toast';
import {formatLunarDate,parseLunarText,lunarToSolarDate} from'../utils/lunarDate';

const money=n=>Number(n||0).toLocaleString('en-US')+'đ';
const n=v=>Number(v||0);
const floor1=v=>Math.floor((Number(v)||0)*10)/10;
const animal=v=>floor1(v).toLocaleString('en-US',{minimumFractionDigits:1,maximumFractionDigits:1});
const kg1=v=>Number(v||0).toLocaleString('en-US',{minimumFractionDigits:1,maximumFractionDigits:1});

export default function Lots(){
  const today=new Date().toISOString().slice(0,10);
  const defaultLotForm=()=>({
    purchase_date:today,
    calendar_type:'SOLAR',
    lunar_date_text:'',
    raw_weight_expr:'',
    bone_weight_expr:'',
    deduct_mode:'PER_ANIMAL',
    total_animals:'',
    female_animals:'',
    deduct_kg_per_animal:'',
    deducted_weight_expr:'',
    damage_weight:'',
    fat_weight:'',
    fragment_weight:'',
    other_deduct_weight:'',
    male_price:200000,
    female_price:195000,
    fragment_price:100000,
    purchase_price:200000
  });
  const[rows,setRows]=useState([]);
  const[s,setS]=useState([]);
  const[supplier,setSupplier]=useState({});
  const[editingSupplier,setEditingSupplier]=useState(null);
  const[supplierOpen,setSupplierOpen]=useState(false);
  const[supplierListOpen,setSupplierListOpen]=useState(false);
  const[f,setF]=useState(defaultLotForm);
  const[deductOpen,setDeductOpen]=useState(false);
  const[pay,setPay]=useState({payment_date:today,type:'ADVANCE',payment_method:'CASH'});
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState('');
  const[saving,setSaving]=useState(false);
  const[saveStatus,setSaveStatus]=useState(null);
  const[reportTab,setReportTab]=useState('DETAIL');
  const[reportFilter,setReportFilter]=useState({from:'',to:'',supplier_id:''});
  const[editingLotId,setEditingLotId]=useState(null);
  const[priceSource,setPriceSource]=useState(null);
  const[dateDialogOpen,setDateDialogOpen]=useState(false);
  const[dialogType,setDialogType]=useState('SOLAR');
  const[dialogSupplierId,setDialogSupplierId]=useState(null);
  const[dialogSolarDate,setDialogSolarDate]=useState(today);
  const[dialogLunarText,setDialogLunarText]=useState('');

  const setField=(k,v)=>setF(prev=>({...prev,[k]:v}));
  const selectedSupplier=s.find(x=>String(x.id)===String(f.supplier_id||''));
  const selectedSupplierCalendar=String(selectedSupplier?.billing_calendar_type||f.calendar_type||'SOLAR').toUpperCase()==='LUNAR'?'LUNAR':'SOLAR';
  const selectedSupplierCalendarLabel=selectedSupplierCalendar==='LUNAR'?'Âm lịch':'Dương lịch';

  const applySupplierCalendarToLot=async(supplierId,purchaseDate=f.purchase_date,lunarTextOverride=undefined)=>{
    const sp=s.find(x=>String(x.id)===String(supplierId||''));
    const type=String(sp?.billing_calendar_type||'SOLAR').toUpperCase()==='LUNAR'?'LUNAR':'SOLAR';
    setF(prev=>({
      ...prev,
      supplier_id:supplierId,
      purchase_date:purchaseDate,
      calendar_type:type,
      lunar_date_text:type==='LUNAR'?(lunarTextOverride!==undefined?lunarTextOverride:formatLunarDate(purchaseDate||today)):'',
      // FIX-3: preserve historical snapshot prices in edit mode; in create mode, reset to new supplier's stored prices (no fallthrough to old supplier)
      ...(editingLotId?{}:{
        male_price:n(sp?.male_price),
        female_price:n(sp?.female_price),
        fragment_price:n(sp?.fragment_price)
      })
    }));
    setPriceSource(null);
    if(!supplierId||editingLotId) return;
    try{
      const res=await api.get(`/suppliers/${supplierId}/beef-prices`,{params:{purchase_date:purchaseDate||today}});
      const d=res.data;
      setF(prev=>({
        ...prev,
        male_price:n(d.male_price),
        female_price:n(d.female_price),
        fragment_price:n(d.fragment_price)
      }));
      setPriceSource(d.source||null);
    }catch{/* silently keep fallback prices */}
  };

  const onSupplierChange=(supplierId)=>{
    if(!supplierId){applySupplierCalendarToLot('',f.purchase_date);return;}
    const sp=s.find(x=>String(x.id)===String(supplierId));
    const type=String(sp?.billing_calendar_type||'SOLAR').toUpperCase()==='LUNAR'?'LUNAR':'SOLAR';
    setDialogSupplierId(supplierId);
    setDialogType(type);
    setDialogSolarDate(f.purchase_date||today);
    setDialogLunarText(type==='LUNAR'?(f.lunar_date_text||formatLunarDate(f.purchase_date||today)):'');
    setDateDialogOpen(true);
  };
  const openDateDialog=()=>{
    setDialogSupplierId(null);
    setDialogType(selectedSupplierCalendar);
    setDialogSolarDate(f.purchase_date||today);
    setDialogLunarText(f.lunar_date_text||formatLunarDate(f.purchase_date||today));
    setDateDialogOpen(true);
  };
  const confirmDateDialog=()=>{
    const supplierId=dialogSupplierId!==null?dialogSupplierId:f.supplier_id;
    if(dialogType==='SOLAR'){
      applySupplierCalendarToLot(supplierId,dialogSolarDate);
    }else{
      const solar=lunarToSolarDate(parseLunarText(dialogLunarText))||f.purchase_date||today;
      applySupplierCalendarToLot(supplierId,solar,dialogLunarText);
    }
    setDateDialogOpen(false);
    setDialogSupplierId(null);
  };
  const cancelDateDialog=()=>{setDateDialogOpen(false);setDialogSupplierId(null);};

  const changePurchaseDate=(v)=>{
    setF(prev=>({
      ...prev,
      purchase_date:v,
      lunar_date_text:selectedSupplierCalendar==='LUNAR'?formatLunarDate(v||today):''
    }));
  };

  const changeLotLunarDateText=(v)=>{
    const solar=lunarToSolarDate(parseLunarText(v));
    setF(prev=>({
      ...prev,
      lunar_date_text:v,
      purchase_date:solar||prev.purchase_date
    }));
    // FIX-2: re-resolve prices for new effective date (create mode only)
    if(f.supplier_id&&solar&&!editingLotId){
      api.get(`/suppliers/${f.supplier_id}/beef-prices`,{params:{purchase_date:solar}})
        .then(res=>{
          const d=res.data;
          setF(prev=>({...prev,male_price:d.male_price||prev.male_price,female_price:d.female_price||prev.female_price,fragment_price:d.fragment_price||prev.fragment_price}));
          setPriceSource(d.source||null);
        })
        .catch(()=>{});
    }
  };

  const navRefs=useRef([]);
  const setNavRef=i=>el=>{navRefs.current[i]=el};
  const focusNav=(i)=>{const el=navRefs.current[i]; if(el&&typeof el.focus==='function'){el.focus(); if(typeof el.select==='function')el.select();}};
  const onLotNavKey=(e,i)=>{
    const keys=['Enter','ArrowDown','ArrowRight','ArrowUp','ArrowLeft'];
    if(!keys.includes(e.key))return;
    e.preventDefault();
    if(e.key==='Enter'||e.key==='ArrowDown'||e.key==='ArrowRight')focusNav(i+1);
    if(e.key==='ArrowUp'||e.key==='ArrowLeft')focusNav(i-1);
  };

  const formRef=useRef(null);
  const rawWeightRef=useRef(null);
  const summarySlotRef=useRef(null);
  const[summaryFloatStyle,setSummaryFloatStyle]=useState({});

  useEffect(()=>{
    let raf=0;
    const update=()=>{
      cancelAnimationFrame(raf);
      raf=requestAnimationFrame(()=>{
        const slot=summarySlotRef.current;
        const raw=rawWeightRef.current;
        if(!slot||!raw||window.innerWidth<=1100){
          setSummaryFloatStyle({});
          return;
        }

        const slotRect=slot.getBoundingClientRect();
        const rawRect=raw.getBoundingClientRect();

        // V35 TOP LOCK RULE:
        // 1) Khi field “Tổng kg thịt xô” còn nằm thấp hơn màn hình, panel nằm ngang mép trên field đó.
        // 2) Khi cuộn xuống qua field này, panel mới bám màn hình ở khoảng cách an toàn.
        // 3) Không bao giờ cho panel nhảy lên phần header/Nhà cung cấp.
        const safeTop=96;
        const top=Math.max(safeTop, rawRect.top);
        const maxHeight=Math.max(260, window.innerHeight-top-18);

        setSummaryFloatStyle({
          position:'fixed',
          top:`${top}px`,
          left:`${slotRect.left}px`,
          width:`${slotRect.width}px`,
          maxHeight:`${maxHeight}px`,
          overflow:'auto',
          zIndex:30,
          '--lots-summary-top':`${top}px`,
          '--lots-summary-left':`${slotRect.left}px`,
          '--lots-summary-width':`${slotRect.width}px`,
          '--lots-summary-max-height':`${maxHeight}px`
        });
      });
    };
    update();
    window.addEventListener('scroll',update,{passive:true});
    window.addEventListener('resize',update);
    return()=>{
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll',update);
      window.removeEventListener('resize',update);
    };
  },[supplierOpen,supplierListOpen,deductOpen]);


  const load=async()=>{
    try{
      const [lots,suppliers]=await Promise.all([api.get('/lots'),api.get('/suppliers')]);
      setRows(lots.data||[]);
      setS(suppliers.data||[]);
    }catch(e){
      setError(e.response?.data?.message||e.message);
    }finally{
      setLoading(false);
    }
  };
  useEffect(()=>{load()},[]);

  const rawWeight=calcExpression(f.raw_weight_expr);
  const boneWeight=calcExpression(f.bone_weight_expr);
  const ribToMeatWeight=boneWeight/2;

  const qtyValue=v=>calcExpression(v);

  const totalAnimals=floor1(qtyValue(f.total_animals));
  const femaleAnimals=floor1(qtyValue(f.female_animals));
  const maleAnimals=floor1(Math.max(0,totalAnimals-femaleAnimals));
  const deductKgPerAnimal=qtyValue(f.deduct_kg_per_animal);
  const manualDeductWeight=qtyValue(f.deducted_weight_expr);
  const deductedWeight=f.deduct_mode==='TOTAL_KG'
    ? manualDeductWeight
    : totalAnimals*deductKgPerAnimal;

  const damageWeight=qtyValue(f.damage_weight);
  const fatWeight=qtyValue(f.fat_weight);
  const fragmentWeight=qtyValue(f.fragment_weight);
  const otherDeductWeight=qtyValue(f.other_deduct_weight);
  // V65.13: Vụn là mặt hàng riêng có giá riêng, KHÔNG trừ khỏi kg bò xô tính tiền.
  const finalWeight=rawWeight+ribToMeatWeight-deductedWeight-damageWeight-fatWeight-otherDeductWeight;

  const malePrice=n(f.male_price||f.purchase_price);
  const femalePrice=n(f.female_price||f.purchase_price);
  const fragmentPrice=n(f.fragment_price||0);
  const maleRatio=totalAnimals>0?maleAnimals/totalAnimals:1;
  const femaleRatio=totalAnimals>0?femaleAnimals/totalAnimals:0;
  const maleWeight=finalWeight*maleRatio;
  const femaleWeight=finalWeight*femaleRatio;
  const cattleCost=maleWeight*malePrice+femaleWeight*femalePrice;
  const fragmentCost=fragmentWeight*fragmentPrice;
  const totalCost=cattleCost+fragmentCost;

  const stats=rows.reduce((a,r)=>({
    count:a.count+1,
    animals:a.animals+n(r.total_animals),
    male:a.male+n(r.male_animals),
    female:a.female+n(r.female_animals),
    raw:a.raw+n(r.raw_weight),
    rib:a.rib+n(r.bone_weight),
    ribMeat:a.ribMeat+n(r.bone_weight)/2,
    deduct:a.deduct+n(r.deducted_weight),
    fragment:a.fragment+n(r.fragment_weight),
    final:a.final+n(r.total_weight),
    cost:a.cost+n(r.total_cost)
  }),{count:0,animals:0,male:0,female:0,raw:0,rib:0,ribMeat:0,deduct:0,fragment:0,final:0,cost:0});

  const resetSupplier=()=>{setEditingSupplier(null);setSupplier({billing_calendar_type:'SOLAR',is_active:1,male_price:200000,female_price:195000,fragment_price:100000})};
  const saveSupplier=async()=>{
    try{
      if(!supplier.name)return alert('Nhập tên nhà cung cấp');
      const payload={...supplier,billing_calendar_type:String(supplier.billing_calendar_type||'SOLAR').toUpperCase()==='LUNAR'?'LUNAR':'SOLAR'};
      if(editingSupplier)await api.put('/suppliers/'+editingSupplier,payload);
      else await api.post('/suppliers',payload);
      resetSupplier();
      setSupplierOpen(false);
      setSupplierListOpen(false);
      await load();
    }catch(e){
      alert(e.response?.data?.message||e.message||'Lưu nhà cung cấp thất bại');
    }
  };
  const editSupplier=x=>{setEditingSupplier(x.id);setSupplier({...x,billing_calendar_type:x.billing_calendar_type||'SOLAR',is_active:1});setSupplierOpen(true)};
  const deleteSupplier=async id=>{
    const reason=prompt('Nhập lý do xóa mềm nhà cung cấp:');
    if(reason){
      try{await api.delete('/suppliers/'+id,{data:{reason}});await load()}
      catch(e){alert(e.response?.data?.message||e.message)}
    }
  };

  const cancelEditMode=()=>{
    setEditingLotId(null);
    setF(defaultLotForm());
    setDeductOpen(false);
  };

  const loadLotIntoForm=r=>{
    setEditingLotId(r.id);
    setF({
      lot_name:r.lot_name||'',
      supplier_id:String(r.supplier_id||''),
      purchase_date:isoDate(r.purchase_date),
      calendar_type:r.calendar_type||'SOLAR',
      lunar_date_text:r.lunar_date_text||'',
      raw_weight_expr:r.raw_weight_expr||String(r.raw_weight||''),
      bone_weight_expr:r.bone_weight_expr||String(r.bone_weight||''),
      deduct_mode:r.deduct_mode||'PER_ANIMAL',
      total_animals:String(r.total_animals||''),
      female_animals:String(r.female_animals||''),
      deduct_kg_per_animal:String(r.deduct_kg_per_animal||''),
      deducted_weight_expr:r.deducted_weight_expr||String(r.deducted_weight||''),
      damage_weight:String(r.damage_weight||''),
      fat_weight:String(r.fat_weight||''),
      fragment_weight:String(r.fragment_weight||''),
      fragment_price:n(r.fragment_price)||100000,
      other_deduct_weight:String(r.other_deduct_weight||''),
      male_price:n(r.male_price)||200000,
      female_price:n(r.female_price)||195000,
      purchase_price:n(r.purchase_price)||n(r.male_price)||200000,
      note:r.note||'',
      deduct_note:r.deduct_note||''
    });
    formRef.current?.scrollIntoView({behavior:'smooth',block:'start'});
  };

  const save=async()=>{
    if(saving)return;
    setSaveStatus(null);
    if(!f.supplier_id){
      setSaveStatus({type:'error',message:'Vui lòng chọn nhà cung cấp trước khi lưu lô nhập.'});
      return;
    }
    if(rawWeight<=0){
      setSaveStatus({type:'error',message:'Tổng kg thịt xô phải lớn hơn 0. Không thể lưu lô nhập trống.'});
      rawWeightRef.current?.focus?.();
      return;
    }
    if(totalAnimals<=0){
      setSaveStatus({type:'error',message:'Tổng số con phải lớn hơn 0.'});
      return;
    }
    if(finalWeight<=0){
      setSaveStatus({type:'error',message:'Kg tính tiền phải lớn hơn 0. Vui lòng kiểm tra lại số kg trừ.'});
      return;
    }
    setSaving(true);
    const payload={
      ...f,
      raw_weight:rawWeight,
      bone_weight:boneWeight,
      deducted_weight:deductedWeight,
      damage_weight:damageWeight,
      fat_weight:fatWeight,
      fragment_weight:fragmentWeight,
      other_deduct_weight:otherDeductWeight,
      total_animals:totalAnimals,
      female_animals:femaleAnimals,
      male_animals:maleAnimals,
      deduct_kg_per_animal:deductKgPerAnimal,
      male_price:malePrice,
      female_price:femalePrice,
      male_weight:maleWeight,
      female_weight:femaleWeight,
      total_weight:finalWeight,
      fragment_price:fragmentPrice,
      fragment_cost:fragmentCost,
      total_cost:totalCost
    };
    try{
      if(editingLotId){
        const res=await api.put('/lots/'+editingLotId,payload);
        setSaveStatus({type:'success',message:`Đã cập nhật lô nhập ${res.data?.lot_code||''}`.trim()});
        cancelEditMode();
      }else{
        const res=await api.post('/lots',payload);
        setF(prev=>({
          ...prev,
          lot_name:'',
          raw_weight_expr:'',
          bone_weight_expr:'',
          total_animals:'',
          female_animals:'',
          deduct_mode:'PER_ANIMAL',
          deduct_kg_per_animal:'',
          deducted_weight_expr:'',
          damage_weight:'',
          fat_weight:'',
          fragment_weight:'',
          other_deduct_weight:'',
          deduct_note:''
        }));
        setDeductOpen(false);
        setSaveStatus({type:'success',message:`Đã lưu lô nhập ${res.data?.lot_code||''}`.trim()});
      }
      await load();
    }catch(e){
      const msg=e.response?.data?.message||e.message||(editingLotId?'Cập nhật nhập hàng thất bại':'Lưu nhập hàng thất bại');
      setSaveStatus({type:'error',message:msg});
    }finally{
      setSaving(false);
    }
  };

  const print=id=>window.open((import.meta.env.VITE_API_URL||(typeof window !== 'undefined' ? `${window.location.origin}/api` : '/api'))+'/lots/public/'+id+'/print','_blank');
  const payLot=async()=>{
    if(!pay.lot_id||!pay.amount)return alert('Chọn lô và nhập số tiền');
    try{
      await api.post('/lots/'+pay.lot_id+'/payments',pay);
      setPay({...pay,amount:''});
      load();
      showSuccess('Đã lưu thanh toán NCC');
    }catch(e){
      showError(e.response?.data?.message||'Không thể lưu thanh toán. Vui lòng thử lại.');
    }
  };
  const fillFull=()=>{const lot=rows.find(r=>String(r.id)===String(pay.lot_id));if(lot)setPay({...pay,type:'PAYMENT',amount:lot.remaining_amount})};
  const closeLot=async(id,lot_code)=>{
    if(!await window.appConfirm('Bạn có chắc muốn chốt phiếu nhập?\n\nSau khi chốt:\n\n• Không thể chỉnh sửa\n• Không thể thanh toán thêm',{title:'Chốt phiếu nhập',confirmText:'Chốt phiếu',cancelText:'Hủy',variant:'warning'}))return;
    try{await api.put('/lots/'+id+'/status',{status:'CLOSED'});await load();}
    catch(e){alert(e.response?.data?.message||e.message);}
  };

  const kg=v=>Number(v||0).toLocaleString('en-US',{maximumFractionDigits:3});
  const isoDate=v=>v?String(v).slice(0,10):'';
  const dateText=v=>{ const raw=isoDate(v); const m=raw.match(/^(\d{4})-(\d{2})-(\d{2})$/); return m?`${m[3]}/${m[2]}/${m[1]}`:raw; };
  const lotCalendarType=r=>String(r?.calendar_type||r?.supplier_billing_calendar_type||'SOLAR').toUpperCase()==='LUNAR'?'LUNAR':'SOLAR';
  const lotMappedSolarDate=r=>dateText(r?.purchase_date);
  const lotBillDateText=r=>{
    const type=lotCalendarType(r);
    const d=lotMappedSolarDate(r);
    if(type==='LUNAR'){
      const lunar=String(r?.lunar_date_text||'').trim() || formatLunarDate(d);
      return lunar ? `${lunar} ÂL` : '';
    }
    return d ? `${d} DL` : '';
  };
  const lotBillDateFullText=r=>{
    const type=lotCalendarType(r);
    const d=lotMappedSolarDate(r);
    if(type==='LUNAR'){
      const lunar=String(r?.lunar_date_text||'').trim() || formatLunarDate(d);
      return lunar ? `${d} (${lunar} âm lịch)` : d;
    }
    return d || '';
  };
  const lotImportDateText=lotBillDateFullText;
  const reportRows=rows.filter(r=>{
    // purchase_date là NGÀY TÍNH PHIẾU đã mapping sang dương lịch.
    // Với NCC âm lịch: lunar_date_text giữ ngày âm, purchase_date giữ ngày dương tương ứng để báo cáo/dashboard không lệch tháng.
    const d=isoDate(r.purchase_date);
    if(reportFilter.from && d<reportFilter.from)return false;
    if(reportFilter.to && d>reportFilter.to)return false;
    if(reportFilter.supplier_id && String(r.supplier_id)!==String(reportFilter.supplier_id))return false;
    return true;
  });
  const detailTotals=reportRows.reduce((a,r)=>({
    lots:a.lots+1,
    animals:a.animals+n(r.total_animals),
    maleAnimals:a.maleAnimals+n(r.male_animals),
    femaleAnimals:a.femaleAnimals+n(r.female_animals),
    maleWeight:a.maleWeight+n(r.male_weight),
    maleMoney:a.maleMoney+n(r.male_weight)*n(r.male_price||r.purchase_price),
    femaleWeight:a.femaleWeight+n(r.female_weight),
    femaleMoney:a.femaleMoney+n(r.female_weight)*n(r.female_price||r.purchase_price),
    deduct:a.deduct+n(r.deducted_weight),
    rib:a.rib+n(r.bone_weight),
    ribMoney:a.ribMoney+n(r.bone_weight)*n(r.rib_price||0),
    fragment:a.fragment+n(r.fragment_weight),
    fragmentMoney:a.fragmentMoney+n(r.fragment_cost||n(r.fragment_weight)*n(r.fragment_price)),
    final:a.final+n(r.total_weight),
    cost:a.cost+n(r.total_cost)
  }),{lots:0,animals:0,maleAnimals:0,femaleAnimals:0,maleWeight:0,maleMoney:0,femaleWeight:0,femaleMoney:0,deduct:0,rib:0,ribMoney:0,fragment:0,fragmentMoney:0,final:0,cost:0});
  const summaryRows=Object.values(reportRows.reduce((m,r)=>{
    const key=r.supplier_id||'unknown';
    const mappedDate=lotMappedSolarDate(r);
    if(!m[key])m[key]={supplier_id:key,supplier_name:r.supplier_name||'Không rõ NCC',lots:0,from:mappedDate,to:mappedDate,fromText:lotImportDateText(r),toText:lotImportDateText(r),animals:0,maleAnimals:0,femaleAnimals:0,maleWeight:0,maleMoney:0,femaleWeight:0,femaleMoney:0,deduct:0,rib:0,ribMoney:0,fragment:0,fragmentMoney:0,final:0,cost:0};
    const x=m[key];
    if(mappedDate){
      if(!x.from||mappedDate<x.from){x.from=mappedDate;x.fromText=lotImportDateText(r);}
      if(!x.to||mappedDate>x.to){x.to=mappedDate;x.toText=lotImportDateText(r);}
    }
    x.lots+=1;
    x.animals+=n(r.total_animals);
    x.maleAnimals+=n(r.male_animals);
    x.femaleAnimals+=n(r.female_animals);
    x.maleWeight+=n(r.male_weight);
    x.maleMoney+=n(r.male_weight)*n(r.male_price||r.purchase_price);
    x.femaleWeight+=n(r.female_weight);
    x.femaleMoney+=n(r.female_weight)*n(r.female_price||r.purchase_price);
    x.deduct+=n(r.deducted_weight);
    x.rib+=n(r.bone_weight);
    x.ribMoney+=n(r.bone_weight)*n(r.rib_price||0);
    x.fragment+=n(r.fragment_weight);
    x.fragmentMoney+=n(r.fragment_cost||n(r.fragment_weight)*n(r.fragment_price));
    x.final+=n(r.total_weight);
    x.cost+=n(r.total_cost);
    return m;
  },{}));

  const reportRangeText=`Theo ngày nhập hàng: từ ${reportFilter.from||'...'} đến ${reportFilter.to||'...'}`;
  const printHtml=(title,tableHtml)=>{
    const w=window.open('','_blank');
    if(!w)return;
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
      @page{size:A4 landscape;margin:10mm}body{font-family:Arial,sans-serif;color:#111;font-size:11px}h2{text-align:center;margin:4px 0 8px}.meta{display:flex;justify-content:space-between;margin-bottom:8px}.company{font-weight:700}.subtitle{text-align:center;margin-bottom:10px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #333;padding:4px;text-align:right;vertical-align:middle}th{background:#f1f1f1;text-align:center}td.left{text-align:left}td.center{text-align:center}tfoot td{font-weight:700;background:#f7f7f7}.sign{display:flex;justify-content:space-around;margin-top:36px;text-align:center;font-weight:700}.sign small{display:block;font-weight:400;margin-top:6px}</style></head><body>
      <div class="meta"><div><div class="company">CÔNG TY TNHH MEATBIZ</div><div>Địa chỉ: ................................................</div><div>ĐT: ................................................</div></div><div>Ngày in: ${new Date().toLocaleDateString('vi-VN')}</div></div>
      <h2>${title}</h2><div class="subtitle">${reportRangeText}</div>${tableHtml}<div class="sign"><div>Người lập biểu<small>(Ký, họ tên)</small></div><div>Kế toán<small>(Ký, họ tên)</small></div><div>Giám đốc<small>(Ký, họ tên)</small></div></div>
      <script>window.onload=()=>setTimeout(()=>window.print(),200)</script></body></html>`);
    w.document.close();
  };
  const printDetail=()=>{
    const rowsHtml=reportRows.map((r,i)=>`<tr><td class="center">${i+1}</td><td class="center">${dateText(r.created_at||r.purchase_date)}</td><td class="center">${lotImportDateText(r)}</td><td class="left">${r.lot_code||''}</td><td class="left">${r.supplier_name||''}</td><td>${animal(r.total_animals)}</td><td>${animal(r.male_animals)}</td><td>${kg(r.male_weight)}</td><td>${money(r.male_price||r.purchase_price)}</td><td>${money(n(r.male_weight)*n(r.male_price||r.purchase_price))}</td><td>${animal(r.female_animals)}</td><td>${kg(r.female_weight)}</td><td>${money(r.female_price||r.purchase_price)}</td><td>${money(n(r.female_weight)*n(r.female_price||r.purchase_price))}</td><td>${kg(r.deducted_weight)}</td><td>${kg(r.bone_weight)}</td><td>${kg(r.fragment_weight)}</td><td>${money(r.fragment_price)}</td><td>${money(r.fragment_cost||n(r.fragment_weight)*n(r.fragment_price))}</td><td>${kg(r.total_weight)}</td><td>${money(r.total_cost)}</td></tr>`).join('');
    const html=`<table><thead><tr><th rowspan="2">STT</th><th rowspan="2">Ngày lập<br/>phiếu</th><th rowspan="2">Ngày nhập<br/>hàng</th><th rowspan="2">Số phiếu</th><th rowspan="2">NCC</th><th rowspan="2">Tổng<br/>con</th><th colspan="4">Bò đực</th><th colspan="4">Bò cái</th><th rowspan="2">Trừ xô<br/>kg</th><th rowspan="2">Xương<br/>sườn kg</th><th colspan="3">Thịt vụn</th><th rowspan="2">Kg thực<br/>tính</th><th rowspan="2">Thành tiền</th></tr><tr><th>Con</th><th>Kg</th><th>Giá</th><th>Tiền</th><th>Con</th><th>Kg</th><th>Giá</th><th>Tiền</th><th>Kg</th><th>Giá</th><th>Tiền</th></tr></thead><tbody>${rowsHtml}</tbody><tfoot><tr><td colspan="5" class="center">TỔNG CỘNG</td><td>${animal(detailTotals.animals)}</td><td>${animal(detailTotals.maleAnimals)}</td><td>${kg(detailTotals.maleWeight)}</td><td></td><td>${money(detailTotals.maleMoney)}</td><td>${animal(detailTotals.femaleAnimals)}</td><td>${kg(detailTotals.femaleWeight)}</td><td></td><td>${money(detailTotals.femaleMoney)}</td><td>${kg(detailTotals.deduct)}</td><td>${kg(detailTotals.rib)}</td><td>${kg(detailTotals.fragment)}</td><td></td><td>${money(detailTotals.fragmentMoney)}</td><td>${kg(detailTotals.final)}</td><td>${money(detailTotals.cost)}</td></tr></tfoot></table>`;
    printHtml('THỐNG KÊ CHI TIẾT NHẬP LÔ / NHÀ CUNG CẤP',html);
  };
  const printSummary=()=>{
    const rowsHtml=summaryRows.map((r,i)=>`<tr><td class="center">${i+1}</td><td class="left">${r.supplier_name}</td><td class="center">${r.fromText||r.from||''}<br/>→ ${r.toText||r.to||''}</td><td>${kg(r.lots)}</td><td>${animal(r.animals)}</td><td>${animal(r.maleAnimals)}</td><td>${kg(r.maleWeight)}</td><td>${money(r.maleMoney)}</td><td>${animal(r.femaleAnimals)}</td><td>${kg(r.femaleWeight)}</td><td>${money(r.femaleMoney)}</td><td>${kg(r.deduct)}</td><td>${kg(r.rib)}</td><td>${kg(r.fragment)}</td><td>${money(r.fragmentMoney)}</td><td>${kg(r.final)}</td><td>${money(r.cost)}</td></tr>`).join('');
    const html=`<table><thead><tr><th>STT</th><th>NCC</th><th>Ngày nhập hàng</th><th>Số lô</th><th>Tổng con</th><th>Đực con</th><th>Đực kg</th><th>Tiền đực</th><th>Cái con</th><th>Cái kg</th><th>Tiền cái</th><th>Trừ xô kg</th><th>Xương sườn kg</th><th>Vụn kg</th><th>Tiền vụn</th><th>Kg thực tính</th><th>Tổng thành tiền</th></tr></thead><tbody>${rowsHtml}</tbody><tfoot><tr><td colspan="3" class="center">TỔNG CỘNG</td><td>${kg(detailTotals.lots)}</td><td>${animal(detailTotals.animals)}</td><td>${animal(detailTotals.maleAnimals)}</td><td>${kg(detailTotals.maleWeight)}</td><td>${money(detailTotals.maleMoney)}</td><td>${animal(detailTotals.femaleAnimals)}</td><td>${kg(detailTotals.femaleWeight)}</td><td>${money(detailTotals.femaleMoney)}</td><td>${kg(detailTotals.deduct)}</td><td>${kg(detailTotals.rib)}</td><td>${kg(detailTotals.fragment)}</td><td>${money(detailTotals.fragmentMoney)}</td><td>${kg(detailTotals.final)}</td><td>${money(detailTotals.cost)}</td></tr></tfoot></table>`;
    printHtml('THỐNG KÊ TỔNG HỢP NHẬP LÔ / NHÀ CUNG CẤP',html);
  };

  return <SafePage loading={loading} error={error}>
    {dateDialogOpen&&<div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.45)',zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center'}} onClick={cancelDateDialog}>
      <div style={{background:'#fff',borderRadius:12,padding:'24px 28px',minWidth:300,maxWidth:420,width:'90%',boxShadow:'0 8px 32px rgba(0,0,0,0.22)'}} onClick={e=>e.stopPropagation()}>
        <h3 style={{marginTop:0,marginBottom:16}}>{dialogType==='SOLAR'?'Chọn ngày nhập dương lịch':'Chọn ngày nhập âm lịch'}</h3>
        {dialogType==='SOLAR'
          ?<label style={{display:'block'}}><span className="muted">Ngày dương lịch</span><input className="input" type="date" value={dialogSolarDate} onChange={e=>setDialogSolarDate(e.target.value)} autoFocus/></label>
          :<label style={{display:'block'}}><span className="muted">Ngày âm lịch (VD: 28/03/2026)</span><input className="input" value={dialogLunarText} onChange={e=>setDialogLunarText(e.target.value)} placeholder="VD: 28/03/2026" autoFocus/>{(()=>{const sol=lunarToSolarDate(parseLunarText(dialogLunarText));return dialogLunarText?<small className="muted" style={{display:'block',marginTop:4}}>{sol?`→ Dương lịch: ${dateText(sol)}`:'⚠ Ngày âm không hợp lệ'}</small>:null;})()}</label>
        }
        <div className="actions" style={{marginTop:18,justifyContent:'flex-end'}}>
          <button className="btn secondary" onClick={cancelDateDialog}>Hủy</button>
          <button className="btn" onClick={confirmDateDialog}>Xác nhận</button>
        </div>
      </div>
    </div>}
    <div className="grid cols-2 lots-agent-page">
      <div ref={formRef} className="card lots-entry-card">
        <div className="section-toggle-header">
          <div>
            <h3 style={{marginBottom:4}}>Nhà cung cấp</h3>
            <p className="muted" style={{marginTop:0}}>Thu gọn form và danh sách nhà cung cấp để màn nhập lô sạch hơn.</p>
          </div>
          <div className="actions" style={{marginTop:0}}>
            <button
              type="button"
              className="btn secondary"
              onClick={()=>{
                if(supplierOpen){resetSupplier()}
                setSupplierOpen(v=>!v);
              }}
            >
              {supplierOpen?'− Thu gọn form':'+ Thêm / sửa NCC'}
            </button>
            <button
              type="button"
              className="btn secondary"
              onClick={()=>setSupplierListOpen(v=>!v)}
            >
              {supplierListOpen?'− Thu gọn danh sách':'📦 Danh sách NCC'}
            </button>
          </div>
        </div>

        {supplierOpen&&<>
          <h3>{editingSupplier?'Sửa nhà cung cấp':'Thêm nhà cung cấp'}</h3>
          <div className="form-grid">
            <input className="input" placeholder="Tên NCC" value={supplier.name||''} onChange={e=>setSupplier({...supplier,name:e.target.value})}/>
            <input className="input" placeholder="SĐT" value={supplier.phone||''} onChange={e=>setSupplier({...supplier,phone:e.target.value})}/>
            <input className="input" placeholder="Địa chỉ" value={supplier.address||''} onChange={e=>setSupplier({...supplier,address:e.target.value})}/>
            <input className="input" placeholder="Ghi chú" value={supplier.note||''} onChange={e=>setSupplier({...supplier,note:e.target.value})}/>
            <label><span className="muted">Lịch tính bill NCC</span><select className="select" value={supplier.billing_calendar_type||'SOLAR'} onChange={e=>setSupplier({...supplier,billing_calendar_type:e.target.value})}><option value="SOLAR">Dương lịch</option><option value="LUNAR">Âm lịch</option></select></label>
            <label><span className="muted">Giá bò xô đực / kg</span><MoneyInput placeholder="208,000" value={supplier.male_price??''} onChange={v=>setSupplier({...supplier,male_price:v})}/></label>
            <label><span className="muted">Giá bò xô cái / kg</span><MoneyInput placeholder="195,000" value={supplier.female_price??''} onChange={v=>setSupplier({...supplier,female_price:v})}/></label>
            <label><span className="muted">Giá thịt vụn / kg</span><MoneyInput placeholder="100,000" value={supplier.fragment_price??''} onChange={v=>setSupplier({...supplier,fragment_price:v})}/></label>
          </div>
          <div className="actions" style={{marginTop:10}}>
            <button className="btn secondary" onClick={saveSupplier}>{editingSupplier?'Lưu sửa NCC':'+ Thêm NCC'}</button>
            <button className="btn secondary" onClick={resetSupplier}>Làm mới</button>
          </div>
        </>}

        {supplierListOpen&&<table className="table"><tbody>{s.map(x=><tr key={x.id}><td>{x.name}<br/><span className="muted">{x.phone}</span><br/><span className="badge">{x.billing_calendar_type==='LUNAR'?'Âm lịch':'Dương lịch'}</span><br/><span className="muted">Đực {money(x.male_price||0)} · Cái {money(x.female_price||0)} · Vụn {money(x.fragment_price||0)}</span></td><td><button className="btn secondary" onClick={()=>editSupplier(x)}>Sửa</button> <button className="btn danger" onClick={()=>deleteSupplier(x.id)}>Xóa mềm</button></td></tr>)}</tbody></table>}

        {editingLotId&&(()=>{const el=rows.find(r=>String(r.id)===String(editingLotId));return(<div style={{background:'#fffbe6',border:'1.5px solid #f59e0b',borderRadius:8,padding:'10px 14px',marginBottom:10}}>
          <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
            <span style={{fontWeight:700,fontSize:14}}>🟡 ĐANG CHỈNH SỬA NHẬP HÀNG</span>
            {el?.status&&<span className="badge" style={{marginLeft:6}}>{el.status}</span>}
            <button className="btn secondary" style={{marginLeft:'auto'}} onClick={cancelEditMode}>Hủy sửa</button>
          </div>
          <div className="muted" style={{marginTop:4,fontSize:13}}>
            {el&&<><b>{el.lot_code}</b>{el.lot_name&&el.lot_name!==el.lot_code?<> · {el.lot_name}</>:null}{el.supplier_name?<> · {el.supplier_name}</>:null}{el.purchase_date?<> · {lotBillDateFullText(el)}</>:null}</>}
          </div>
        </div>);})()}

        <h3>Nhập hàng</h3>
        <p className="muted">Các ô số lượng/kg có thể cộng trừ trực tiếp, ví dụ: <b>90.5+75.8-2</b>. Riêng Tổng kg thịt xô có thể nhập nhiều dòng. Xương sườn giữ 1 dòng và tự quy đổi: <b>kg xương sườn / 2</b> rồi cộng vào thịt xô.</p>

        <div className="lots-entry-layout">
          <div className="lots-entry-fields">
            <div className="form-grid">
          <div className="lots-header-row" style={{gridColumn:'1/-1'}}>
            <label style={{margin:0}}><span className="muted">Mã nhập hàng</span><input className="input" placeholder="Mã nhập hàng" value={f.lot_name||''} onChange={e=>setField('lot_name',e.target.value)}/></label>
            <label style={{margin:0}}><span className="muted">Nhà cung cấp</span><select className="select" value={dateDialogOpen&&dialogSupplierId?dialogSupplierId:(f.supplier_id||'')} onChange={e=>onSupplierChange(e.target.value)}><option value="">Chọn nhà cung cấp</option>{s.map(x=><option key={x.id} value={x.id}>{x.name} - {x.billing_calendar_type==='LUNAR'?'Âm lịch':'Dương lịch'}</option>)}</select></label>
            <div style={{display:'flex',flexDirection:'column',gap:2}}>
              <span className="muted">Ngày nhập</span>
              {f.supplier_id
                ?<button type="button" className="btn secondary lots-date-btn" style={{fontWeight:500}} onClick={openDateDialog}>{selectedSupplierCalendar==='LUNAR'?`${f.lunar_date_text||formatLunarDate(f.purchase_date||today)} (âm lịch)`:`${dateText(f.purchase_date)} (dương lịch)`}</button>
                :<span className="muted" style={{fontSize:12,padding:'6px 0'}}>Chọn NCC để đặt ngày</span>}
            </div>
          </div>

          <label className="kg-multiline-field"><span className="muted">Tổng kg thịt xô</span><textarea ref={rawWeightRef} className="input lots-kg-textarea" rows="5" wrap="soft" placeholder={"Nhập nhiều dòng, ví dụ:\n90.5\n75.8\n64.2"} value={f.raw_weight_expr??''} onChange={e=>setField('raw_weight_expr',e.target.value)}/><small className="muted">Có thể nhập xuống dòng hoặc dùng dấu +, ví dụ: 90.5 + 75.8</small></label>
          <label className="kg-singleline-field"><span className="muted">Xương sườn kg, tự cộng 1/2 vào thịt xô</span><input ref={setNavRef(0)} onKeyDown={e=>onLotNavKey(e,0)} className="input" placeholder="Ví dụ: 100 + 80 - 5" value={f.bone_weight_expr??''} onChange={e=>setField('bone_weight_expr',e.target.value)}/><small className="muted">Nhập 1 dòng, có thể cộng/trừ trực tiếp. Hệ thống tự lấy tổng xương sườn / 2 cộng vào thịt xô.</small></label>

          <label><span className="muted">Tổng số con</span><input ref={setNavRef(1)} onKeyDown={e=>onLotNavKey(e,1)} className="input" placeholder="Ví dụ: 5 hoặc 3 + 2" value={f.total_animals??''} onChange={e=>setField('total_animals',e.target.value)}/></label>
          <label><span className="muted">Số bò cái</span><input ref={setNavRef(2)} onKeyDown={e=>onLotNavKey(e,2)} className="input" placeholder="Ví dụ: 1 hoặc 2 - 1" value={f.female_animals??''} onChange={e=>setField('female_animals',e.target.value)}/></label>
          <label><span className="muted">Số bò đực tự tính</span><input className="input" readOnly value={maleAnimals}/></label>
          <label><span className="muted">Cách tính trừ xô</span><select ref={setNavRef(3)} onKeyDown={e=>onLotNavKey(e,3)} className="select" value={f.deduct_mode||'PER_ANIMAL'} onChange={e=>setField('deduct_mode',e.target.value)}><option value="PER_ANIMAL">Theo số con × kg/con</option><option value="TOTAL_KG">Nhập tổng kg trừ xô</option></select></label>

          {f.deduct_mode==='TOTAL_KG'
            ? <label className="kg-multiline-field"><span className="muted">Tổng kg trừ xô nhập tay</span><textarea ref={setNavRef(4)} onKeyDown={e=>{if(e.key!=='Enter')onLotNavKey(e,4)}} className="input lots-kg-textarea" rows="3" wrap="soft" placeholder={"Ví dụ:\n6\n7\n6"} value={f.deducted_weight_expr??''} onChange={e=>setField('deducted_weight_expr',e.target.value)}/><small className="muted">Có thể nhập mỗi số một dòng.</small></label>
            : <label><span className="muted">Kg trừ xô / con</span><input ref={setNavRef(4)} onKeyDown={e=>onLotNavKey(e,4)} className="input" placeholder="Ví dụ: 6 hoặc 7 - 1" value={f.deduct_kg_per_animal??''} onChange={e=>setField('deduct_kg_per_animal',e.target.value)}/></label>
          }
          <label><span className="muted">Tổng kg trừ xô đã tính</span><input className="input" readOnly value={`${deductedWeight} kg`}/></label>

          <label><span className="muted">Giá bò xô đực / kg</span><MoneyInput placeholder="208,000" value={f.male_price??''} onChange={v=>setField('male_price',v)}/></label>
          <label><span className="muted">Giá bò xô cái / kg</span><MoneyInput placeholder="195,000" value={f.female_price??''} onChange={v=>setField('female_price',v)}/></label>
          <label><span className="muted">Giá thịt vụn / kg</span><MoneyInput placeholder="100,000" value={f.fragment_price??''} onChange={v=>setField('fragment_price',v)}/></label>
          {priceSource&&<div className="muted" style={{fontSize:12,gridColumn:'1/-1',marginTop:-4}}>{priceSource==='PARTNER_PRICE'?'✓ Giá lấy từ bảng giá riêng của đối tác':'Giá lấy từ thông tin NCC cũ'}</div>}
          <label><span className="muted">Thịt vụn kg</span><input ref={setNavRef(5)} onKeyDown={e=>onLotNavKey(e,5)} className="input" placeholder="0 hoặc 2 + 1" value={f.fragment_weight??''} onChange={e=>setField('fragment_weight',e.target.value)}/><small className="muted">Tính tiền riêng, không trừ khỏi kg bò xô.</small></label>
        </div>

        <button className="btn secondary" style={{marginTop:10}} onClick={()=>setDeductOpen(!deductOpen)}>{deductOpen?'− Thu gọn khoản trừ':'+ Thêm khoản trừ bò hư/mỡ/khác'}</button>
        {deductOpen&&<div className="card" style={{boxShadow:'none',borderStyle:'dashed',marginTop:10}}>
          <h3>Khoản trừ chi tiết</h3>
          <div className="form-grid">
            <label><span className="muted">Trừ bò hư kg</span><input className="input" placeholder="0 hoặc 2 + 1" value={f.damage_weight??''} onChange={e=>setField('damage_weight',e.target.value)}/></label>
            <label><span className="muted">Trừ mỡ kg</span><input className="input" placeholder="0 hoặc 1.5 + 0.5" value={f.fat_weight??''} onChange={e=>setField('fat_weight',e.target.value)}/></label>
            <label><span className="muted">Trừ khác kg</span><input className="input" placeholder="0 hoặc 3 - 1" value={f.other_deduct_weight??''} onChange={e=>setField('other_deduct_weight',e.target.value)}/></label>
            <label><span className="muted">Lý do trừ khác</span><input className="input" placeholder="Ví dụ: trừ da, trừ nước, trừ hao..." value={f.deduct_note||''} onChange={e=>setField('deduct_note',e.target.value)}/></label>
          </div>
        </div>}

          </div>
          <aside ref={summarySlotRef} className="lots-sticky-summary" aria-label="Bảng tính tiền lô nhập">
        <div className="lots-sticky-panel" style={summaryFloatStyle}>
        <div className="card lots-calc-card" style={{boxShadow:'none',background:'#fff7ed',marginTop:12}}>
          <b>Cách tính:</b><br/>
          Thịt xô {rawWeight} + xương sườn {boneWeight}/2 = +{ribToMeatWeight}kg
          <br/>
          Trừ xô {f.deduct_mode==='TOTAL_KG'?'nhập tổng':'theo số con'}: {deductedWeight}kg
          <br/>
          Trừ bò hư {damageWeight} - trừ mỡ {fatWeight} - khác {otherDeductWeight}
          <br/>
          Thịt vụn {fragmentWeight}kg × {money(fragmentPrice)} tính riêng
          <h3>Kg bò xô tính tiền: {finalWeight}</h3>
          <div className="lots-price-split">
            <div>Bò đực: {animal(maleAnimals)} con = {kg1(maleWeight)}kg × {money(malePrice)}</div>
            <div>Bò cái: {animal(femaleAnimals)} con = {kg1(femaleWeight)}kg × {money(femalePrice)}</div>
            <div>Thịt vụn: {fragmentWeight}kg × {money(fragmentPrice)} = {money(fragmentCost)}</div>
          </div>
          <h3>Thành tiền: {money(totalCost)}</h3>
        </div>
        <button className="btn lots-save-btn" disabled={saving} onClick={save}>{saving?'Đang lưu...':(editingLotId?'Cập nhật nhập hàng':'Lưu nhập hàng')}</button>
        {editingLotId&&<button className="btn secondary" style={{marginTop:6,width:'100%'}} onClick={cancelEditMode}>Hủy sửa</button>}
        {saveStatus&&<div className={`lots-save-status ${saveStatus.type}`}>{saveStatus.message}</div>}
        </div>
          </aside>
        </div>
      </div>

      <div className="card">
        <h3>Thống kê nhập hàng</h3>
        <div className="report-tabs">
          <button className={`btn ${reportTab==='DETAIL'?'':'secondary'}`} onClick={()=>setReportTab('DETAIL')}>Chi tiết nhập hàng</button>
          <button className={`btn ${reportTab==='SUMMARY'?'':'secondary'}`} onClick={()=>setReportTab('SUMMARY')}>Tổng hợp nhập hàng</button>
        </div>
        <div className="form-grid supplier-report-filter">
          <label><span className="muted">Từ ngày</span><input className="input" type="date" value={reportFilter.from} onChange={e=>setReportFilter({...reportFilter,from:e.target.value})}/></label>
          <label><span className="muted">Đến ngày</span><input className="input" type="date" value={reportFilter.to} onChange={e=>setReportFilter({...reportFilter,to:e.target.value})}/></label>
          <label><span className="muted">Nhà cung cấp</span><select className="select" value={reportFilter.supplier_id} onChange={e=>setReportFilter({...reportFilter,supplier_id:e.target.value})}><option value="">Tất cả NCC</option>{s.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
          <div className="actions" style={{alignItems:'end'}}>
            {reportTab==='DETAIL'?<button className="btn secondary" disabled={!reportRows.length} onClick={printDetail}>🖨 In chi tiết</button>:<button className="btn secondary" disabled={!summaryRows.length} onClick={printSummary}>🖨 In tổng hợp</button>}
          </div>
        </div>
        <p className="muted" style={{marginTop:0}}>Ngày lập phiếu là ngày thao tác trên hệ thống. Ngày nhập hàng là ngày tính phiếu theo lịch của NCC; nếu NCC dùng âm lịch sẽ hiển thị dạng 15/06/2026 (01/04/2026 âm lịch).</p>
        <div className="lots-stat-grid">
          <div><span>Tổng lô</span><b>{detailTotals.lots}</b></div>
          <div><span>Tổng số con</span><b>{animal(detailTotals.animals)}</b></div>
          <div><span>Bò đực</span><b>{animal(detailTotals.maleAnimals)} con / {kg(detailTotals.maleWeight)}kg</b></div>
          <div><span>Bò cái</span><b>{animal(detailTotals.femaleAnimals)} con / {kg(detailTotals.femaleWeight)}kg</b></div>
          <div><span>Trừ xô</span><b>{kg(detailTotals.deduct)}kg</b></div>
          <div><span>Xương sườn</span><b>{kg(detailTotals.rib)}kg</b></div>
          <div><span>Thịt vụn</span><b>{kg(detailTotals.fragment)}kg / {money(detailTotals.fragmentMoney)}</b></div>
          <div><span>Kg thực tính</span><b>{kg(detailTotals.final)}kg</b></div>
          <div><span>Tiền bò đực</span><b>{money(detailTotals.maleMoney)}</b></div>
          <div><span>Tiền bò cái</span><b>{money(detailTotals.femaleMoney)}</b></div>
          <div><span>Tổng thành tiền</span><b>{money(detailTotals.cost)}</b></div>
        </div>

        <h3>Danh sách phiếu nhập / Thanh toán NCC</h3>
        <table className="table"><thead><tr><th>NCC</th><th>Kg</th><th>Thành tiền</th><th>Còn trả</th><th></th></tr></thead><tbody>{reportRows.length===0?<tr><td colSpan="5" className="muted" style={{textAlign:'center'}}>Không có dữ liệu trong khoảng ngày đã chọn.</td></tr>:reportRows.map(r=><tr key={r.id}><td>{r.supplier_name}</td><td>{r.total_weight}kg</td><td>{money(r.total_cost)}</td><td><b>{money(r.remaining_amount)}</b></td><td><button className="btn secondary" onClick={()=>print(r.id)}>In</button><button className="btn secondary" style={{marginLeft:4}} disabled={r.status!=='OPEN'} title={r.status!=='OPEN'?'Phiếu đã chốt hoặc đã hủy.':undefined} onClick={()=>loadLotIntoForm(r)}>Sửa</button>{r.status==='OPEN'&&<button className="btn secondary" style={{marginLeft:4}} onClick={()=>closeLot(r.id,r.lot_code)}>Chốt</button>}</td></tr>)}</tbody></table>
        <h3>Ứng / trả tiền nhà cung cấp</h3>
        <div className="form-grid">
          <select className="select" value={pay.lot_id||''} onChange={e=>setPay({...pay,lot_id:e.target.value})}><option value="">Chọn lô</option>{rows.map(r=><option key={r.id} value={r.id}>{r.lot_code} - còn {money(r.remaining_amount)}</option>)}</select>
          <input className="input" type="date" value={pay.payment_date} onChange={e=>setPay({...pay,payment_date:e.target.value})}/>
          <MoneyInput placeholder="Số tiền" value={pay.amount??''} onChange={v=>setPay({...pay,amount:v})}/>
          <select className="select" value={pay.type} onChange={e=>setPay({...pay,type:e.target.value})}><option value="ADVANCE">Ứng</option><option value="PAYMENT">Trả đủ / trả thêm</option></select>
        </div>
        <button className="btn secondary" style={{marginTop:10,marginRight:8}} disabled={!pay.lot_id} onClick={fillFull}>Trả đủ</button>
        <button className="btn" style={{marginTop:10}} disabled={!pay.lot_id||!pay.amount} onClick={payLot}>Lưu thanh toán NCC</button>
      </div>
    </div>
  </SafePage>;
}
