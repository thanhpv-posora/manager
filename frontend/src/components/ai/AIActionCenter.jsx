import React,{useEffect,useMemo,useState}from'react';
import {Bot,RefreshCw,PackagePlus,CheckCircle2,XCircle,AlertTriangle,Users,BarChart3,ShoppingCart} from'lucide-react';
import api from'../../api/api';

const money=n=>Number(n||0).toLocaleString('vi-VN')+'đ';
const qty=n=>Number(n||0).toLocaleString('vi-VN',{maximumFractionDigits:3});

function getSessionId(){
  const key='meatbiz_ai_session_id';
  let id=localStorage.getItem(key);
  if(!id){
    id='WEB_'+Date.now()+'_'+Math.random().toString(16).slice(2,8);
    localStorage.setItem(key,id);
  }
  return id;
}

function normalize(raw){
  const data=raw?.data||raw||{};
  return data?.data||data;
}

function ActionCard({icon,title,desc,button,onClick,loading,tone='orange'}){
  return <div className={'ai-action-card tone-'+tone}>
    <div className="ai-action-icon">{icon}</div>
    <div className="ai-action-body">
      <b>{title}</b>
      <span>{desc}</span>
    </div>
    {button&&<button className="btn small" onClick={onClick} disabled={loading}>{button}</button>}
  </div>;
}

