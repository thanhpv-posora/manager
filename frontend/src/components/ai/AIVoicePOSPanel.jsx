import React,{useMemo,useRef,useState}from'react';
import api from'../../api/api';

const hasSpeech=()=>typeof window!=='undefined'&&(window.SpeechRecognition||window.webkitSpeechRecognition);

function normText(text){
  return String(text||'').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/đ/g,'d')
    .replace(/\b(ky|ki|kí|ký|kg|kilogram|can)\b/g,'kg')
    .replace(/\bxg\b/g,'xuong')
    .replace(/\b(xuong)\s+ong\b/g,'xuong ong')
    .replace(/\b(xuong)\s+suon\b/g,'xuong suon')
    .replace(/\b(xuong)\s+uc\b/g,'xuong uc')
    .replace(/\b(xuong)\s+duoi\b/g,'xuong duoi')
    .replace(/\b(xuong)\s+cui\s+gan\b/g,'xuong cui gan')
    .replace(/\b(bup|bop|boop|bup|bap)\b/g,'bap')
    .replace(/\bgau\b/g,'gau')
    .replace(/\bgau\s+nac\b/g,'gau nac')
    .replace(/\bgau\s+mo\b/g,'gau mo')
    .replace(/\bgan\s+pho\b/g,'gan pho')
    .replace(/\b(gan\s+phoi)\b/g,'gan phoi')
    .replace(/\b(loi|loai|xoa|xoá|xóa|bo|bỏ)\s+dong\s+cuoi\b/g,'xoa dong cuoi')
    .replace(/\s+/g,' ')
    .trim();
}

function prettyName(name){
  const n=normText(name);
  if(n==='bap')return 'bò bắp';
  if(n==='gau')return 'gầu bò';
  if(n==='gau nac')return 'gầu nạc';
  if(n==='gau mo')return 'gầu mỡ';
  if(n==='nam')return 'nạm bò';
  if(n==='nam')return 'nạm bò';
  if(n==='nam')return 'nạm bò';
  if(n==='xuong ong')return 'xương ống';
  if(n==='xuong suon')return 'xương sườn';
  if(n==='xuong uc')return 'xương ức';
  if(n==='xuong duoi')return 'xương đuôi';
  if(n==='xuong cui gan')return 'xương cùi gân';
  if(n==='gan pho')return 'gân phở';
  if(n==='gan phoi')return 'gan phổi';
  if(n==='long')return 'lòng';
  if(n==='luoi')return 'lưỡi';
  if(n==='nam')return 'nạm';
  if(n==='nam')return 'nầm';
  if(n==='nap')return 'nấp';
  if(n==='de o')return 'đeo';
  return name;
}

function localPreview(text){
  const raw=String(text||'').trim();
  const norm=normText(raw);
  const items=[];
  const re=/([0-9]+(?:[.,][0-9]+)?)\s*(kg)?\s+([a-z0-9\s]*?)(?=\s+[0-9]+(?:[.,][0-9]+)?\s*(?:kg)?\s+|$)/gi;
  let m;
  while((m=re.exec(norm))!==null){
    let name=(m[3]||'')
      .replace(/\b(khach|thuong|vang|lai|hien|hong|chi|anh|co|chu|bac|tien|mat|chuyen|khoan|ck|tra|lay|mua|voi|va|them|doi|xoa|xong|huy)\b/g,' ')
      .replace(/\s+/g,' ').trim();
    if(!name)continue;
    items.push({quantity:Number(m[1].replace(',','.')),name:prettyName(name)});
  }
  return items;
}

function appendLine(base,line){
  const a=String(base||'').trim();
  const b=String(line||'').trim();
  if(!b)return a;
  return a?`${a}\n${b}`:b;
}


function removeLastItemLine(text){
  const lines=String(text||'').split(/\n+/).map(x=>x.trim()).filter(Boolean);
  for(let i=lines.length-1;i>=0;i--){
    const n=normText(lines[i]);
    if(/^[0-9]/.test(n)||/\bkg\b/.test(n)){
      lines.splice(i,1);
      break;
    }
  }
  return lines.join('\n');
}

function commandKind(line){
  const n=normText(line);
  if(/\b(xoa|xoa het|xoa tat ca|xoa het tat ca|clear all)\b/.test(n) && /\b(tat ca|het|all)\b/.test(n)) return {type:'CLEAR_ALL'};
  if(/\b(xoa dong cuoi|xoa mon vua noi|xoa cai vua noi|nham roi|lon roi|noi nham|doc nham)\b/.test(n)) return {type:'REMOVE_LAST'};
  const rm=n.match(/^\s*(xoa|bo|bỏ|xoá|xóa)\s+(.+)$/i);
  if(rm) return {type:'REMOVE_ITEM', keyword: normText(rm[2]).replace(/\b(di|nhe|nha|giup|cho|minh)\b/g,'').trim()};
  return {type:'NORMAL'};
}

