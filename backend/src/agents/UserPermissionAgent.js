const pool=require('../config/db');

const DEFAULT_MENUS=[
 'dashboard','create-order','orders','payments','installments','customers',
 'products','product-import','ocr-providers','price-matrix',
 'lots','units','supplier-purchase-options','inventory-purchases',
 'revenue','profit','agents','production-check',
 'trash','settings','portal','sponsor-videos',
 'user-permissions','registrations','user-mapping'
];

function defaultsForRole(role){
  if(role==='CUSTOMER') return ['orders','payments','portal','customers'];
  if(role==='STAFF') return ['create-order','orders','payments','customers','products','product-import','ocr-providers','price-matrix','lots','revenue','profit','portal'];
  return DEFAULT_MENUS;
}

class UserPermissionAgent{
  constructor(){
    this.version='6.44.0';
    this.responsibility='Control menu/function visibility by role and by individual user';
  }

  async users(){
    const [rows]=await pool.query(`SELECT id,username,full_name,role,customer_id,is_active FROM users ORDER BY id`);
    return rows;
  }

  async getEffectiveMenus(user){
    const base=defaultsForRole(user.role);
    const [roleRows]=await pool.query(`SELECT menu_key,is_enabled FROM role_menu_permissions WHERE role=?`,[user.role]);
    let allowed=new Set(base);
    for(const r of roleRows){
      if(r.is_enabled) allowed.add(r.menu_key); else allowed.delete(r.menu_key);
    }
    const [userRows]=await pool.query(`SELECT menu_key,is_enabled FROM user_menu_permissions WHERE user_id=?`,[user.id]);
    for(const r of userRows){
      if(r.is_enabled) allowed.add(r.menu_key); else allowed.delete(r.menu_key);
    }
    return Array.from(allowed);
  }

  async getUserMenus(userId){
    const [users]=await pool.query(`SELECT id,username,full_name,role,customer_id,is_active FROM users WHERE id=?`,[userId]);
    if(!users.length) throw new Error('Không tìm thấy user');
    const user=users[0];
    const effective=await this.getEffectiveMenus(user);
    const [rows]=await pool.query(`SELECT menu_key,is_enabled FROM user_menu_permissions WHERE user_id=?`,[userId]);
    const override={}; rows.forEach(r=>override[r.menu_key]=!!r.is_enabled);
    return {user,effective,override,all_menus:DEFAULT_MENUS};
  }

  async saveUserMenus(userId,menus,updatedBy){
    const conn=await pool.getConnection();
    try{
      await conn.beginTransaction();
      await conn.query(`DELETE FROM user_menu_permissions WHERE user_id=?`,[userId]);
      for(const m of menus||[]){
        await conn.query(`INSERT INTO user_menu_permissions(user_id,menu_key,is_enabled,updated_by) VALUES(?,?,?,?)`,
          [userId,m.menu_key,m.is_enabled?1:0,updatedBy||null]);
      }
      await conn.commit();
      return {message:'Đã lưu phân quyền menu cho user'};
    }catch(e){await conn.rollback();throw e;}finally{conn.release();}
  }

  async me(user){
    return {menus:await this.getEffectiveMenus(user)};
  }
}
module.exports=new UserPermissionAgent();
