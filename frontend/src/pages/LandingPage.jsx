import React,{useEffect,useState}from'react';
import {Brain,ChevronRight,ClipboardCheck,Mic,PackageCheck,ShieldCheck,Sparkles,TrendingUp,Truck,Users,CheckCircle2,Layers3} from 'lucide-react';
import api from'../api/api';

const intro='AI không chỉ trả lời. MeatBiz đọc dữ liệu kinh doanh, lập nháp nghiệp vụ và chờ chủ xác nhận trước khi ghi vào hệ thống.';

export default function LandingPage({onLoginClick,onRegisterClick}){
 const[pages,setPages]=useState([]),[sponsors,setSponsors]=useState([]),[videos,setVideos]=useState({});
 useEffect(()=>{Promise.all([api.get('/portal/public/pages').catch(()=>({data:[]})),api.get('/portal/public/sponsors').catch(()=>({data:[]})),api.get('/videos/public/placements').catch(()=>({data:{}}))]).then(([p,s,v])=>{setPages(p.data||[]);setSponsors(s.data||[]);setVideos(v.data||{})}).catch(()=>{})},[]);
 const about=pages.find(x=>x.page_key==='about')||{};
 const owner=pages.find(x=>x.page_key==='owner')||{};
 const features=[
  ['AI tạo bill POS','Nói hoặc nhập câu tự nhiên, hệ thống hiểu khách, hàng, số lượng và thanh toán.',Mic],
  ['AI nhập hàng thông minh','Dự báo thiếu hàng, gợi ý nhập theo tồn kho và lịch sử bán.',Truck],
  ['AI Dashboard điều hành','Tóm tắt hôm nay: doanh thu, công nợ, hàng sắp hết và việc cần làm ngay.',TrendingUp],
  ['Công nợ rõ từng khách','Theo dõi nợ, thu tiền, góp nợ, lịch sử bill và thanh toán minh bạch.',Users],
  ['Tồn kho đúng nghiệp vụ thịt','Hỗ trợ không quản lý tồn, quản lý tồn kho, carcass/yield tracking.',PackageCheck],
  ['An toàn khi vận hành','AI không ghi dữ liệu trực tiếp. Tác vụ quan trọng đều qua nháp và xác nhận.',ShieldCheck]
 ];
 const flow=[
  ['1','Nói hoặc nhập','“Nên nhập hàng gì tuần tới?”'],
  ['2','AI phân tích','Đọc bill, tồn kho, công nợ và nhà cung cấp từ DB'],
  ['3','Tạo nháp','Lập đề xuất nhập hàng / tạo bill / cảnh báo điều hành'],
  ['4','Chủ xác nhận','Bấm OK mới ghi nghiệp vụ vào hệ thống']
 ];
 const pillars=[
  ['DB','Dữ liệu kinh doanh tập trung'],
  ['Business validate','Kiểm tra nghiệp vụ trước khi ghi'],
  ['Draft-confirm','Nháp trước, xác nhận sau'],
  ['Dynamic resolver','Tìm khách và sản phẩm từ dữ liệu'],
  ['Voice/POS ready','Sẵn sàng cho nhập liệu bằng giọng nói']
 ];
 return <div className="landing-pro ai-home">
  <header className="landing-header ai-home-header">
    <div className="landing-logo ai-home-logo"><span className="logo-mark">🥩</span><div><b>MeatBiz</b><small>AI-native ERP</small></div></div>
    <div className="landing-actions">
      <button className="btn secondary" onClick={onRegisterClick}>Đăng ký</button>
      <button className="btn" onClick={onLoginClick}>Đăng nhập</button>
    </div>
  </header>

  <main className="ai-home-main">
    <section className="ai-hero">
      <div className="ai-hero-copy">
        <div className="ai-pill"><Sparkles size={16}/> AI Operating System for Meat Wholesalers</div>
        <h1>Không chỉ quản lý bán thịt. MeatBiz giúp chủ sạp <span>điều hành bằng AI.</span></h1>
        <p>{intro}</p>
        <div className="hero-actions">
          <button className="btn ai-primary" onClick={onLoginClick}>Vào hệ thống <ChevronRight size={18}/></button>
          <button className="btn secondary" onClick={onRegisterClick}>Dùng thử</button>
        </div>
        <div className="trust-row">{pillars.map(([t])=><span key={t}>{t}</span>)}</div>
      </div>
      <div className="ai-demo-card">
        <div className="demo-top"><Brain size={22}/><b>AI điều hành hôm nay</b></div>
        <div className="demo-line danger"><span>Hết hàng</span><b>Gầu bò còn 0kg</b></div>
        <div className="demo-line warning"><span>Gần hết</span><b>Bò nạm còn 3kg</b></div>
        <div className="demo-line"><span>Công nợ cao</span><b>Khách hàng A 7.200.000đ</b></div>
        <div className="demo-action"><ClipboardCheck size={18}/> Lập nháp nhập hàng ngay</div>
        <small>AI phát hiện vấn đề → đề xuất hành động → chủ xác nhận.</small>
      </div>
    </section>

    <section className="ai-value-strip">
      {pillars.map(([title,desc])=><div key={title}><b>{title}</b><span>{desc}</span></div>)}
    </section>

    <section className="ai-section-head">
      <div className="eyebrow">Điểm mạnh</div>
      <h2>Những điều MeatBiz làm cho chủ kinh doanh</h2>
      <p>Giao diện giữ đơn giản, nhưng phía sau là AI engine xử lý nghiệp vụ bán sỉ thịt theo dữ liệu của cửa hàng.</p>
    </section>

    <section className="ai-feature-grid">
      {features.map(([title,desc,Icon])=><div className="ai-feature-card" key={title}><div className="feature-icon"><Icon size={22}/></div><h3>{title}</h3><p>{desc}</p></div>)}
    </section>

    <section className="ai-workflow">
      <div>
        <div className="eyebrow">Workflow production</div>
        <h2>Từ một câu nói thành hành động kinh doanh</h2>
        <p>MeatBiz không để AI tự ý ghi dữ liệu. AI lập nháp, giải thích rõ và chờ chủ xác nhận.</p>
        <button className="btn ai-primary" onClick={onLoginClick}>Mở AI Dashboard</button>
      </div>
      <div className="flow-list">
        {flow.map(([n,t,d])=><div className="flow-item" key={n}><span>{n}</span><div><b>{t}</b><p>{d}</p></div></div>)}
      </div>
    </section>

    <section className="ai-story-panel">
      <div className="ai-story-copy">
        <div className="eyebrow">AI-native ERP</div>
        <h2>{about.title||'Thiết kế cho bán sỉ thịt'}</h2>
        <p style={{whiteSpace:'pre-wrap'}}>{about.content||'MeatBiz hỗ trợ POS, giá riêng từng khách, công nợ, nhập lô, tồn kho, lịch âm/dương và AI điều hành. Mục tiêu là giúp chủ kinh doanh nhìn rõ hôm nay phải làm gì, hàng nào thiếu, khách nào cần thu, và đơn nào cần xử lý.'}</p>
      </div>
      <div className="ai-story-list">
        <div><CheckCircle2 size={20}/><span>POS bán hàng nhanh, rõ tiền mặt và chuyển khoản</span></div>
        <div><CheckCircle2 size={20}/><span>AI cảnh báo tồn kho và lập nháp nhập hàng</span></div>
        <div><CheckCircle2 size={20}/><span>Theo dõi công nợ, lịch sử bill và thu tiền</span></div>
        <div><CheckCircle2 size={20}/><span>Hỗ trợ lịch âm/dương theo từng khách</span></div>
      </div>
    </section>

    <section className="ai-owner-panel">
      <div className="owner-card-main">
        <Layers3 size={26}/>
        <h2>{owner.title||'Dễ dùng cho chủ và nhân viên'}</h2>
        <p style={{whiteSpace:'pre-wrap'}}>{owner.content||'Giao diện ưu tiên ít nút, chữ rõ, hành động rõ. Nhân viên có thể tạo bill nhanh; chủ có thể xem AI Dashboard và xác nhận các nháp nghiệp vụ quan trọng.'}</p>
      </div>
      <div className="owner-mini-grid">
        <div><b>Ít thao tác</b><span>Nói hoặc nhập câu tự nhiên</span></div>
        <div><b>Dễ kiểm soát</b><span>Có nháp trước khi ghi dữ liệu</span></div>
        <div><b>Rõ việc cần làm</b><span>Dashboard gợi ý hành động</span></div>
      </div>
    </section>

    {videos.home_hero?.map(v=><section className="landing-section ai-media-section" key={v.id}><h2>{v.title}</h2>{v.video_url&&<video src={v.video_url} controls style={{width:'100%',borderRadius:18}} poster={v.thumbnail_url||''}/>}</section>)}

    {sponsors.length>0&&<section className="landing-section ai-sponsor-section"><h2>Nhà tài trợ / Đối tác</h2><div className="sponsor-grid">{sponsors.map(s=><div className="sponsor-card" key={s.id}>{s.logo_url&&<img src={s.logo_url}/>}<b>{s.name}</b><p>{s.description}</p></div>)}</div></section>}

    <section className="landing-section landing-contact-section ai-contact-section">
      <div className="landing-contact-title"><div><div className="eyebrow">Support Center</div><h2>Thông tin liên hệ</h2><p className="muted">Cần tư vấn, hỗ trợ triển khai hoặc đăng ký sử dụng MeatBiz, vui lòng liên hệ:</p></div></div>
      <div className="landing-contact-grid">
        <div className="landing-contact-card"><div className="landing-contact-icon">✉️</div><div><b>Email hỗ trợ</b><p>support@posora.vn</p></div></div>
        <div className="landing-contact-card"><div className="landing-contact-icon">☎️</div><div><b>Điện thoại liên hệ</b><p>0848 778 222</p><p>0935 363 468</p><p>0935 695 006</p></div></div>
        <div className="landing-contact-card"><div className="landing-contact-icon">💬</div><div><b>Zalo hỗ trợ</b><p>0935 363 468</p></div></div>
      </div>
    </section>
  </main>
 </div>
}
