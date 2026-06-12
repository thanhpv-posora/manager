import React,{useEffect,useRef,useState}from'react';
import api from'../api/api';
import SafePage from'../components/SafePage';
import MoneyInput from'../components/MoneyInput';
import {calcExpression} from'../utils/expr';
import {formatLunarDate} from'../utils/lunarDate';

const money=n=>Number(n||0).toLocaleString('en-US')+'đ';
const n=v=>Number(v||0);

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
    raw_weight_expr:'0',
    bone_weight_expr:'',
    deduct_mode:'PER_ANIMAL',
    total_animals:'',
    female_animals:'',
    deduct_kg_per_animal:'6',
    deducted_weight_expr:'',
    damage_weight:'',
    fat_weight:'',
    other_deduct_weight:'',
    male_price:200000,
    female_price:195000,
    purchase_price:200000
  });
  const[deductOpen,setDeductOpen]=useState(false);
  const[pay,setPay]=useState({payment_date:today,type:'ADVANCE',payment_method:'CASH'});
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState('');
  const[saving,setSaving]=useState(false);
  const[saveStatus,setSaveStatus]=useState(null);

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
      lunar_date_text:type==='LUNAR'?formatLunarDate(purchaseDate||today):''
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

  const totalAnimals=qtyValue(f.total_animals);
  const femaleAnimals=qtyValue(f.female_animals);
  const maleAnimals=Math.max(0,totalAnimals-femaleAnimals);
  const deductKgPerAnimal=qtyValue(f.deduct_kg_per_animal);
  const manualDeductWeight=qtyValue(f.deducted_weight_expr);
  const deductedWeight=f.deduct_mode==='TOTAL_KG'
    ? manualDeductWeight
    : totalAnimals*deductKgPerAnimal;

  const damageWeight=qtyValue(f.damage_weight);
  const fatWeight=qtyValue(f.fat_weight);
  const otherDeductWeight=qtyValue(f.other_deduct_weight);
  const finalWeight=rawWeight+ribToMeatWeight-deductedWeight-damageWeight-fatWeight-otherDeductWeight;

  const malePrice=n(f.male_price||f.purchase_price);
  const femalePrice=n(f.female_price||f.purchase_price);
  const maleRatio=totalAnimals>0?maleAnimals/totalAnimals:1;
  const femaleRatio=totalAnimals>0?femaleAnimals/totalAnimals:0;
  const maleWeight=finalWeight*maleRatio;
  const femaleWeight=finalWeight*femaleRatio;
  const totalCost=maleWeight*malePrice+femaleWeight*femalePrice;

  const stats=rows.reduce((a,r)=>({
    count:a.count+1,
    animals:a.animals+n(r.total_animals),
    male:a.male+n(r.male_animals),
    female:a.female+n(r.female_animals),
    raw:a.raw+n(r.raw_weight),
    rib:a.rib+n(r.bone_weight),
    ribMeat:a.ribMeat+n(r.bone_weight)/2,
    deduct:a.deduct+n(r.deducted_weight),
    final:a.final+n(r.total_weight),
    cost:a.cost+n(r.total_cost)
  }),{count:0,animals:0,male:0,female:0,raw:0,rib:0,ribMeat:0,deduct:0,final:0,cost:0});

  const resetSupplier=()=>{setEditingSupplier(null);setSupplier({billing_calendar_type:'SOLAR',is_active:1})};
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
    setSaving(true);
    setSaveStatus(null);
    try{
      const res=await api.post('/lots',{
        ...f,
        raw_weight:rawWeight,
        bone_weight:boneWeight,
        deducted_weight:deductedWeight,
        damage_weight:damageWeight,
        fat_weight:fatWeight,
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
        total_cost:totalCost
      });
      setF(prev=>({...prev,lot_name:'',raw_weight_expr:'0'}));
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
          </div>
          <div className="actions" style={{marginTop:10}}>
            <button className="btn secondary" onClick={saveSupplier}>{editingSupplier?'Lưu sửa NCC':'+ Thêm NCC'}</button>
            <button className="btn secondary" onClick={resetSupplier}>Làm mới</button>
          </div>
        </>}

        {supplierListOpen&&<table className="table"><tbody>{s.map(x=><tr key={x.id}><td>{x.name}<br/><span className="muted">{x.phone}</span><br/><span className="badge">{x.billing_calendar_type==='LUNAR'?'Âm lịch':'Dương lịch'}</span></td><td><button className="btn secondary" onClick={()=>editSupplier(x)}>Sửa</button> <button className="btn danger" onClick={()=>deleteSupplier(x.id)}>Xóa mềm</button></td></tr>)}</tbody></table>}

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

          <label><span className="muted">Giá bò đực / kg</span><MoneyInput placeholder="200,000" value={f.male_price??''} onChange={v=>setField('male_price',v)}/></label>
          <label><span className="muted">Giá bò cái / kg</span><MoneyInput placeholder="195,000" value={f.female_price??''} onChange={v=>setField('female_price',v)}/></label>
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
          <h3>Kg tính tiền: {finalWeight}</h3>
          <div className="lots-price-split">
            <div>Bò đực: {maleAnimals} con ≈ {maleWeight.toFixed(3)}kg × {money(malePrice)}</div>
            <div>Bò cái: {femaleAnimals} con ≈ {femaleWeight.toFixed(3)}kg × {money(femalePrice)}</div>
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
        <div className="lots-stat-grid">
          <div><span>Tổng lô</span><b>{stats.count}</b></div>
          <div><span>Tổng số con</span><b>{stats.animals}</b></div>
          <div><span>Bò đực</span><b>{stats.male}</b></div>
          <div><span>Bò cái</span><b>{stats.female}</b></div>
          <div><span>Kg thịt xô</span><b>{stats.raw.toFixed(3)}</b></div>
          <div><span>Xương sườn / 2</span><b>{stats.ribMeat.toFixed(3)}</b></div>
          <div><span>Kg trừ xô</span><b>{stats.deduct.toFixed(3)}</b></div>
          <div><span>Kg tính tiền</span><b>{stats.final.toFixed(3)}</b></div>
          <div><span>Tổng tiền</span><b>{money(stats.cost)}</b></div>
        </div>

        <h3>Lô nhập / thanh toán NCC</h3>
        <table className="table"><thead><tr><th>Lô</th><th>Kg</th><th>Thành tiền</th><th>Còn trả</th><th></th></tr></thead><tbody>{rows.map(r=><tr key={r.id}><td>{r.lot_code}<br/>{r.lot_name}<br/><span className="muted">{r.supplier_name}</span></td><td>{r.total_weight}kg<br/><span className="muted">{r.total_animals||0} con, cái {r.female_animals||0}</span></td><td>{money(r.total_cost)}</td><td><b>{money(r.remaining_amount)}</b></td><td><button className="btn secondary" onClick={()=>print(r.id)}>In NCC</button></td></tr>)}</tbody></table>
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
