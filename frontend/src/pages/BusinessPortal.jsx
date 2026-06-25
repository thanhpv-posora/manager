import React,{useEffect,useState}from'react';
import {Pencil}from'lucide-react';
import api from'../api/api';
import SafePage from'../components/SafePage';

export default function BusinessPortal(){
 const[pages,setPages]=useState([]),[sponsors,setSponsors]=useState([]),[ads,setAds]=useState([]);
 const[page,setPage]=useState({page_key:'owner',title:'',content:'',is_public:1});
 const[sponsor,setSponsor]=useState({is_active:1,sort_order:0});
 const[ad,setAd]=useState({campaign_date:new Date().toISOString().slice(0,10)});
 const[loading,setLoading]=useState(true),[error,setError]=useState('');
 const load=async()=>{try{const[p,s,a]=await Promise.all([api.get('/portal/pages'),api.get('/portal/sponsors'),api.get('/portal/ads')]);setPages(p.data||[]);setSponsors(s.data||[]);setAds(a.data||[])}catch(e){setError(e.response?.data?.message||e.message)}finally{setLoading(false)}};
 useEffect(()=>{load()},[]);
 const savePage=async()=>{await api.post('/portal/pages',page);setPage({page_key:'owner',title:'',content:'',is_public:1});await load()};
 const editPage=p=>setPage({...p,is_public:p.is_public?1:0});
 const saveSponsor=async()=>{await api.post('/portal/sponsors',sponsor);setSponsor({is_active:1,sort_order:0});await load()};
 const editSponsor=s=>setSponsor({...s,is_active:s.is_active?1:0});
 const createAd=async()=>{await api.post('/portal/ads/daily',ad);await load()};
 return <SafePage loading={loading} error={error}>
  <div className="portal-hero card">
    <h1>Business Portal Agent</h1>
    <p>Quản lý nội dung giới thiệu hộ kinh doanh, đối tác và nhà tài trợ/quảng cáo.</p>
  </div>
  <div className="grid cols-2">
   <div className="card"><h3>Thông tin chủ kinh doanh / đối tác</h3><div className="form-grid">
    <select className="select" value={page.page_key||'owner'} onChange={e=>setPage({...page,page_key:e.target.value})}><option value="owner">Thông tin chủ kinh doanh</option><option value="partners">Thông tin đối tác</option><option value="about">Giới thiệu hệ thống</option><option value="custom">Trang tùy chỉnh</option></select>
    <input className="input" placeholder="Tiêu đề" value={page.title||''} onChange={e=>setPage({...page,title:e.target.value})}/>
    <textarea className="input" style={{minHeight:160,gridColumn:'1 / -1'}} placeholder="Nội dung" value={page.content||''} onChange={e=>setPage({...page,content:e.target.value})}/>
   </div><button className="btn" style={{marginTop:10}} onClick={savePage}>Lưu trang</button>
   <div className="portal-list">{pages.map(p=><div className="portal-item" key={p.id}><b>{p.title}</b><span>{p.page_key}</span><button className="btn secondary" title="Sửa" style={{padding:0,width:32,height:32,display:'inline-flex',alignItems:'center',justifyContent:'center'}} onClick={()=>editPage(p)}><Pencil size={14}/></button></div>)}</div></div>
   <div className="card"><h3>Nhà tài trợ / Quảng cáo</h3><div className="form-grid">
    <input className="input" placeholder="Tên nhà tài trợ" value={sponsor.name||''} onChange={e=>setSponsor({...sponsor,name:e.target.value})}/>
    <input className="input" placeholder="Logo URL" value={sponsor.logo_url||''} onChange={e=>setSponsor({...sponsor,logo_url:e.target.value})}/>
    <input className="input" placeholder="Website URL" value={sponsor.website_url||''} onChange={e=>setSponsor({...sponsor,website_url:e.target.value})}/>
    <input className="input" placeholder="Thứ tự" value={sponsor.sort_order||0} onChange={e=>setSponsor({...sponsor,sort_order:e.target.value})}/>
    <textarea className="input" style={{gridColumn:'1 / -1'}} placeholder="Mô tả quảng cáo" value={sponsor.description||''} onChange={e=>setSponsor({...sponsor,description:e.target.value})}/>
   </div><button className="btn" style={{marginTop:10}} onClick={saveSponsor}>Lưu nhà tài trợ</button>
   <div className="portal-list">{sponsors.map(s=><div className="portal-item" key={s.id}><b>{s.name}</b><span>{s.website_url}</span><button className="btn secondary" title="Sửa" style={{padding:0,width:32,height:32,display:'inline-flex',alignItems:'center',justifyContent:'center'}} onClick={()=>editSponsor(s)}><Pencil size={14}/></button></div>)}</div></div>
  </div>
  <div className="card"><h3>Agent AI tạo ý tưởng video quảng cáo theo ngày</h3><div className="form-grid"><select className="select" value={ad.sponsor_id||''} onChange={e=>setAd({...ad,sponsor_id:e.target.value})}><option value="">Chọn nhà tài trợ</option>{sponsors.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select><input className="input" type="date" value={ad.campaign_date} onChange={e=>setAd({...ad,campaign_date:e.target.value})}/></div><button className="btn" style={{marginTop:10}} onClick={createAd}>Tạo ý tưởng video hôm nay</button><table className="table"><tbody>{ads.map(a=><tr key={a.id}><td><b>{a.title}</b><br/><span className="muted">{a.campaign_date} · {a.sponsor_name}</span></td><td style={{whiteSpace:'pre-wrap'}}>{a.video_idea}</td></tr>)}</tbody></table></div>
 </SafePage>
}
