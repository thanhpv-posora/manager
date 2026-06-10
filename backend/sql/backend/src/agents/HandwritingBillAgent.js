const pool=require('../config/db');
class HandwritingBillAgent{
  constructor(){this.version='6.22.0';this.responsibility='Handwriting bill OCR, 3-digit decimal quantity rule, alias learning';}
  async aliases(customerId){
    const [rows]=await pool.query(`SELECT a.*,p.name product_name,p.product_code FROM product_ocr_aliases a JOIN products p ON p.id=a.product_id WHERE a.customer_id IS NULL OR a.customer_id=? ORDER BY a.hit_count DESC,a.updated_at DESC`,[customerId||0]);
    return rows;
  }
  async saveAlias(data){
    if(!data.alias_text||!data.product_id)throw new Error('Thiếu alias hoặc mặt hàng');
    await pool.query(`INSERT INTO product_ocr_aliases(customer_id,alias_text,product_id,source,hit_count) VALUES(?,?,?,?,1) ON DUPLICATE KEY UPDATE hit_count=hit_count+1,updated_at=NOW()`,[data.customer_id||null,String(data.alias_text).toLowerCase().trim(),data.product_id,data.source||'HANDWRITING']);
    return {message:'Đã học alias OCR cho mặt hàng'};
  }
}
module.exports=new HandwritingBillAgent();
