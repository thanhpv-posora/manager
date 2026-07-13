import React,{useMemo,useState}from'react';
import {Bot,Send,CheckCircle2,XCircle,PackagePlus,BarChart3,AlertTriangle,Users,ChevronDown,ChevronUp} from'lucide-react';
import api from'../../api/api';
import {formatQty}from'../../utils/quantity';

const money=n=>Number(n||0).toLocaleString('en-US')+'đ';
const qty=formatQty;

function getSessionId(){
  const key='meatbiz_ai_session_id';
  let id=localStorage.getItem(key);
  if(!id){
    id='WEB_'+Date.now()+'_'+Math.random().toString(16).slice(2,8);
    localStorage.setItem(key,id);
  }
  return id;
}

function normalizeMessage(raw){
  const data=raw?.data||raw||{};
  return data?.data||data;
}

export default function AIBusinessPanel({compact=false,title='AI điều hành MeatBiz',anonymizeDebtors=false}){
  const[message,setMessage]=useState('nen nhap hang gi tuan toi');
  const[loading,setLoading]=useState(false);
  const[error,setError]=useState('');
  const[result,setResult]=useState(null);
  const[history,setHistory]=useState([]);
  const[collapsed,setCollapsed]=useState(true);
  const sessionId=useMemo(getSessionId,[]);

  const send=async(text)=>{
    const msg=String(text||message||'').trim();
    if(!msg)return;
    setLoading(true);
    setError('');
    try{
      const r=await api.post('/ai/chat',{session_id:sessionId,message:msg});
      const next=normalizeMessage(r.data);
      setResult(next);
      setHistory(prev=>[{role:'user',text:msg},{role:'ai',text:next?.text||next?.message||'Đã xử lý',data:next},...prev].slice(0,8));
    }catch(e){
      const msgErr=e.response?.data?.message||e.message||'AI chat lỗi';
      setError(msgErr);
      setHistory(prev=>[{role:'user',text:msg},{role:'ai',text:msgErr,error:true},...prev].slice(0,8));
    }finally{
      setLoading(false);
    }
  };

  const draftItems=result?.items||[];
  const supplierGroups=result?.supplier_groups||[];
  const topProducts=result?.top_products||[];
  const lowStock=result?.low_stock||[];
  const topDebtors=result?.top_debtors||[];
  const debtorLabel=(x,index)=>anonymizeDebtors?`Khách hàng ${String.fromCharCode(65+index)}`:(x?.name||`Khách hàng ${String.fromCharCode(65+index)}`);
  const actions=result?.recommended_actions||[];
  const today=result?.today||null;
  const canConfirm=!!result?.requires_confirm||!!result?.can_confirm;

  return <div className={'card ai-business-panel '+(compact?'ai-compact ':'')+(collapsed?'ai-collapsed':'')}>
    <div className="ai-panel-head ai-collapsible-head" onClick={()=>setCollapsed(!collapsed)}>
      <div>
        <h3><Bot size={18}/> {title}</h3>
        {!collapsed&&<p className="muted">Dùng qua API /ai/chat: hỏi tồn kho, đề xuất nhập hàng, xác nhận tạo phiếu.</p>}
        {collapsed&&<p className="muted">Bấm mở khi cần hỏi tồn kho / đề xuất nhập hàng.</p>}
      </div>
      <div className="ai-head-actions">
        {!collapsed&&<span className="ai-session">{sessionId}</span>}
        <button type="button" className="btn secondary ai-toggle-btn" onClick={e=>{e.stopPropagation();setCollapsed(!collapsed)}}>{collapsed?<><ChevronDown size={16}/> Mở AI</>:<><ChevronUp size={16}/> Thu gọn</>}</button>
      </div>
    </div>

    {!collapsed&&<>
    <div className="ai-input-row">
      <input className="input" value={message} onChange={e=>setMessage(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')send()}} placeholder="Ví dụ: nên nhập hàng gì tuần tới"/>
      <button className="btn" onClick={()=>send()} disabled={loading}><Send size={16}/> {loading?'Đang xử lý':'Gửi AI'}</button>
    </div>

    <div className="actions ai-quick-actions">
      <button className="btn secondary" onClick={()=>send('nen nhap hang gi tuan toi')} disabled={loading}><PackagePlus size={16}/> Nên nhập hàng gì?</button>
      <button className="btn secondary" onClick={()=>send('du bao ton kho 7 ngay toi')} disabled={loading}>Dự báo tồn kho</button>
      <button className="btn secondary" onClick={()=>send('tom tat dieu hanh hom nay')} disabled={loading}><BarChart3 size={16}/> Tóm tắt hôm nay</button>
    </div>

    {error&&<p className="ai-error">{error}</p>}

    {result&&<div className="ai-result-box">
      <div className="ai-result-title">
        <b>{result.intent||'AI_RESULT'}</b>
        {result.draft_session_id&&<span>Draft #{result.draft_session_id}</span>}
      </div>
      <p>{result.text||result.message||'Đã xử lý.'}</p>



      {result?.intent==='AI_DASHBOARD_SUMMARY'&&<div className="ai-dashboard-summary">
        {today&&<div className="ai-summary-grid">
          <div className="ai-summary-card"><span>Bill hôm nay</span><b>{Number(today.total_orders||0).toLocaleString('en-US')}</b></div>
          <div className="ai-summary-card"><span>Doanh thu</span><b>{money(today.total_amount)}</b></div>
          <div className="ai-summary-card"><span>Đã thu</span><b>{money(today.paid_amount)}</b></div>
          <div className="ai-summary-card"><span>Công nợ mới</span><b>{money(today.debt_amount)}</b></div>
        </div>}

        {actions.length>0&&<div className="ai-action-list">
          <b><AlertTriangle size={16}/> Việc AI đề xuất làm ngay</b>
          {actions.map((x,i)=><div className="ai-action-item" key={i}>{x}</div>)}
        </div>}

        {topProducts.length>0&&<div className="ai-mini-section">
          <b><BarChart3 size={16}/> Bán chạy hôm nay</b>
          <table className="table ai-table"><thead><tr><th>Sản phẩm</th><th>SL bán</th><th>Doanh thu</th></tr></thead>
          <tbody>{topProducts.map(x=><tr key={x.product_id}><td>{x.product_name}</td><td>{qty(x.sold_qty)} {x.unit}</td><td>{money(x.total_amount)}</td></tr>)}</tbody></table>
        </div>}

        {lowStock.length>0&&<div className="ai-mini-section">
          <b><PackagePlus size={16}/> Hàng dưới ngưỡng</b>
          <table className="table ai-table"><thead><tr><th>Sản phẩm</th><th>Tồn</th><th>Ngưỡng</th></tr></thead>
          <tbody>{lowStock.map(x=><tr key={x.product_id}><td>{x.product_name}</td><td>{qty(x.stock_quantity)} {x.unit}</td><td>{qty(x.low_stock_threshold)} {x.unit}</td></tr>)}</tbody></table>
        </div>}

        {topDebtors.length>0&&<div className="ai-mini-section">
          <b><Users size={16}/> Khách nợ cao</b>
          <table className="table ai-table"><thead><tr><th>Khách</th><th>Nợ</th><th>Bill</th></tr></thead>
          <tbody>{topDebtors.map((x,i)=><tr key={x.id}><td>{debtorLabel(x,i)}</td><td>{money(x.debt_amount)}</td><td>{x.unpaid_orders}</td></tr>)}</tbody></table>
        </div>}
      </div>}

      {supplierGroups.length>0&&supplierGroups.map(g=><div className="ai-supplier-card" key={g.supplier_id||g.supplier_name}>
        <div className="ai-supplier-head">
          <b>{g.supplier_name||'Chưa có nhà cung cấp'}</b>
          <span>{money(g.total_amount)}</span>
        </div>
        <table className="table ai-table">
          <thead><tr><th>Mặt hàng</th><th>SL</th><th>Giá nhập</th><th>Thành tiền</th><th>Rủi ro</th></tr></thead>
          <tbody>{(g.items||[]).map(x=><tr key={x.product_id}>
            <td><b>{x.product_name}</b><br/><span className="muted">Tồn {qty(x.stock_quantity)} {x.unit} • TB bán {qty(x.avg_daily_sale)}/ngày</span></td>
            <td>{qty(x.quantity)} {x.unit}</td>
            <td>{money(x.purchase_price)}</td>
            <td>{money(x.total_price)}</td>
            <td>{x.risk||'-'}</td>
          </tr>)}</tbody>
        </table>
      </div>)}

      {!supplierGroups.length&&draftItems.length>0&&<table className="table ai-table">
        <thead><tr><th>Mặt hàng</th><th>Tồn</th><th>Đề xuất</th><th>Rủi ro</th></tr></thead>
        <tbody>{draftItems.map(x=><tr key={x.product_id}>
          <td><b>{x.product_name}</b></td>
          <td>{qty(x.stock_quantity)} {x.unit}</td>
          <td>{qty(x.quantity||x.suggested_order_qty)} {x.unit}</td>
          <td>{x.risk||'-'}</td>
        </tr>)}</tbody>
      </table>}

      {canConfirm&&<div className="actions ai-confirm-row">
        <button className="btn" onClick={()=>send('ok')} disabled={loading}><CheckCircle2 size={16}/> Xác nhận tạo phiếu</button>
        <button className="btn secondary" onClick={()=>send('huy')} disabled={loading}><XCircle size={16}/> Huỷ</button>
      </div>}
    </div>}

    {history.length>0&&<div className="ai-history">
      {history.map((h,idx)=><div key={idx} className={'ai-history-row '+h.role+(h.error?' error':'')}>
        <b>{h.role==='user'?'Bạn':'AI'}:</b> {h.text}
      </div>)}
    </div>}
    </>}
  </div>;
}
