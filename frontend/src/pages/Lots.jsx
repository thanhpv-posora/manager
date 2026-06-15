import React,{useEffect,useRef,useState}from'react';
import api from'../api/api';
import SafePage from'../components/SafePage';
import MoneyInput from'../components/MoneyInput';
import {calcExpression} from'../utils/expr';
import {formatLunarDate} from'../utils/lunarDate';

const money=n=>Number(n||0).toLocaleString('en-US')+'đ';
const n=v=>Number(v||0);
const floor1=v=>Math.floor((Number(v)||0)*10)/10;
const animal=v=>floor1(v).toLocaleString('en-US',{minimumFractionDigits:1,maximumFractionDigits:1});
const kg1=v=>Number(v||0).toLocaleString('en-US',{minimumFractionDigits:1,maximumFractionDigits:1});

export default function Lots(){
  const today=new Date().toISOString().slice(0,10);
  const[rows,setRows]=useState([]);
  const[s,setS]=useState([]);
  const[supplier,setSupplier]=useState({});
  const[editingSupplier,setEditingSupplier]=useState(null);
  const[supplierOpen,setSupplierOpen]=useState(false);
  const[supplierListOpen,setSupplierListOpen]=useState(false);
  const[f,setF]=useState({
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
  const[deductOpen,setDeductOpen]=useState(false);
  const[pay,setPay]=useState({payment_date:today,type:'ADVANCE',payment_method:'CASH'});
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState('');
  const[saving,setSaving]=useState(false);
  const[saveStatus,setSaveStatus]=useState(null);
  const[reportTab,setReportTab]=useState('DETAIL');
  const[reportFilter,setReportFilter]=useState({from:today,to:today,supplier_id:''});

  const setField=(k,v)=>setF(prev=>({...prev,[k]:v}));
  const selectedSupplier=s.find(x=>String(x.id)===String(f.supplier_id||''));
  const selectedSupplierCalendar=String(selectedSupplier?.billing_calendar_type||f.calendar_type||'SOLAR').toUpperCase()==='LUNAR'?'LUNAR':'SOLAR';
  const selectedSupplierCalendarLabel=selectedSupplierCalendar==='LUNAR'?'Âm lịch':'Dương lịch';

  const applySupplierCalendarToLot=(supplierId,purchaseDate=f.purchase_date)=>{
    const sp=s.find(x=>String(x.id)===String(supplierId||''));
    const type=String(sp?.billing_calendar_type||'SOLAR').toUpperCase()==='LUNAR'?'LUNAR':'SOLAR';
    setF(prev=>({
      ...prev,
      supplier_id:supplierId,
      purchase_date:purchaseDate,
      calendar_type:type,
      lunar_date_text:type==='LUNAR'?formatLunarDate(purchaseDate||today):'',
      male_price:n(sp?.male_price)||prev.male_price||prev.purchase_price||200000,
      female_price:n(sp?.female_price)||prev.female_price||prev.purchase_price||195000,
      fragment_price:n(sp?.fragment_price)||prev.fragment_price||100000
    }));
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
    try{
      const res=await api.post('/lots',{
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
      });
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
      await load();
    }catch(e){
      const msg=e.response?.data?.message||e.message||'Lưu lô nhập thất bại';
      setSaveStatus({type:'error',message:msg});
    }finally{
      setSaving(false);
    }
  };

  const print=id=>window.open((import.meta.env.VITE_API_URL||(typeof window !== 'undefined' ? `${window.location.origin}/api` : '/api'))+'/lots/public/'+id+'/print','_blank');
  const payLot=async()=>{
    if(!pay.lot_id||!pay.amount)return alert('Chọn lô và nhập số tiền');
    await api.post('/lots/'+pay.lot_id+'/payments',pay);
    setPay({...pay,amount:''});
    load();
  };
  const fillFull=()=>{const lot=rows.find(r=>String(r.id)===String(pay.lot_id));if(lot)setPay({...pay,type:'PAYMENT',amount:lot.remaining_amount})};

  const kg=v=>Number(v||0).toLocaleString('en-US',{maximumFractionDigits:3});
  const dateText=v=>v?String(v).slice(0,10):'';
  const lotCalendarType=r=>String(r?.calendar_type||r?.supplier_billing_calendar_type||'SOLAR').toUpperCase()==='LUNAR'?'LUNAR':'SOLAR';
  const lotBillDateText=r=>{
    const type=lotCalendarType(r);
    if(type==='LUNAR'){
      const lunar=String(r?.lunar_date_text||'').trim() || formatLunarDate(dateText(r?.purchase_date));
      return lunar ? `${lunar} ÂL` : '';
    }
    const d=dateText(r?.purchase_date);
    return d ? `${d} DL` : '';
  };
  const reportRows=rows.filter(r=>{
    const d=dateText(r.purchase_date);
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
    if(!m[key])m[key]={supplier_id:key,supplier_name:r.supplier_name||'Không rõ NCC',lots:0,animals:0,maleAnimals:0,femaleAnimals:0,maleWeight:0,maleMoney:0,femaleWeight:0,femaleMoney:0,deduct:0,rib:0,ribMoney:0,fragment:0,fragmentMoney:0,final:0,cost:0};
    const x=m[key];
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

  const reportRangeText=`Theo ngày lập phiếu: từ ${reportFilter.from||'...'} đến ${reportFilter.to||'...'}`;
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
    const rowsHtml=reportRows.map((r,i)=>`<tr><td class="center">${i+1}</td><td class="center">${dateText(r.purchase_date)}</td><td class="center">${lotBillDateText(r)}</td><td class="left">${r.lot_code||''}</td><td class="left">${r.supplier_name||''}</td><td>${animal(r.total_animals)}</td><td>${animal(r.male_animals)}</td><td>${kg(r.male_weight)}</td><td>${money(r.male_price||r.purchase_price)}</td><td>${money(n(r.male_weight)*n(r.male_price||r.purchase_price))}</td><td>${animal(r.female_animals)}</td><td>${kg(r.female_weight)}</td><td>${money(r.female_price||r.purchase_price)}</td><td>${money(n(r.female_weight)*n(r.female_price||r.purchase_price))}</td><td>${kg(r.deducted_weight)}</td><td>${kg(r.bone_weight)}</td><td>${kg(r.fragment_weight)}</td><td>${money(r.fragment_price)}</td><td>${money(r.fragment_cost||n(r.fragment_weight)*n(r.fragment_price))}</td><td>${kg(r.total_weight)}</td><td>${money(r.total_cost)}</td></tr>`).join('');
    const html=`<table><thead><tr><th rowspan="2">STT</th><th rowspan="2">Ngày lập<br/>phiếu</th><th rowspan="2">Ngày tính<br/>phiếu</th><th rowspan="2">Số phiếu</th><th rowspan="2">NCC</th><th rowspan="2">Tổng<br/>con</th><th colspan="4">Bò đực</th><th colspan="4">Bò cái</th><th rowspan="2">Trừ xô<br/>kg</th><th rowspan="2">Xương<br/>sườn kg</th><th colspan="3">Thịt vụn</th><th rowspan="2">Kg thực<br/>tính</th><th rowspan="2">Thành tiền</th></tr><tr><th>Con</th><th>Kg</th><th>Giá</th><th>Tiền</th><th>Con</th><th>Kg</th><th>Giá</th><th>Tiền</th><th>Kg</th><th>Giá</th><th>Tiền</th></tr></thead><tbody>${rowsHtml}</tbody><tfoot><tr><td colspan="5" class="center">TỔNG CỘNG</td><td>${animal(detailTotals.animals)}</td><td>${animal(detailTotals.maleAnimals)}</td><td>${kg(detailTotals.maleWeight)}</td><td></td><td>${money(detailTotals.maleMoney)}</td><td>${animal(detailTotals.femaleAnimals)}</td><td>${kg(detailTotals.femaleWeight)}</td><td></td><td>${money(detailTotals.femaleMoney)}</td><td>${kg(detailTotals.deduct)}</td><td>${kg(detailTotals.rib)}</td><td>${kg(detailTotals.fragment)}</td><td></td><td>${money(detailTotals.fragmentMoney)}</td><td>${kg(detailTotals.final)}</td><td>${money(detailTotals.cost)}</td></tr></tfoot></table>`;
    printHtml('THỐNG KÊ CHI TIẾT NHẬP LÔ / NHÀ CUNG CẤP',html);
  };
  const printSummary=()=>{
    const rowsHtml=summaryRows.map((r,i)=>`<tr><td class="center">${i+1}</td><td class="left">${r.supplier_name}</td><td>${kg(r.lots)}</td><td>${animal(r.animals)}</td><td>${animal(r.maleAnimals)}</td><td>${kg(r.maleWeight)}</td><td>${money(r.maleMoney)}</td><td>${animal(r.femaleAnimals)}</td><td>${kg(r.femaleWeight)}</td><td>${money(r.femaleMoney)}</td><td>${kg(r.deduct)}</td><td>${kg(r.rib)}</td><td>${kg(r.fragment)}</td><td>${money(r.fragmentMoney)}</td><td>${kg(r.final)}</td><td>${money(r.cost)}</td></tr>`).join('');
    const html=`<table><thead><tr><th>STT</th><th>NCC</th><th>Số lô</th><th>Tổng con</th><th>Đực con</th><th>Đực kg</th><th>Tiền đực</th><th>Cái con</th><th>Cái kg</th><th>Tiền cái</th><th>Trừ xô kg</th><th>Xương sườn kg</th><th>Vụn kg</th><th>Tiền vụn</th><th>Kg thực tính</th><th>Tổng thành tiền</th></tr></thead><tbody>${rowsHtml}</tbody><tfoot><tr><td colspan="2" class="center">TỔNG CỘNG</td><td>${kg(detailTotals.lots)}</td><td>${animal(detailTotals.animals)}</td><td>${animal(detailTotals.maleAnimals)}</td><td>${kg(detailTotals.maleWeight)}</td><td>${money(detailTotals.maleMoney)}</td><td>${animal(detailTotals.femaleAnimals)}</td><td>${kg(detailTotals.femaleWeight)}</td><td>${money(detailTotals.femaleMoney)}</td><td>${kg(detailTotals.deduct)}</td><td>${kg(detailTotals.rib)}</td><td>${kg(detailTotals.fragment)}</td><td>${money(detailTotals.fragmentMoney)}</td><td>${kg(detailTotals.final)}</td><td>${money(detailTotals.cost)}</td></tr></tfoot></table>`;
    printHtml('THỐNG KÊ TỔNG HỢP NHẬP LÔ / NHÀ CUNG CẤP',html);
  };

  return <SafePage loading={loading} error={error}>
    <div className="grid cols-2 lots-agent-page">
      <div className="card lots-entry-card">
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

        <h3>Nhập lô bò</h3>
        <p className="muted">Các ô số lượng/kg có thể cộng trừ trực tiếp, ví dụ: <b>90.5+75.8-2</b>. Riêng Tổng kg thịt xô có thể nhập nhiều dòng. Xương sườn giữ 1 dòng và tự quy đổi: <b>kg xương sườn / 2</b> rồi cộng vào thịt xô.</p>

        <div className="lots-entry-layout">
          <div className="lots-entry-fields">
            <div className="form-grid">
          <label><span className="muted">Tên lô</span><input className="input" placeholder="Tên lô" value={f.lot_name||''} onChange={e=>setField('lot_name',e.target.value)}/></label>
          <label><span className="muted">Ngày nhập</span><input className="input" type="date" value={f.purchase_date||''} onChange={e=>applySupplierCalendarToLot(f.supplier_id,e.target.value)}/></label>
          <label><span className="muted">Nhà cung cấp</span><select className="select" value={f.supplier_id||''} onChange={e=>applySupplierCalendarToLot(e.target.value,f.purchase_date)}><option value="">Chọn nhà cung cấp</option>{s.map(x=><option key={x.id} value={x.id}>{x.name} - {x.billing_calendar_type==='LUNAR'?'Âm lịch':'Dương lịch'}</option>)}</select></label>
          {selectedSupplierCalendar==='LUNAR'&&<label><span className="muted">Ngày âm lịch in trên phiếu NCC</span><input className="input" value={f.lunar_date_text||''} onChange={e=>setField('lunar_date_text',e.target.value)} placeholder="VD: 28/03/2026"/></label>}

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
        <button className="btn lots-save-btn" disabled={saving} onClick={save}>{saving?'Đang lưu...':'Lưu lô nhập'}</button>
        {saveStatus&&<div className={`lots-save-status ${saveStatus.type}`}>{saveStatus.message}</div>}
        </div>
          </aside>
        </div>
      </div>

      <div className="card">
        <h3>Thống kê Nhập lô / NCC</h3>
        <div className="report-tabs">
          <button className={`btn ${reportTab==='DETAIL'?'':'secondary'}`} onClick={()=>setReportTab('DETAIL')}>Chi tiết NCC</button>
          <button className={`btn ${reportTab==='SUMMARY'?'':'secondary'}`} onClick={()=>setReportTab('SUMMARY')}>Tổng hợp NCC</button>
        </div>
        <div className="form-grid supplier-report-filter">
          <label><span className="muted">Từ ngày</span><input className="input" type="date" value={reportFilter.from} onChange={e=>setReportFilter({...reportFilter,from:e.target.value})}/></label>
          <label><span className="muted">Đến ngày</span><input className="input" type="date" value={reportFilter.to} onChange={e=>setReportFilter({...reportFilter,to:e.target.value})}/></label>
          <label><span className="muted">Nhà cung cấp</span><select className="select" value={reportFilter.supplier_id} onChange={e=>setReportFilter({...reportFilter,supplier_id:e.target.value})}><option value="">Tất cả NCC</option>{s.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
          <div className="actions" style={{alignItems:'end'}}>
            {reportTab==='DETAIL'?<button className="btn secondary" disabled={!reportRows.length} onClick={printDetail}>🖨 In chi tiết</button>:<button className="btn secondary" disabled={!summaryRows.length} onClick={printSummary}>🖨 In tổng hợp</button>}
          </div>
        </div>
        <p className="muted" style={{marginTop:0}}>Ngày lập phiếu giữ theo ngày tạo/nhập. Cột Ngày tính phiếu lấy theo lịch của NCC: NCC âm lịch sẽ hiện ngày âm lịch, NCC dương lịch sẽ hiện ngày dương lịch.</p>
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

        {reportTab==='DETAIL'?<div className="table-scroll supplier-report-table"><table className="table compact"><thead><tr><th>Ngày lập</th><th>Ngày tính phiếu</th><th>Phiếu</th><th>NCC</th><th>Số con</th><th>Bò đực</th><th>Bò cái</th><th>Trừ xô</th><th>Xương sườn</th><th>Thịt vụn</th><th>Kg thực tính</th><th>Thành tiền</th></tr></thead><tbody>{reportRows.map(r=><tr key={r.id}><td>{dateText(r.purchase_date)}</td><td><b>{lotBillDateText(r)}</b><br/><span className="muted">{lotCalendarType(r)==='LUNAR'?'Âm lịch':'Dương lịch'}</span></td><td>{r.lot_code}</td><td>{r.supplier_name}</td><td>{animal(r.total_animals)}</td><td>{animal(r.male_animals)} con<br/>{kg(r.male_weight)}kg × {money(r.male_price||r.purchase_price)}<br/><b>{money(n(r.male_weight)*n(r.male_price||r.purchase_price))}</b></td><td>{animal(r.female_animals)} con<br/>{kg(r.female_weight)}kg × {money(r.female_price||r.purchase_price)}<br/><b>{money(n(r.female_weight)*n(r.female_price||r.purchase_price))}</b></td><td>{kg(r.deducted_weight)}kg</td><td>{kg(r.bone_weight)}kg</td><td>{kg(r.fragment_weight)}kg × {money(r.fragment_price)}<br/><b>{money(r.fragment_cost||n(r.fragment_weight)*n(r.fragment_price))}</b></td><td>{kg(r.total_weight)}kg</td><td><b>{money(r.total_cost)}</b></td></tr>)}</tbody><tfoot><tr><td colSpan="4">Tổng cộng</td><td>{animal(detailTotals.animals)}</td><td>{animal(detailTotals.maleAnimals)} con<br/>{kg(detailTotals.maleWeight)}kg<br/>{money(detailTotals.maleMoney)}</td><td>{animal(detailTotals.femaleAnimals)} con<br/>{kg(detailTotals.femaleWeight)}kg<br/>{money(detailTotals.femaleMoney)}</td><td>{kg(detailTotals.deduct)}kg</td><td>{kg(detailTotals.rib)}kg</td><td>{kg(detailTotals.fragment)}kg<br/>{money(detailTotals.fragmentMoney)}</td><td>{kg(detailTotals.final)}kg</td><td>{money(detailTotals.cost)}</td></tr></tfoot></table></div>:<div className="table-scroll supplier-report-table"><table className="table compact"><thead><tr><th>NCC</th><th>Số lô</th><th>Tổng con</th><th>Bò đực</th><th>Bò cái</th><th>Trừ xô</th><th>Xương sườn</th><th>Thịt vụn</th><th>Kg thực tính</th><th>Tổng thành tiền</th></tr></thead><tbody>{summaryRows.map(r=><tr key={r.supplier_id}><td>{r.supplier_name}</td><td>{kg(r.lots)}</td><td>{animal(r.animals)}</td><td>{animal(r.maleAnimals)} con<br/>{kg(r.maleWeight)}kg<br/><b>{money(r.maleMoney)}</b></td><td>{animal(r.femaleAnimals)} con<br/>{kg(r.femaleWeight)}kg<br/><b>{money(r.femaleMoney)}</b></td><td>{kg(r.deduct)}kg</td><td>{kg(r.rib)}kg</td><td>{kg(r.fragment)}kg<br/><b>{money(r.fragmentMoney)}</b></td><td>{kg(r.final)}kg</td><td><b>{money(r.cost)}</b></td></tr>)}</tbody><tfoot><tr><td>Tổng cộng</td><td>{kg(detailTotals.lots)}</td><td>{animal(detailTotals.animals)}</td><td>{animal(detailTotals.maleAnimals)} con<br/>{kg(detailTotals.maleWeight)}kg<br/>{money(detailTotals.maleMoney)}</td><td>{animal(detailTotals.femaleAnimals)} con<br/>{kg(detailTotals.femaleWeight)}kg<br/>{money(detailTotals.femaleMoney)}</td><td>{kg(detailTotals.deduct)}kg</td><td>{kg(detailTotals.rib)}kg</td><td>{kg(detailTotals.fragment)}kg<br/>{money(detailTotals.fragmentMoney)}</td><td>{kg(detailTotals.final)}kg</td><td>{money(detailTotals.cost)}</td></tr></tfoot></table></div>}

        <h3>Lô nhập / thanh toán NCC</h3>
        <table className="table"><thead><tr><th>Lô</th><th>Kg</th><th>Thành tiền</th><th>Còn trả</th><th></th></tr></thead><tbody>{rows.map(r=><tr key={r.id}><td>{r.lot_code}<br/>{r.lot_name}<br/><span className="muted">{r.supplier_name}</span></td><td>{r.total_weight}kg<br/><span className="muted">{animal(r.total_animals)} con, cái {animal(r.female_animals)}</span><br/><span className="muted">Vụn {Number(r.fragment_weight||0).toFixed(3)}kg × {money(r.fragment_price||0)}</span></td><td>{money(r.total_cost)}</td><td><b>{money(r.remaining_amount)}</b></td><td><button className="btn secondary" onClick={()=>print(r.id)}>In NCC</button></td></tr>)}</tbody></table>
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
