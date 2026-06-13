const pool = require('../config/db');

function normalizeRowsV636(rows){
  return (rows||[]).map((r,idx)=>({
    product_id:Number(r.product_id||r.id),
    sort_order:Number(r.sort_order||idx+1),
    private_price:Number(String(r.private_price||r.price||0).replace(/[,\s]/g,''))||0,
    is_default:r.is_default?1:0,
    is_active:r.is_active===0?0:1
  })).filter(x=>x.product_id);
}

class PriceMatrixAgent {
  constructor(){
    this.version='6.59.0';
    this.responsibility='User-scoped private price matrix and customer catalog';
    this._schemaReady=false;
  }

  async ensureProductScopeSchema(){
    if(this._schemaReady)return;
    await this.ensureColumn('products','product_owner_user_id','BIGINT NULL');
    await this.ensureColumn('products','owner_prefix','VARCHAR(50) NULL');
    await this.ensureColumn('products','created_by','BIGINT NULL');
    this._schemaReady=true;
  }

  async ensureColumn(table,column,definition){
    const [rows]=await pool.query(
      `SELECT COUNT(*) cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?`,
      [table,column]
    );
    if(Number(rows[0].cnt)===0) await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  isAdmin(user){return String(user?.role||'').toUpperCase()==='ADMIN';}
  ownerId(user){return user?.id?Number(user.id):null;}
  productScope(user,alias='p'){
    if(this.isAdmin(user))return {sql:'',params:[]};
    const uid=this.ownerId(user);
    if(!uid)return {sql:' AND 1=0',params:[]};
    return {sql:` AND ${alias}.product_owner_user_id=?`,params:[uid]};
  }

  async ensureCustomerAccess(customerId,user){
    if(user&&user.role==='CUSTOMER'){
      const [rows]=await pool.query(`SELECT id FROM customers WHERE id=? AND (id=? OR parent_customer_id=?) AND del_flg=0`,[customerId,user.customer_id,user.customer_id]);
      if(!rows.length) throw new Error('Không có quyền xem khách hàng này');
    }
  }

  async assertProductAccess(productId,user,conn=pool){
    await this.ensureProductScopeSchema();
    if(this.isAdmin(user))return;
    const uid=this.ownerId(user);
    const [rows]=await conn.query(`SELECT id FROM products WHERE id=? AND product_owner_user_id=? AND del_flg=0 LIMIT 1`,[productId,uid]);
    if(!rows.length){
      const err=new Error('Không có quyền dùng mặt hàng này trong bảng giá riêng');
      err.status=403;
      throw err;
    }
  }

  async matrix(customerId,user=null) {
    await this.ensureProductScopeSchema();
    await this.ensureCustomerAccess(customerId,user);
    const [customers] = await pool.query(`SELECT * FROM customers WHERE id=? AND del_flg=0`, [customerId]);
    if(!customers.length) throw new Error('Không tìm thấy khách hàng');
    const scope=this.productScope(user,'p');
    const [rows] = await pool.query(
      `SELECT p.id product_id, p.product_code, p.name product_name, p.unit, p.default_sale_price,
              p.inventory_mode, p.stock_quantity, pc.name category_name,
              cpc.id catalog_id,
              COALESCE(cpc.is_default,0) in_catalog,
              COALESCE(cpc.sort_order,p.id) sort_order,
              cpp.sale_price private_price,
              COALESCE(cpp.sale_price,p.default_sale_price) effective_price,
              CASE WHEN cpp.sale_price IS NULL THEN 'COMMON_PRICE' ELSE 'PRIVATE_PRICE' END price_type
       FROM products p
       LEFT JOIN product_categories pc ON pc.id=p.category_id
       LEFT JOIN customer_product_catalogs cpc
              ON cpc.product_id=p.id AND cpc.customer_id=? AND cpc.del_flg=0 AND cpc.is_active=1
       LEFT JOIN customer_product_prices cpp
              ON cpp.product_id=p.id AND cpp.customer_id=? AND cpp.is_active=1
       WHERE p.del_flg=0 AND p.is_active=1 ${scope.sql}
       ORDER BY COALESCE(cpc.is_default,0) DESC, COALESCE(cpc.sort_order,p.id), pc.sort_order, p.name`,
      [customerId, customerId, ...scope.params]
    );
    return {customer:customers[0], rows};
  }

  async saveMatrix(customerId, items, user=null) {
    await this.ensureProductScopeSchema();
    await this.ensureCustomerAccess(customerId,user);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for(const it of items || []) {
        const productId = it.product_id;
        await this.assertProductAccess(productId,user,conn);
        const inCatalog = it.in_catalog ? 1 : 0;
        const sortOrder = Number(it.sort_order || 0);
        const price = it.private_price === '' || it.private_price === null || it.private_price === undefined ? null : Number(it.private_price || 0);
        if(inCatalog) {
          await conn.query(
            `INSERT INTO customer_product_catalogs(customer_id,product_id,sort_order,is_default,is_active,del_flg)
             VALUES(?,?,?,?,1,0)
             ON DUPLICATE KEY UPDATE sort_order=VALUES(sort_order), is_default=1, is_active=1, del_flg=0`,
            [customerId, productId, sortOrder, 1]
          );
        } else {
          await conn.query(`UPDATE customer_product_catalogs SET is_default=0,is_active=0,del_flg=1 WHERE customer_id=? AND product_id=?`,[customerId, productId]);
        }
        if(price !== null && !Number.isNaN(price)) {
          const [oldRows] = await conn.query(`SELECT sale_price FROM customer_product_prices WHERE customer_id=? AND product_id=? AND is_active=1 LIMIT 1`,[customerId, productId]);
          const oldPrice = oldRows.length ? oldRows[0].sale_price : null;
          await conn.query(`UPDATE customer_product_prices SET is_active=0 WHERE customer_id=? AND product_id=? AND is_active=1`,[customerId, productId]);
          await conn.query(`INSERT INTO customer_product_prices(customer_id,product_id,sale_price,effective_from,is_active) VALUES(?,?,?,CURDATE(),1)`,[customerId, productId, price]);
          await conn.query(`INSERT INTO price_change_logs(customer_id,product_id,old_price,new_price,reason,changed_by) VALUES(?,?,?,?,?,?)`,[customerId, productId, oldPrice, price, 'V6.59 user-scoped price matrix update', user?.id || null]);
        }
      }
      await conn.commit();
      return {message:'Đã lưu bảng giá riêng và gói danh mục khách hàng'};
    } catch(e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }

  async customerCatalogForOrder(customerId,user=null) {
    await this.ensureProductScopeSchema();
    await this.ensureCustomerAccess(customerId,user);
    const [customers] = await pool.query(`SELECT * FROM customers WHERE id=? AND del_flg=0`, [customerId]);
    if(!customers.length) throw new Error('Không tìm thấy khách hàng');
    const scope=this.productScope(user,'p');
    const [catalogRows] = await pool.query(
      `SELECT p.id product_id, p.product_code, p.name product_name, p.unit, p.stock_quantity,
              p.inventory_mode, p.allow_negative_stock, pc.name category_name,
              COALESCE(cpp.sale_price,p.default_sale_price) sale_price,
              CASE WHEN cpp.sale_price IS NULL THEN 'COMMON_PRICE' ELSE 'PRIVATE_PRICE' END price_type,
              cpc.sort_order
       FROM customer_product_catalogs cpc
       JOIN products p ON p.id=cpc.product_id AND p.del_flg=0 AND p.is_active=1 ${scope.sql}
       LEFT JOIN product_categories pc ON pc.id=p.category_id
       LEFT JOIN customer_product_prices cpp ON cpp.product_id=p.id AND cpp.customer_id=cpc.customer_id AND cpp.is_active=1
       WHERE cpc.customer_id=? AND cpc.del_flg=0 AND cpc.is_active=1 AND cpc.is_default=1
       ORDER BY cpc.sort_order, pc.sort_order, p.name`,
      [...scope.params, customerId]
    );
    if(catalogRows.length) return {customer:customers[0], products:catalogRows, source:'CUSTOMER_CATALOG'};
    const [fallback] = await pool.query(
      `SELECT p.id product_id, p.product_code, p.name product_name, p.unit, p.stock_quantity,
              p.inventory_mode, p.allow_negative_stock, pc.name category_name,
              COALESCE(cpp.sale_price,p.default_sale_price) sale_price,
              CASE WHEN cpp.sale_price IS NULL THEN 'COMMON_PRICE' ELSE 'PRIVATE_PRICE' END price_type,
              p.id sort_order
       FROM products p
       LEFT JOIN product_categories pc ON pc.id=p.category_id
       LEFT JOIN customer_product_prices cpp ON cpp.product_id=p.id AND cpp.customer_id=? AND cpp.is_active=1
       WHERE p.del_flg=0 AND p.is_active=1 ${scope.sql}
       ORDER BY pc.sort_order, p.name`,
      [customerId,...scope.params]
    );
    return {customer:customers[0], products:fallback, source:'USER_PRODUCTS_FALLBACK'};
  }

  async reorderCatalog(customerId, items, user=null) {
    await this.ensureCustomerAccess(customerId,user);
    const conn = await pool.getConnection();
    try { await conn.beginTransaction();
      for(const it of items || []) {
        await this.assertProductAccess(it.product_id,user,conn);
        await conn.query(`UPDATE customer_product_catalogs SET sort_order=? WHERE customer_id=? AND product_id=? AND del_flg=0`,[Number(it.sort_order||0), customerId, it.product_id]);
      }
      await conn.commit(); return {message:'Đã cập nhật thứ tự danh mục khách'};
    } catch(e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }

  async addCatalog(customerId, productId, sortOrder, user=null){
    await this.ensureCustomerAccess(customerId,user);
    await this.assertProductAccess(productId,user);
    await pool.query(`INSERT INTO customer_product_catalogs(customer_id,product_id,sort_order,is_default,is_active,del_flg)
      VALUES(?,?,?,1,1,0)
      ON DUPLICATE KEY UPDATE is_active=1,del_flg=0,sort_order=VALUES(sort_order)`,[customerId,productId,sortOrder||999]);
    return {message:'Đã thêm mặt hàng vào danh mục khách'};
  }

  async copyCatalog(fromCustomerId, toCustomerId, user=null) {
    await this.ensureCustomerAccess(fromCustomerId,user);
    await this.ensureCustomerAccess(toCustomerId,user);
    const conn = await pool.getConnection();
    try { await conn.beginTransaction();
      const scope=this.productScope(user,'p');
      const [items] = await conn.query(
        `SELECT cpc.product_id, cpc.sort_order, cpc.is_default FROM customer_product_catalogs cpc JOIN products p ON p.id=cpc.product_id ${scope.sql}
         WHERE cpc.customer_id=? AND cpc.del_flg=0 AND cpc.is_active=1`,
        [...scope.params, fromCustomerId]
      );
      for(const it of items) {
        await conn.query(`INSERT INTO customer_product_catalogs(customer_id,product_id,sort_order,is_default,is_active,del_flg)
           VALUES(?,?,?,?,1,0)
           ON DUPLICATE KEY UPDATE sort_order=VALUES(sort_order), is_default=VALUES(is_default), is_active=1, del_flg=0`,[toCustomerId, it.product_id, it.sort_order, it.is_default]);
      }
      const [prices] = await conn.query(
        `SELECT cpp.product_id, cpp.sale_price FROM customer_product_prices cpp JOIN products p ON p.id=cpp.product_id ${scope.sql}
         WHERE cpp.customer_id=? AND cpp.is_active=1`,
        [...scope.params, fromCustomerId]
      );
      for(const p of prices) {
        await conn.query(`UPDATE customer_product_prices SET is_active=0 WHERE customer_id=? AND product_id=? AND is_active=1`, [toCustomerId, p.product_id]);
        await conn.query(`INSERT INTO customer_product_prices(customer_id,product_id,sale_price,effective_from,is_active) VALUES(?,?,?,CURDATE(),1)`, [toCustomerId, p.product_id, p.sale_price]);
        await conn.query(`INSERT INTO price_change_logs(customer_id,product_id,old_price,new_price,reason,changed_by) VALUES(?,?,?,?,?,?)`, [toCustomerId, p.product_id, null, p.sale_price, `Copy from customer ${fromCustomerId}`, user?.id || null]);
      }
      await conn.commit(); return {message:'Đã copy gói danh mục và bảng giá sang khách mới'};
    } catch(e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }

  async saveAllSafe(customerId,body,user=null){
    return this.saveMatrix(customerId, normalizeRowsV636(body?.items||body?.rows||[]), user);
  }
}
module.exports = new PriceMatrixAgent();