function removeLineByKeyword(text, keyword){
  const key=normText(keyword);
  if(!key)return text;
  const lines=String(text||'').split(/\n+/).map(x=>x.trim()).filter(Boolean);
  const kept=lines.filter(line=>{
    const n=normText(line);
    if(/^[0-9]/.test(n) || /\bkg\b/.test(n)){
      return !n.includes(key);
    }
    return true;
  });
  return kept.join('\n');
}


export default function AIVoicePOSPanel({sessionId='POS_VOICE_001'}){
  const[collapsed,setCollapsed]=useState(true);
  const[message,setMessage]=useState('');
  const[customerType,setCustomerType]=useState('REGULAR');
  const[loading,setLoading]=useState(false);
  const[listening,setListening]=useState(false);
  const[continuous,setContinuous]=useState(false);
  const[result,setResult]=useState(null);
  const[error,setError]=useState('');
  const[partial,setPartial]=useState('');
  const[bugInfo,setBugInfo]=useState(null);
  const[bugLoading,setBugLoading]=useState(false);
  const recRef=useRef(null);
  const messageRef=useRef('');
  const continuousRef=useRef(false);
  const previewItems=useMemo(()=>localPreview(message),[message]);

  const friendlyError=(value)=>{
    const msg=String(value||'');
    if(msg.includes('timeout'))return 'AI đang xử lý hơi lâu. Bạn thử bấm Gửi AI lại hoặc nói ngắn hơn từng dòng.';
    if(msg.includes('Thiếu tên khách'))return 'Khách thường cần có tên khách. Ví dụ: Hồng Hiền, rồi đọc từng dòng hàng.';
    if(msg.includes('Không tìm thấy sản phẩm'))return 'AI chưa khớp được tên hàng. Bạn thử nói rõ hơn: xương ống, bò bắp, gầu bò, nạm.';
    return msg;
  };

  const send=async(text=message, extraPayload={})=>{
    let m=String(text||'').trim();
    if(!m)return null;
    setLoading(true);setError('');
    try{
      const payload={session_id:sessionId,message:m,customer_type:customerType,voice_mode:'CONTINUOUS',...extraPayload};
      const r=await api.post('/ai/chat',payload);
      const data=r.data?.data||r.data;
      setResult(data);
      if(data?.intent==='NEED_CLARIFICATION')setError(data.message||'AI cần thêm thông tin để lập bill.');
      return data;
    }catch(e){
      const msg=friendlyError(e.response?.data?.message||e.message);
      setError(msg);
      return null;
    }
    finally{setLoading(false)}
  };

  const confirm=async()=>{
    const data=await send('ok',{confirm:true});
    if(data?.confirmed){
      setMessage('');
      messageRef.current='';
      setPartial('');
    }
  };
  const cancel=async()=>{
    const data=await send('huy');
    if(data){
      setMessage('');
      messageRef.current='';
      setPartial('');
    }
  };

  const investigateBug=async()=>{
    setBugLoading(true);
    try{
      const r=await api.get('/ai/bug-investigator/latest');
      setBugInfo(r.data?.data?.investigation||r.data?.data||r.data);
    }catch(e){
      setBugInfo({summary:'Không đọc được log lỗi',error_message:e.response?.data?.message||e.message});
    }finally{setBugLoading(false)}
  };

  const clearAll=async()=>{
    stopVoice();
    setMessage('');
    messageRef.current='';
    setPartial('');
    setResult(null);
    setError('Đã xoá tất cả dòng đang nhập.');
  };

  const applyVoiceLine=(line)=>{
    const cmd=commandKind(line);
    if(cmd.type==='CLEAR_ALL'){
      clearAll();
      return {handled:true, shouldSend:'xoa tat ca'};
    }
    if(cmd.type==='REMOVE_LAST'){
      const next=removeLastItemLine(messageRef.current);
      messageRef.current=next;
      setMessage(next);
      setPartial('');
      return {handled:true, shouldSend: 'xoa dong cuoi'};
    }
    if(cmd.type==='REMOVE_ITEM'){
      const next=removeLineByKeyword(messageRef.current, cmd.keyword);
      messageRef.current=next;
      setMessage(next);
      setPartial('');
      return {handled:true, shouldSend: line};
    }
    const next=appendLine(messageRef.current,line);
    messageRef.current=next;
    setMessage(next);
    setPartial('');
    return {handled:false};
  };


  const stopVoice=()=>{
    continuousRef.current=false;
    setContinuous(false);
    try{recRef.current&&recRef.current.stop&&recRef.current.stop();}catch(e){}
    setListening(false);
    setPartial('');
  };

  const startVoice=(keepOpen=false)=>{
    const Speech=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!Speech){setError('Trình duyệt chưa hỗ trợ microphone. Dùng Chrome hoặc Edge.');return;}
    continuousRef.current=!!keepOpen;
    setContinuous(!!keepOpen);
    const rec=new Speech();
    rec.lang='vi-VN';
    rec.interimResults=true;
    rec.continuous=!!keepOpen;
    rec.onstart=()=>setListening(true);
    rec.onend=()=>{
      setListening(false);
      setPartial('');
      if(continuousRef.current){
        setTimeout(()=>{ if(continuousRef.current) startVoice(true); }, 250);
      }
    };
    rec.onerror=e=>{setError('Lỗi microphone: '+(e.error||'unknown'));setListening(false)};
    rec.onresult=e=>{
      let finalText='';let interim='';
      for(let i=e.resultIndex;i<e.results.length;i++){
        const t=e.results[i][0]?.transcript||'';
        if(e.results[i].isFinal)finalText+=t; else interim+=t;
      }
      if(interim)setPartial(interim.trim());
      if(finalText.trim()){
        const line=finalText.trim();
        const normalized=normText(line);
        if(/\b(xong|ket thuc|done)\b/.test(normalized)){
          stopVoice();
          send(messageRef.current);
          return;
        }
        if(/\b(huy|cancel)\b/.test(normalized)){
          stopVoice();
          setMessage('');messageRef.current='';setResult(null);return;
        }
        const applied=applyVoiceLine(line);
        if(applied.shouldSend && result) send(applied.shouldSend);
        if(!keepOpen && !applied.handled)send(messageRef.current);
      }
    };
    recRef.current=rec;
    rec.start();
  };

  const confirmed=result?.confirmed||null;
  const draft=result?.draft||result;
  const items=draft?.items||[];
  const warnings=draft?.warnings||[];
  const isClarify=result?.intent==='NEED_CLARIFICATION';

  return <div className={`ai-voice-pos-card ${collapsed?'collapsed':''}`}>
    <div className="ai-voice-pos-head">
      <div>
        <div className="ai-kicker">AI Voice POS</div>
        <h3>Nói bill nhiều dòng</h3>
        <p>Mic có thể mở liên tục. Đọc từng món, nói <b>xong</b> để AI lập bill nháp.</p>
      </div>
      <div className="actions">
        <button className="btn secondary" onClick={()=>setCollapsed(!collapsed)}>{collapsed?'Mở AI Voice POS':'Thu gọn'}</button>
        {!collapsed&&<button className="btn" onClick={()=>startVoice(true)} disabled={listening||loading||!hasSpeech()}>{listening?'Đang nghe liên tục...':'🎤 Nói liên tục'}</button>}
        {!collapsed&&listening&&<button className="btn secondary" onClick={stopVoice}>Dừng mic</button>}
      </div>
    </div>

    {!collapsed&&<>
    <div className="ai-type-switch">
      <button className={customerType==='REGULAR'?'active':''} onClick={()=>setCustomerType('REGULAR')}>Khách thường</button>
      <button className={customerType==='WALK_IN'?'active':''} onClick={()=>setCustomerType('WALK_IN')}>Khách vãng lai</button>
    </div>

    <div className="ai-voice-pos-input-row">
      <textarea className="input ai-voice-textarea" rows={5} value={message} onChange={e=>{setMessage(e.target.value);messageRef.current=e.target.value}} placeholder={customerType==='REGULAR'?'Ví dụ:\nHồng Hiền\nxg ống 5 ký\nbúp 2 ký\ngầu 1 ký\nxong':'Ví dụ:\nkhách vãng lai\ngầu 2 ký\ntiền mặt 340k\nxong'}/>
      <button className="btn secondary" onClick={()=>send()} disabled={loading}>{loading?'Đang xử lý...':'Gửi AI'}</button>
    </div>

    {partial&&<div className="ai-live-preview"><span>Đang nghe:</span><b>{partial}</b></div>}
    <div className="ai-voice-hint">Mẹo: nói từng dòng. Nếu đọc nhầm: <b>xóa dòng cuối</b> hoặc <b>xóa bóp đi</b>. Muốn làm lại: <b>xóa tất cả</b>.</div>
    {!!previewItems.length&&<div className="ai-live-preview">
      <span>AI đang hiểu:</span>
      {previewItems.map((it,i)=><b key={i}>{it.quantity}kg {it.name}</b>)}
    </div>}

    <div className="ai-voice-pos-examples">
      <button onClick={()=>{const t='Hong Hien\nxg ong 5 ky\nxg suon 3 ky\nbup 2 ky\ngau 1 ky';setCustomerType('REGULAR');setMessage(t);messageRef.current=t}}>Mẫu bill nhiều món</button>
      <button onClick={()=>applyVoiceLine('xoa gau')}>Xoá gầu</button>
      <button onClick={()=>applyVoiceLine('xoa dong cuoi')}>Xoá dòng cuối</button>
      <button onClick={()=>{const t='doi bup 3 ky';setMessage(appendLine(message,t));messageRef.current=appendLine(messageRef.current,t)}}>Đổi búp 3kg</button>
      <button onClick={clearAll}>Xoá tất cả</button>
    </div>

    {error&&<div className="ai-alert danger">{error}<div style={{marginTop:10}}><button className="btn secondary" onClick={investigateBug} disabled={bugLoading}>{bugLoading?'AI đang điều tra...':'AI điều tra lỗi'}</button></div></div>}

    {bugInfo&&<div className="ai-voice-pos-result">
      <div className="ai-result-top"><b>AI điều tra lỗi</b><span>{bugInfo.error_id?'#'+bugInfo.error_id:'Log gần nhất'}</span></div>
      <p>{bugInfo.summary||bugInfo.message}</p>
      {bugInfo.error_message&&<div className="ai-alert danger">{bugInfo.error_message}</div>}
      {!!bugInfo.likely_causes?.length&&<><p><b>Nguyên nhân có thể:</b></p>{bugInfo.likely_causes.map((x,i)=><div key={i} className="ai-alert warn">{x}</div>)}</>}
      {!!bugInfo.suggested_fixes?.length&&<><p><b>Gợi ý fix:</b></p>{bugInfo.suggested_fixes.map((x,i)=><div key={i} className="ai-alert">{x}</div>)}</>}
      {!!bugInfo.related_files?.length&&<p><b>File liên quan:</b> {bugInfo.related_files.join(', ')}</p>}
    </div>}

    {confirmed&&<div className="ai-voice-pos-result success">
      <div className="ai-result-top"><b>ĐÃ LƯU BILL</b><span>{confirmed.customer_payment_type==='WALK_IN'?'Khách vãng lai':'Khách thường'}</span></div>
      <p><b>Mã bill:</b> {confirmed.order_code||confirmed.order_id}</p>
      <p><b>Tổng:</b> {Number(confirmed.total_amount||0).toLocaleString('en-US')}đ</p>
      <p><b>Đã thu:</b> {Number(confirmed.paid_amount||0).toLocaleString('en-US')}đ</p>
      <p><b>Công nợ:</b> {Number(confirmed.debt_amount||0).toLocaleString('en-US')}đ</p>
      <div className="ai-alert">Bill đã được lưu vào hệ thống. Bạn có thể xem trong danh sách bill.</div>
    </div>}

    {result&&!isClarify&&!confirmed&&<div className="ai-voice-pos-result">
      <div className="ai-result-top">
        <b>{result.intent||draft.intent||'AI_DRAFT'}</b>
        {draft.customer_payment_type&&<span>{draft.customer_payment_type==='WALK_IN'?'Khách vãng lai':'Khách thường'}</span>}
      </div>
      {draft.customer?.name&&<p><b>Khách:</b> {draft.customer.name}</p>}
      {draft.payment_policy?.note&&<p className="muted">{draft.payment_policy.note}</p>}
      {!!warnings.length&&warnings.map((w,i)=><div key={i} className="ai-alert warn">{w}</div>)}
      {!!items.length&&<div className="ai-mini-table">
        {items.map((it,i)=><div key={i} className="ai-mini-row"><span>{it.product_name}</span><b>{it.quantity} {it.unit}</b></div>)}
      </div>}
      {draft.total_amount!=null&&<p><b>Tổng:</b> {Number(draft.total_amount||0).toLocaleString('en-US')}đ</p>}
      {draft.paid_amount!=null&&<p><b>Đã thu:</b> {Number(draft.paid_amount||0).toLocaleString('en-US')}đ</p>}
      {draft.debt_amount!=null&&<p><b>Công nợ:</b> {Number(draft.debt_amount||0).toLocaleString('en-US')}đ</p>}
      <div className="actions">
        <button className="btn" onClick={confirm} disabled={loading||draft.can_confirm===false}>Xác nhận lưu</button>
        <button className="btn secondary" onClick={cancel} disabled={loading}>Huỷ nháp</button>
      </div>
    </div>}
    </>}
  </div>;
}
