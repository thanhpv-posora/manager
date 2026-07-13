const pool=require('../config/db');
const { refreshQuantityDecimalPlaces } = require('../utils/quantityFormat');

class SettingsAgent {
  constructor(){
    this.version='6.14.0';
    this.responsibility='Business edition shop settings, branding, print defaults';
  }

  async getAll(){
    const [rows]=await pool.query(`SELECT setting_key,setting_value FROM business_settings ORDER BY setting_key`);
    const obj={};
    for(const r of rows) obj[r.setting_key]=r.setting_value;
    return obj;
  }

  async save(data){
    const conn=await pool.getConnection();
    try{
      await conn.beginTransaction();
      for(const [k,v] of Object.entries(data||{})){
        await conn.query(
          `INSERT INTO business_settings(setting_key,setting_value) VALUES(?,?)
           ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value), updated_at=NOW()`,
          [k, String(v ?? '')]
        );
      }
      await conn.commit();
      if(Object.prototype.hasOwnProperty.call(data||{},'quantity_decimal_places')) await refreshQuantityDecimalPlaces();
      return {message:'Đã lưu cấu hình cửa hàng'};
    }catch(e){await conn.rollback();throw e;}finally{conn.release();}
  }
}
module.exports=new SettingsAgent();
