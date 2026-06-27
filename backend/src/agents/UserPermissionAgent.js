const pool=require('../config/db');

class UserPermissionAgent{
  constructor(){
    this.version='6.71.0';
    this.responsibility='Control menu/function visibility by role and by individual user. role_menu_permissions is the single source of role defaults.';
  }

  async users(){
    const [rows]=await pool.query(`SELECT id,username,full_name,role,customer_id,is_active FROM users ORDER BY id`);
    return rows;
  }

  async getAllMenus(){
    const [rows]=await pool.query(
      `SELECT menu_key,title,subtitle,route,page_component,icon_key,group_key,
              parent_menu_key,menu_type,sort_order,is_system,is_active,visible_in_sidebar
       FROM app_menus WHERE is_active=1 ORDER BY group_key,sort_order`
    );
    return rows;
  }

  async getEffectiveMenus(user){
    // role_menu_permissions is the ONLY source of role defaults — no JS fallback
    const [roleRows]=await pool.query(
      `SELECT rmp.menu_key FROM role_menu_permissions rmp
       JOIN app_menus am ON am.menu_key=rmp.menu_key AND am.is_active=1
       WHERE rmp.role=? AND rmp.is_enabled=1`,
      [user.role]
    );
    const allowed=new Set(roleRows.map(r=>r.menu_key));
    // user_menu_permissions: per-user grant/revoke on top of role defaults
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
    const allMenus=await this.getAllMenus();
    return {user,effective,override,allMenus};
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
    const allowedMenus=await this.getEffectiveMenus(user);
    const allowedSet=new Set(allowedMenus);
    const allMenus=await this.getAllMenus();

    // Filter to allowed menus only — access gate; preferences cannot expand this
    const allowed=allMenus.filter(m=>allowedSet.has(m.menu_key));

    // Load user_menu_preferences joined by menu_id → resolve menu_key
    const [prefRows]=await pool.query(
      `SELECT ump.sort_order,ump.is_pinned,ump.is_hidden,am.menu_key
       FROM user_menu_preferences ump
       JOIN app_menus am ON am.id=ump.menu_id
       WHERE ump.user_id=?`,
      [user.id]
    );
    const prefMap={};
    for(const p of prefRows) prefMap[p.menu_key]=p;

    // sidebar menus: allowed + visible_in_sidebar=1 + not user-hidden
    // sort: pinned first → user sort_order → app_menus.sort_order → title
    const menus=allowed
      .filter(m=>m.visible_in_sidebar&&!prefMap[m.menu_key]?.is_hidden)
      .sort((a,b)=>{
        const pa=prefMap[a.menu_key], pb=prefMap[b.menu_key];
        const pinnedDiff=(pa?.is_pinned?0:1)-(pb?.is_pinned?0:1);
        if(pinnedDiff!==0) return pinnedDiff;
        const orderA=pa?.sort_order??a.sort_order;
        const orderB=pb?.sort_order??b.sort_order;
        if(orderA!==orderB) return orderA-orderB;
        return (a.title||'').localeCompare(b.title||'','vi');
      });

    return {allowedMenus,menus,allMenus};
  }
}
module.exports=new UserPermissionAgent();
