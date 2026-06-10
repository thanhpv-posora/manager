import React,{useEffect,useState}from'react';
import api from'../api/api';

export default function LandingPage({onLoginClick,onRegisterClick}){
 const[pages,setPages]=useState([]),[sponsors,setSponsors]=useState([]),[videos,setVideos]=useState({});
 useEffect(()=>{Promise.all([api.get('/portal/public/pages'),api.get('/portal/public/sponsors'),api.get('/videos/public/placements').catch(()=>({data:{}}))]).then(([p,s,v])=>{setPages(p.data||[]);setSponsors(s.data||[]);setVideos(v.data||{})}).catch(()=>{})},[]);
 const about=pages.find(x=>x.page_key==='about')||{};
 const owner=pages.find(x=>x.page_key==='owner')||{};

 return <div className="landing-pro">
  <header className="landing-header">
    <div className="landing-logo">🥩 <b>MeatBiz</b></div>
    <div className="landing-actions">
      <button className="btn secondary" onClick={onRegisterClick}>Đăng ký tài khoản</button>
      <button className="btn" onClick={onLoginClick}>Đăng nhập</button>
    </div>
  </header>

  <section className="landing-hero">
    <div>
      <div className="eyebrow">AI Business System</div>
      <h1>Quản lý kinh doanh nhanh, rõ công nợ, đúng giá từng khách</h1>
      <p>MeatBiz hỗ trợ tạo bill POS, giá riêng, nhập lô bò xô, thu tiền, góp nợ theo tháng và OCR từ ảnh.</p>
      <div className="hero-actions">
        <button className="btn secondary" onClick={onRegisterClick}>Đăng ký tài khoản</button>
        <button className="btn" onClick={onLoginClick}>Vào hệ thống</button>
        <span>Thiết kế cho hộ kinh doanh thực tế</span>
      </div>
    </div>
    <div className="hero-card">
      <h3>Hôm nay có gì?</h3>
      <ul>
        <li>Tạo bill bằng Excel/ảnh/giọng nói</li>
        <li>Giá riêng theo từng bạn hàng</li>
        <li>Công nợ và góp nợ rõ từng tháng</li>
        <li>Agent AI học dữ liệu ngành thịt</li>
      </ul>
    </div>
  </section>

  {videos.home_hero?.map(v=><section className="landing-section" key={v.id}><h2>{v.title}</h2>{v.video_url&&<video src={v.video_url} controls style={{width:'100%',borderRadius:18}} poster={v.thumbnail_url||''}/>}</section>)}

  <section className="landing-grid">
    <div className="landing-section"><h2>{about.title||'Giới thiệu hệ thống'}</h2><p style={{whiteSpace:'pre-wrap'}}>{about.content||'Hệ thống MeatBiz giúp quản lý bán hàng, công nợ, nhập lô và dữ liệu khách hàng cho hộ kinh doanh.'}</p></div>
    <div className="landing-section"><h2>{owner.title||'Thông tin chủ kinh doanh'}</h2><p style={{whiteSpace:'pre-wrap'}}>{owner.content||'Cập nhật thông tin chủ kinh doanh, đối tác và dịch vụ tại đây.'}</p></div>
  </section>

  <section className="landing-section">
    <h2>Nhà tài trợ / Đối tác</h2>
    <div className="sponsor-grid">{sponsors.map(s=><div className="sponsor-card" key={s.id}>{s.logo_url&&<img src={s.logo_url}/>}<b>{s.name}</b><p>{s.description}</p></div>)}</div>
  </section>

  <section className="landing-section landing-contact-section">
    <div className="landing-contact-title">
      <div>
        <div className="eyebrow">Support Center</div>
        <h2>Thông tin liên hệ</h2>
        <p className="muted">Cần tư vấn, hỗ trợ triển khai hoặc đăng ký sử dụng MeatBiz, vui lòng liên hệ:</p>
      </div>
    </div>

    <div className="landing-contact-grid">
      <div className="landing-contact-card">
        <div className="landing-contact-icon">✉️</div>
        <div>
          <b>Email hỗ trợ</b>
          <p>support@posora.vn</p>
        </div>
      </div>

      <div className="landing-contact-card">
        <div className="landing-contact-icon">☎️</div>
        <div>
          <b>Điện thoại liên hệ</b>
          <p>0848 778 222</p>
          <p>0935 363 468</p>
          <p>0935 695 006</p>
        </div>
      </div>

      <div className="landing-contact-card">
        <div className="landing-contact-icon">💬</div>
        <div>
          <b>Zalo hỗ trợ</b>
          <p>0935 363 468</p>
        </div>
      </div>
    </div>
  </section>
 </div>
}
