const pool=require('../config/db');

const PROVIDERS=[
  {key:'TESSERACT',name:'Tesseract Local',type:'browser',quality:'basic',cost:'free'},
  {key:'GOOGLE_DOCUMENT_AI',name:'Google Document AI',type:'cloud',quality:'advanced',cost:'paid'},
  {key:'AZURE_DOCUMENT',name:'Azure Document Intelligence',type:'cloud',quality:'advanced',cost:'paid'},
  {key:'PADDLE_OCR',name:'PaddleOCR Server',type:'self_hosted',quality:'advanced',cost:'server'}
];

const MODULES=[
  {key:'product-import',name:'Import mặt hàng từ ảnh',recommended:'GOOGLE_DOCUMENT_AI'},
  {key:'order-import',name:'Tạo bill từ ảnh',recommended:'GOOGLE_DOCUMENT_AI'},
  {key:'handwriting-bill',name:'Bill viết tay',recommended:'GOOGLE_DOCUMENT_AI'},
  {key:'supplier-lot-import',name:'Nhập lô/NCC từ ảnh',recommended:'GOOGLE_DOCUMENT_AI'}
];

class OCRProviderAgent{
  constructor(){
    this.version='6.35.0';
    this.responsibility='Manage advanced OCR providers per module: Tesseract, Google Document AI, Azure, PaddleOCR';
  }

  async providers(){return {providers:PROVIDERS,modules:MODULES};}

  async configs(){
    const [rows]=await pool.query(`SELECT id,module_key,provider,endpoint_url,project_id,processor_id,location_id,is_active,note,created_at,updated_at FROM ocr_provider_configs ORDER BY module_key,provider`);
    return rows;
  }

  async saveConfig(data){
    if(!data.module_key||!data.provider) throw new Error('Thiếu module hoặc provider');
    await pool.query(
      `INSERT INTO ocr_provider_configs(module_key,provider,endpoint_url,api_key,project_id,processor_id,location_id,is_active,note)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE endpoint_url=VALUES(endpoint_url),api_key=VALUES(api_key),project_id=VALUES(project_id),
       processor_id=VALUES(processor_id),location_id=VALUES(location_id),is_active=VALUES(is_active),note=VALUES(note),updated_at=NOW()`,
      [data.module_key,data.provider,data.endpoint_url||'',data.api_key||'',data.project_id||'',data.processor_id||'',data.location_id||'',data.is_active?1:0,data.note||'']
    );
    return {message:'Đã lưu cấu hình OCR provider'};
  }

  async activeConfig(moduleKey){
    const [rows]=await pool.query(`SELECT id,module_key,provider,endpoint_url,project_id,processor_id,location_id,is_active,note FROM ocr_provider_configs WHERE module_key=? AND is_active=1 ORDER BY id DESC LIMIT 1`,[moduleKey]);
    return rows[0]||{module_key:moduleKey,provider:'TESSERACT',is_active:1,note:'Fallback local OCR'};
  }

  async parseExternal(moduleKey,payload){
    const cfg=await this.activeConfig(moduleKey);
    if(cfg.provider==='TESSERACT'){
      return {provider:'TESSERACT',mode:'client',message:'Tesseract chạy phía trình duyệt, backend không xử lý OCR'};
    }
    if(cfg.provider==='PADDLE_OCR'){
      if(!cfg.endpoint_url) throw new Error('PaddleOCR cần endpoint_url');
      return {provider:'PADDLE_OCR',mode:'server',endpoint_url:cfg.endpoint_url,message:'Frontend gửi ảnh/text tới PaddleOCR server theo endpoint đã cấu hình'};
    }
    if(cfg.provider==='GOOGLE_DOCUMENT_AI'){
      return {provider:'GOOGLE_DOCUMENT_AI',mode:'cloud_adapter',message:'Cấu hình Google Document AI đã lưu. Cần service account/server adapter để gọi thật.'};
    }
    if(cfg.provider==='AZURE_DOCUMENT'){
      return {provider:'AZURE_DOCUMENT',mode:'cloud_adapter',message:'Cấu hình Azure Document Intelligence đã lưu. Cần endpoint/api_key để gọi thật.'};
    }
    return {provider:cfg.provider,message:'Provider chưa hỗ trợ'};
  }
}
module.exports=new OCRProviderAgent();
