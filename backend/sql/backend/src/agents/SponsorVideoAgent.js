const pool=require('../config/db');

class SponsorVideoAgent{
  constructor(){
    this.version='6.29.0';
    this.responsibility='Create sponsor/system intro video plan, store video URL, publish to public business portal placement';
  }

  buildVideoPrompt(data){
    const sponsorName=data.sponsor_name||'nhà tài trợ';
    const topic=data.topic||'giới thiệu hệ thống và đối tác';
    return `Tạo video ngắn 30-45 giây cho ${sponsorName}. Chủ đề: ${topic}. Phong cách: rõ ràng, uy tín, gần gũi, phù hợp hộ kinh doanh thịt. Nội dung gồm: mở đầu thương hiệu, lợi ích chính, hình ảnh sản phẩm/dịch vụ, lời kêu gọi liên hệ.`;
  }

  async generateIdea(data){
    const prompt=this.buildVideoPrompt(data);
    return {
      title:data.title||`Video giới thiệu ${data.sponsor_name||'nhà tài trợ'}`,
      script_text:`Cảnh 1: Logo và tên ${data.sponsor_name||'nhà tài trợ'} xuất hiện.\nCảnh 2: Giới thiệu uy tín, sản phẩm/dịch vụ nổi bật.\nCảnh 3: Liên kết với hệ thống MeatBiz/hộ kinh doanh.\nCảnh 4: Thông tin liên hệ và lời cảm ơn.`,
      video_idea:`Video dọc 9:16 hoặc ngang 16:9. Dùng ảnh/logo nhà tài trợ, cảnh sản phẩm thực tế, chữ chạy ngắn, nhạc nền nhẹ.`,
      prompt
    };
  }

  async createFromIdea(data){
    const idea=await this.generateIdea(data);
    await pool.query(
      `INSERT INTO sponsor_ad_campaigns(sponsor_id,title,script_text,video_idea,campaign_date,status,video_url,thumbnail_url,placement,is_public)
       VALUES(?,?,?,?,?,'DRAFT',?,?,?,0)`,
      [
        data.sponsor_id||null,
        data.title||idea.title,
        data.script_text||idea.script_text,
        data.video_idea||idea.video_idea,
        data.campaign_date,
        data.video_url||'',
        data.thumbnail_url||'',
        data.placement||'SPONSOR_SECTION'
      ]
    );
    return {message:'Đã tạo kế hoạch video',...idea};
  }

  async updateVideo(id,data){
    await pool.query(
      `UPDATE sponsor_ad_campaigns SET title=?,script_text=?,video_idea=?,video_url=?,thumbnail_url=?,placement=?,status=?,is_public=? WHERE id=?`,
      [data.title,data.script_text||'',data.video_idea||'',data.video_url||'',data.thumbnail_url||'',data.placement||'SPONSOR_SECTION',data.status||'READY',data.is_public?1:0,id]
    );
    return {message:'Đã cập nhật video'};
  }

  async publish(id,isPublic=true){
    await pool.query(`UPDATE sponsor_ad_campaigns SET is_public=?,status=? WHERE id=?`,[isPublic?1:0,isPublic?'PUBLISHED':'READY',id]);
    return {message:isPublic?'Đã đưa video lên trang giới thiệu':'Đã ẩn video khỏi trang giới thiệu'};
  }

  async list(publicOnly=false){
    const [rows]=await pool.query(
      `SELECT a.*,s.name sponsor_name,s.logo_url,s.website_url
       FROM sponsor_ad_campaigns a
       LEFT JOIN sponsors s ON s.id=a.sponsor_id
       ${publicOnly?'WHERE a.is_public=1 AND a.del_flg=0':'WHERE a.del_flg=0'}
       ORDER BY a.campaign_date DESC,a.id DESC`
    );
    return rows;
  }

  async softDelete(id,reason){
    await pool.query(`UPDATE sponsor_ad_campaigns SET del_flg=1,deleted_at=NOW(),deleted_reason=?,is_public=0 WHERE id=?`,[reason||'',id]);
    return {message:'Đã xóa mềm video'};
  }

  async restore(id){
    await pool.query(`UPDATE sponsor_ad_campaigns SET del_flg=0,deleted_at=NULL,deleted_reason=NULL WHERE id=?`,[id]);
    return {message:'Đã khôi phục video'};
  }

  async hardDelete(id){
    await pool.query(`DELETE FROM sponsor_ad_campaigns WHERE id=?`,[id]);
    return {message:'Đã xóa vĩnh viễn video'};
  }

  async deleted(){
    const [rows]=await pool.query(`SELECT a.*,s.name sponsor_name FROM sponsor_ad_campaigns a LEFT JOIN sponsors s ON s.id=a.sponsor_id WHERE a.del_flg=1 ORDER BY a.deleted_at DESC`);
    return rows;
  }

  async publicPortalVideos(){
    const rows=await this.list(true);
    return {
      home_hero:rows.filter(x=>x.placement==='HOME_HERO'),
      sponsor_section:rows.filter(x=>x.placement==='SPONSOR_SECTION'),
      about_section:rows.filter(x=>x.placement==='ABOUT_SECTION'),
      footer_ad:rows.filter(x=>x.placement==='FOOTER_AD')
    };
  }
}

module.exports=new SponsorVideoAgent();