export default function AIActionCenter({anonymizeDebtors=false}){
  const sessionId=useMemo(getSessionId,[]);
  const[loading,setLoading]=useState(false);
  const[error,setError]=useState('');
  const[summary,setSummary]=useState(null);
  const[draft,setDraft]=useState(null);
  const[notice,setNotice]=useState('');

  const ask=async(message,{asDraft=false}={})=>{
    setLoading(true);setError('');setNotice('');
    try{
      const r=await api.post('/ai/chat',{session_id:sessionId,message});
      const data=normalize(r.data);
      if(asDraft||data?.intent==='AI_SUPPLIER_ORDER_DRAFT') setDraft(data);
      else setSummary(data);
      if(data?.intent==='AI_SUPPLIER_ORDER_CONFIRM'||data?.purchase_order_ids) setNotice(data?.text||'Đã tạo phiếu mua hàng.');
      return data;
    }catch(e){
      setError(e.response?.data?.message||e.message||'AI xử lý lỗi');
    }finally{setLoading(false)}
  };

  useEffect(()=>{ask('tom tat dieu hanh hom nay')},[]);

  const today=summary?.today||{};
  const lowStock=summary?.low_stock||[];
  const topDebtors=summary?.top_debtors||[];
  const topProducts=summary?.top_products||[];
  const debtorLabel=(x,index)=>anonymizeDebtors?`Khách hàng ${String.fromCharCode(65+index)}`:(x?.name||`Khách hàng ${String.fromCharCode(65+index)}`);
  const hasLowStock=lowStock.length>0;
  const hasDebtors=topDebtors.length>0;
  const supplierGroups=draft?.supplier_groups||[];
  const canConfirm=!!draft?.requires_confirm||!!draft?.can_confirm;

  return <div className="card ai-action-center">
    <div className="ai-os-header">
      <div>
        <div className="ai-eyebrow"><Bot size={16}/> AI Operating Center</div>
        <h2>Điều hành hôm nay</h2>
        <p>AI đọc dữ liệu kinh doanh, báo việc cần làm và tạo nháp nghiệp vụ khi bạn xác nhận.</p>
      </div>
      <button className="btn secondary" onClick={()=>ask('tom tat dieu hanh hom nay')} disabled={loading}><RefreshCw size={16}/> Làm mới</button>
    </div>

    {error&&<div className="ai-error">{error}</div>}
    {notice&&<div className="ai-success">{notice}</div>}

    <div className="ai-kpi-strip">
      <div><span>Bill hôm nay</span><b>{Number(today.total_orders||0).toLocaleString('vi-VN')}</b></div>
      <div><span>Doanh thu</span><b>{money(today.total_amount)}</b></div>
      <div><span>Đã thu</span><b>{money(today.paid_amount)}</b></div>
      <div><span>Công nợ mới</span><b>{money(today.debt_amount)}</b></div>
    </div>

    <div className="ai-action-stack">
      {hasLowStock&&<ActionCard tone="red" icon={<PackagePlus size={22}/>} title={`Có ${lowStock.length} mặt hàng dưới ngưỡng`} desc={`${lowStock.slice(0,2).map(x=>`${x.product_name} còn ${qty(x.stock_quantity)}${x.unit}`).join(' • ')}`} button="Lập nháp nhập hàng" loading={loading} onClick={()=>ask('nen nhap hang gi tuan toi',{asDraft:true})}/>} 
      {hasDebtors&&<ActionCard tone="yellow" icon={<Users size={22}/>} title="Khách nợ cần chú ý" desc={`${debtorLabel(topDebtors[0],0)} đang nợ ${money(topDebtors[0]?.debt_amount)}`} button="Xem công nợ" loading={loading} onClick={()=>setNotice('Mở menu Công nợ để xử lý chi tiết. Bước sau sẽ gắn nút nhắc nợ tự động.')}/>} 
      {!hasLowStock&&!hasDebtors&&<ActionCard tone="green" icon={<CheckCircle2 size={22}/>} title="Hệ thống ổn" desc="Chưa thấy cảnh báo lớn từ dữ liệu hôm nay." button="Dự báo tồn kho" loading={loading} onClick={()=>ask('du bao ton kho 7 ngay toi')}/>} 
      <ActionCard tone="blue" icon={<BarChart3 size={22}/>} title="Hỏi AI nhanh" desc="Tóm tắt, dự báo tồn kho, đề xuất nhập hàng bằng một nút." button="Tóm tắt lại" loading={loading} onClick={()=>ask('tom tat dieu hanh hom nay')}/>
    </div>

    {draft&&<div className="ai-draft-clean">
      <div className="ai-draft-head">
        <div><b><ShoppingCart size={17}/> Nháp phiếu mua hàng</b><span>{draft?.draft_session_id?`Draft #${draft.draft_session_id}`:'Chờ xác nhận'}</span></div>
        <b>{money(draft.total_amount)}</b>
      </div>
      {supplierGroups.map(g=><div className="ai-draft-supplier" key={g.supplier_id||g.supplier_name}>
        <div className="ai-draft-supplier-name">{g.supplier_name||'Chưa có nhà cung cấp'}</div>
        {(g.items||[]).map(x=><div className="ai-draft-line" key={x.product_id}>
          <div><b>{x.product_name}</b><span>Tồn {qty(x.stock_quantity)} {x.unit} • bán TB {qty(x.avg_daily_sale)}/ngày</span></div>
          <div className="ai-draft-qty">{qty(x.quantity)} {x.unit}<span>{money(x.total_price)}</span></div>
        </div>)}
      </div>)}
      {canConfirm&&<div className="ai-draft-actions">
        <button className="btn" disabled={loading} onClick={()=>ask('ok')}><CheckCircle2 size={16}/> Xác nhận tạo phiếu</button>
        <button className="btn secondary" disabled={loading} onClick={()=>ask('huy')}><XCircle size={16}/> Huỷ</button>
      </div>}
    </div>}

    <div className="ai-simple-lists">
      {topProducts.length>0&&<div><b>Bán chạy</b>{topProducts.slice(0,4).map(x=><p key={x.product_id}>{x.product_name}: {qty(x.sold_qty)} {x.unit}</p>)}</div>}
      {lowStock.length>0&&<div><b>Hàng thiếu</b>{lowStock.slice(0,4).map(x=><p key={x.product_id}>{x.product_name}: còn {qty(x.stock_quantity)} {x.unit}</p>)}</div>}
      {topDebtors.length>0&&<div><b>Nợ cao</b>{topDebtors.slice(0,4).map((x,i)=><p key={x.id}>{debtorLabel(x,i)}: {money(x.debt_amount)}</p>)}</div>}
    </div>
  </div>;
}
