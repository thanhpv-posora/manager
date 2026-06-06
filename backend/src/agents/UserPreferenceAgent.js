const pool=require('../config/db');

class UserPreferenceAgent{
  constructor(){
    this.version='6.35.3';
    this.responsibility='Remember user UI defaults such as product category, unit, inventory mode';
  }

  async get(user,key){
    const [rows]=await pool.query(
      `SELECT pref_value FROM user_app_preferences WHERE user_id=? AND pref_key=? LIMIT 1`,
      [user.id,key]
    );
    if(!rows.length)return {};
    try{
      return typeof rows[0].pref_value==='string'?JSON.parse(rows[0].pref_value):(rows[0].pref_value||{});
    }catch{
      return {};
    }
  }

  async save(user,key,value){
    await pool.query(
      `INSERT INTO user_app_preferences(user_id,pref_key,pref_value)
       VALUES(?,?,CAST(? AS JSON))
       ON DUPLICATE KEY UPDATE pref_value=VALUES(pref_value),updated_at=NOW()`,
      [user.id,key,JSON.stringify(value||{})]
    );
    return {message:'Đã lưu mặc định người dùng',value};
  }
}

module.exports=new UserPreferenceAgent();
