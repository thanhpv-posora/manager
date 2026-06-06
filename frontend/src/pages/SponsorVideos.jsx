import React,{useEffect,useState}from'react';
import api from'../api/api';
import SafePage from'../components/SafePage';
import {generateSponsorVideo}from'../utils/browserVideoGenerator';

const placements=[['HOME_HERO','Đầu trang giới thiệu'],['ABOUT_SECTION','Phần giới thiệu hệ thống'],['SPONSOR_SECTION','Khu nhà tài trợ'],['FOOTER_AD','Cuối trang']];

export default function SponsorVideos(){
 const today=new Date().toISOString().slice(0,10);
 const[sponsors,setSponsors]=useState([]),[videos,setVideos]=useState([]),[deleted,setDeleted]=useState([]);
 const[form,setForm]=useState({campaign_date:today,placement:'SPONSOR_SECTION'});
 const[idea,setIdea]=useState(null),[previewUrl,setPreviewUrl]=useState(''),[progress,setProgress]=useState(0),[loading,setLoading]=useState(true),[error,setError]=useState('');
 const load=async()=>{try{const[s,v,d]=await Promise.all([api.get('/portal/sponsors'),api.get('/videos'),api.get('/videos/deleted')]);setSponsors(s.data||[]);setVideos(v.data||[]);setDeleted(d.data||[])}catch(e){setError(e.response?.data?.message||e.message)}finally{setLoading(false)}};
 useEffect(()=>{load()},[]);
 const makeIdea=async()=>{const sponsor=sponsors.find(x=>String(x.id)===String(form.sponsor_id));const r=await api.post('/videos/idea',{...form,sponsor_name:sponsor?.name});setIdea(r.data);setForm(f=>({...f,title:r.data.title,script_text:r.data.script_text,video_idea:r.data.video_idea}))};
 const uploadBlob=async(blob)=>{const fd=new FormData();fd.append('video',blob,'sponsor_video.webm');const up=await api.post('/uploads/video',fd,{headers:{'Content-Type':'multipart/form-data'}});setForm(f=>({...f,video_url:up.data.url}));return up.data.url};
 const generateRealVideo=async()=>{try{const sponsor=sponsors.find(x=>String(x.id)===String(form.sponsor_id));setProgress(0);const blob=await generateSponsorVideo({...form,sponsor_name:sponsor?.name,durationSec:12,onProgress:setProgress});const url=URL.createObjectURL(blob);setPreviewUrl(url);await uploadBlob(blob);alert('Đã tạo và upload video thật')}catch(e){alert(e.message||'Không tạo được video trên trình duyệt này')}};
 const uploadManual=async(file)=>{if(!file)return;const fd=new FormData();fd.append('video',file);const up=await api.post('/uploads/video',fd,{headers:{'Content-Type':'multipart/form-data'}});setForm(f=>({...f,video_url:up.data.url}));setPreviewUrl(URL.createObjectURL(file));alert('Đã upload video')};
 const createPlan=async()=>{await api.post('/videos',form);setForm({campaign_date:today,placement:'SPONSOR_SECTION'});setIdea(null);setPreviewUrl('');setProgress(0);await load()};
 const publish=async(v,is_public)=>{await api.post('/videos/'+v.id+'/publish',{is_public});await load()};
 const softDelete=async(v)=>{const reason=prompt('Lý do xóa mềm video?');if(reason!==null){await api.delete('/videos/'+v.id,{data:{reason}});await load()}};
 const restore=async(v)=>{await api.post('/videos/'+v.id+'/restore');await load()};
 const hardDelete=async(v)=>{if(confirm('Xóa vĩnh viễn video này?')){await api.delete('/videos/'+v.id+'/hard');await load()}};
 return <SafePage loading={loading} error={error}>
  <div className="card portal-hero"><h1>Sponsor Video Agent</h1><p>Tạo video thật hoặc upload video có sẵn, publish vào đúng vị trí trên trang giới thiệu.</p></div>
  <div className="grid cols-2"><div className="card"><h3>1. Tạo / upload video</h3><div className="form-grid">
   <select className="select" value={form.sponsor_id||''} onChange={e=>setForm({...form,sponsor_id:e.target.value})}><option value="">Chọn nhà tài trợ</option>{sponsors.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select>
   <input className="input" type="date" value={form.campaign_date} onChange={e=>setForm({...form,campaign_date:e.target.value})}/>
   <select className="select" value={form.placement} onChange={e=>setForm({...form,placement:e.target.value})}>{placements.map(p=><option key={p[0]} value={p[0]}>{p[1]}</option>)}</select>
   <input className="input" placeholder="Tiêu đề video" value={form.title||''} onChange={e=>setForm({...form,title:e.target.value})}/>
   <textarea className="input" style={{gridColumn:'1 / -1',minHeight:110}} placeholder="Kịch bản video" value={form.script_text||''} onChange={e=>setForm({...form,script_text:e.target.value})}/>
   <textarea className="input" style={{gridColumn:'1 / -1',minHeight:110}} placeholder="Ý tưởng cảnh quay / prompt" value={form.video_idea||''} onChange={e=>setForm({...form,video_idea:e.target.value})}/>
   <input className="input" placeholder="Video URL" value={form.video_url||''} onChange={e=>setForm({...form,video_url:e.target.value})}/>
   <input className="input" type="file" accept="video/*" onChange={e=>uploadManual(e.target.files?.[0])}/>
  </div><div className="actions" style={{marginTop:12}}><button className="btn secondary" onClick={makeIdea}>AI tạo ý tưởng</button><button className="btn secondary" onClick={generateRealVideo}>Tạo video thật</button><button className="btn" onClick={createPlan}>Lưu & đưa vào danh sách</button></div>
  {progress>0&&progress<100&&<p className="muted">Đang tạo video: {progress}%</p>}{previewUrl&&<video src={previewUrl} controls style={{width:'100%',borderRadius:16,marginTop:12}}/>}{idea&&<div className="card" style={{boxShadow:'none',background:'#fff7ed',marginTop:12}}><b>Prompt:</b><pre style={{whiteSpace:'pre-wrap'}}>{idea.prompt}</pre></div>}</div>
  <div className="card"><h3>Agent AI tự học</h3><p className="muted">Khi sửa prompt/kịch bản và publish, hệ thống lưu learning log để lần sau tạo nội dung sát nghiệp vụ hơn.</p><p>Video tạo nội bộ là slideshow WebM. Nếu cần video AI người nói/cảnh thật thì upload file video từ công cụ ngoài vào đây.</p></div></div>
  <div className="card"><h3>Danh sách video đang dùng</h3><table className="table"><thead><tr><th>Video</th><th>Vị trí</th><th>Preview</th><th>Trạng thái</th><th></th></tr></thead><tbody>{videos.map(v=><tr key={v.id}><td><b>{v.title}</b><br/><span className="muted">{v.sponsor_name} · {v.campaign_date}</span></td><td>{placements.find(p=>p[0]===v.placement)?.[1]||v.placement}</td><td>{v.video_url?<video src={v.video_url} controls style={{width:220,borderRadius:12}}/>:'Chưa có video'}</td><td>{v.status} · {v.is_public?'Public':'Ẩn'}</td><td><button className="btn secondary" onClick={()=>setForm({...v})}>Sửa</button> <button className="btn" onClick={()=>publish(v,!v.is_public)}>{v.is_public?'Ẩn':'Publish'}</button> <button className="btn danger" onClick={()=>softDelete(v)}>Xóa mềm</button></td></tr>)}</tbody></table></div>
  <div className="card"><h3>Video đã xóa mềm</h3><table className="table"><tbody>{deleted.map(v=><tr key={v.id}><td>{v.title}<br/><span className="muted">{v.deleted_reason}</span></td><td><button className="btn secondary" onClick={()=>restore(v)}>Khôi phục</button> <button className="btn danger" onClick={()=>hardDelete(v)}>Xóa vĩnh viễn</button></td></tr>)}</tbody></table></div>
 </SafePage>
}
