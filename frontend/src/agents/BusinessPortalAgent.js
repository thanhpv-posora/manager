const pool=require('../config/db');
class BusinessPortalAgent{
  constructor(){this.version='6.20.0';this.responsibility='Separate public business portal: owner info, partners and sponsor ads';}
  async pages(publicOnly=false){const [rows]=await pool.query(`SELECT * FROM business_portal_pages ${publicOnly?'WHERE is_public=1':''} ORDER BY id`);return rows;}
  async savePage(data,user){if(!data.page_key||!data.title)throw new Error('Thiếu page_key hoặc title');await pool.query(`INSERT INTO business_portal_pages(page_key,title,content,is_public,updated_by) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE title=VALUES(title),content=VALUES(content),is_public=VALUES(is_public),updated_by=VALUES(updated_by),updated_at=NOW()`,[data.page_key,data.title,data.content||'',data.is_public?1:0,user?.id||null]);return {message:'Đã lưu trang thông tin'};}
  async sponsors(publicOnly=false){const [rows]=await pool.query(`SELECT * FROM sponsors ${publicOnly?'WHERE is_active=1':''} ORDER BY sort_order,id`);return rows;}
  dailySponsorIdea(sponsor){
    const name=sponsor?.name||'Nhà tài trợ';
    return {
      title:`Video quảng cáo hôm nay cho ${name}`,
      script_text:`Mở đầu: Giới thiệu ${name}.\nNội dung: Nêu lợi ích, uy tín, sản phẩm/dịch vụ nổi bật.\nKêu gọi: Liên hệ hoặc ghé thăm ngay hôm nay.`,
      video_idea:`Cảnh 1: Logo ${name}.\nCảnh 2: Sản phẩm/dịch vụ thực tế.\nCảnh 3: Khách hàng hài lòng.\nCảnh 4: Thông tin liên hệ và lời cảm ơn.`
    };
  }

  async createDailyAd(data){
    const [sponsors]=await pool.query(`SELECT * FROM sponsors WHERE id=?`,[data.sponsor_id]);
    const sponsor=sponsors[0]||{};
    const idea=this.dailySponsorIdea(sponsor);
    await pool.query(`INSERT INTO sponsor_ad_campaigns(sponsor_id,title,script_text,video_idea,campaign_date,status)
      VALUES(?,?,?,?,?,'DRAFT')`,[data.sponsor_id||null,data.title||idea.title,data.script_text||idea.script_text,data.video_idea||idea.video_idea,data.campaign_date]);
    return {message:'Đã tạo ý tưởng video quảng cáo',...idea};
  }

  async ads(){
    const [rows]=await pool.query(`SELECT a.*,s.name sponsor_name FROM sponsor_ad_campaigns a LEFT JOIN sponsors s ON s.id=a.sponsor_id ORDER BY a.campaign_date DESC,a.id DESC`);
    return rows;
  }

  async saveSponsor(data){if(!data.name)throw new Error('Thiếu tên nhà tài trợ');if(data.id){await pool.query(`UPDATE sponsors SET name=?,logo_url=?,website_url=?,description=?,sort_order=?,is_active=? WHERE id=?`,[data.name,data.logo_url||'',data.website_url||'',data.description||'',data.sort_order||0,data.is_active?1:0,data.id]);return {message:'Đã sửa nhà tài trợ'};}await pool.query(`INSERT INTO sponsors(name,logo_url,website_url,description,sort_order,is_active) VALUES(?,?,?,?,?,?)`,[data.name,data.logo_url||'',data.website_url||'',data.description||'',data.sort_order||0,data.is_active?1:0]);return {message:'Đã thêm nhà tài trợ'};}
}
module.exports=new BusinessPortalAgent();
