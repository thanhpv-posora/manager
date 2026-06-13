const pool = require('../config/db');
const SoftDeleteAgent = require('./SoftDeleteAgent');
const { productOwnerWhere, isAdmin } = require('../middleware/scope');

class ProductAgent {
  async nextProductCode(categoryId, user=null) {
    const [cats] = await pool.query(`SELECT id,name FROM product_categories WHERE id=?`, [categoryId]);
    const name = cats[0]?.name || 'SP';
    let prefix = 'SP';
    if (name.includes('bò') || name.includes('Bò')) prefix = 'BO';
    else if (name.includes('heo') || name.includes('Heo')) prefix = 'HEO';
    else if (name.includes('gà') || name.includes('Gà')) prefix = 'GA';
    else if (name.includes('vịt') || name.includes('Vịt')) prefix = 'VIT';
    else if (name.includes('chả') || name.includes('Chả')) prefix = 'CHA';
    else {
      prefix = name.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9]/g,'').slice(0,3).toUpperCase() || 'SP';
    }
    const like = `${prefix}%`;
    const own = productOwnerWhere(user,'products');
    const [rows] = await pool.query(`SELECT product_code FROM products WHERE product_code LIKE ? ${own.sql} ORDER BY id DESC LIMIT 1`, [like, ...own.params]);
    let n = 1;
    if(rows.length) {
      const m = String(rows[0].product_code).match(/(\d+)$/);
      if(m) n = Number(m[1]) + 1;
    }
    return `${prefix}${String(n).padStart(4,'0')}`;
  }

  constructor(){this.version='6.43.0';this.responsibility='Product/category CRUD, inventory mode, carcass/non-stock option, duplicate name check, del_flg soft delete warning, prices';}

  normalizeName(name){
    return String(name||'').trim().toLowerCase();
  }

  async assertUniqueProductName(name, excludeId=null, user=null){
    const normalized=this.normalizeName(name);
    if(!normalized) throw new Error('Thiếu tên hàng');
    const params=[normalized];
    let sql=`SELECT id,name FROM products WHERE del_flg=0 AND LOWER(TRIM(name))=?`;
    if(user && !isAdmin(user)){ sql += ` AND created_by=?`; params.push(user.id); }
    if(excludeId){
      sql+=` AND id<>?`;
      params.push(excludeId);
    }
    sql+=` LIMIT 1`;
    const [rows]=await pool.query(sql,params);
    if(rows.length){
      throw new Error(`Tên mặt hàng đã tồn tại: ${rows[0].name}. Không được nhập trùng dù khác chữ hoa/thường.`);
    }
  }



  async ensureProductAccess(id,user){
    if(!user || isAdmin(user)) return;
    const [rows]=await pool.query(`SELECT id FROM products WHERE id=? AND del_flg=0 AND created_by=? LIMIT 1`,[id,user.id]);
    if(!rows.length){
      const err=new Error('Không có quyền thao tác mặt hàng này');
      err.status=403;
      throw err;
    }
  }

  async categories() {
    const [rows] = await pool.query(`SELECT * FROM product_categories WHERE del_flg=0 AND is_active=1 ORDER BY sort_order,id`);
    return rows;
  }

  async addCategory(data) {
    if(!data.name) throw new Error('Thiếu tên nhóm hàng');
    await pool.query(`INSERT INTO product_categories(name,sort_order,is_active,del_flg) VALUES(?,?,1,0)`, [data.name, data.sort_order||0]);
    return {message:'Đã thêm nhóm hàng'};
  }

  async updateCategory(id,data) {
    await pool.query(`UPDATE product_categories SET name=?,sort_order=?,is_active=? WHERE id=? AND del_flg=0`, [data.name,data.sort_order||0,data.is_active?1:0,id]);
    return {message:'Đã sửa nhóm hàng'};
  }

  async removeCategory(id, reason, userId) {
    return SoftDeleteAgent.softDelete('category', id, reason, userId);
  }

  async products(q='', user=null) {
    const like = `%${q}%`;
    const own = productOwnerWhere(user,'p');
    const [rows] = await pool.query(
      `SELECT p.*,pc.name category_name, pp.name parent_product_name
       FROM products p
       LEFT JOIN product_categories pc ON pc.id=p.category_id
       LEFT JOIN products pp ON pp.id=p.parent_product_id
       WHERE p.del_flg=0 AND p.is_active=1 ${own.sql} AND (p.name LIKE ? OR p.product_code LIKE ?)
       ORDER BY pc.sort_order,p.name`,
      [...own.params,like,like]
    );
    return rows;
  }

  async addProduct(data, user=null) {
    if(!data.name) throw new Error('Thiếu tên hàng');
    await this.assertUniqueProductName(data.name,null,user);
    if(!data.product_code) data.product_code = await this.nextProductCode(data.category_id,user);
    await pool.query(
      `INSERT INTO products(category_id,product_code,name,unit,default_sale_price,default_purchase_price,stock_quantity,low_stock_threshold,note,is_active,del_flg,inventory_mode,parent_product_id,carcass_group,allow_negative_stock,created_by)
       VALUES(?,?,?,?,?,?,?,?,?,1,0,?,?,?,?,?)`,
      [data.category_id||null,data.product_code,data.name,data.unit||'kg',data.default_sale_price||0,data.default_purchase_price||0,data.stock_quantity||0,data.low_stock_threshold||5,data.note||'',data.inventory_mode||'STOCK',data.parent_product_id||null,data.carcass_group||null,data.allow_negative_stock?1:0,user?.id||null]
    );
    return {message:'Đã thêm mặt hàng'};
  }

  async updateProduct(id,data,user=null) {
    if(!data.name) throw new Error('Thiếu tên hàng');
    await this.ensureProductAccess(id,user);
    await this.assertUniqueProductName(data.name,id,user);
    await pool.query(
      `UPDATE products SET category_id=?,name=?,unit=?,default_sale_price=?,default_purchase_price=?,stock_quantity=?,low_stock_threshold=?,note=?,is_active=?,inventory_mode=?,parent_product_id=?,carcass_group=?,allow_negative_stock=? WHERE id=? AND del_flg=0`,
      [data.category_id||null,data.name,data.unit||'kg',data.default_sale_price||0,data.default_purchase_price||0,data.stock_quantity||0,data.low_stock_threshold||5,data.note||'',data.is_active?1:0,data.inventory_mode||'STOCK',data.parent_product_id||null,data.carcass_group||null,data.allow_negative_stock?1:0,id]
    );
    return {message:'Đã sửa mặt hàng'};
  }

  async updatePrice(id, data, user=null) {
    await this.ensureProductAccess(id,user);
    const own=productOwnerWhere(user,'products');
    await pool.query(`UPDATE products SET default_sale_price=?,default_purchase_price=? WHERE id=? AND del_flg=0 ${own.sql}`, [data.default_sale_price||0,data.default_purchase_price||0,id,...own.params]);
    return {message:'Đã sửa giá mặt hàng'};
  }

  async removeProduct(id, reason, userId, user=null) {
    await this.ensureProductAccess(id,user);
    return SoftDeleteAgent.softDelete('product', id, reason, userId);
  }

  async customerProducts(customerId, user=null) {
    const [customers] = await pool.query(`SELECT * FROM customers WHERE id=? AND del_flg=0`, [customerId]);
    if (!customers.length) throw new Error('Không tìm thấy khách');
    const own=productOwnerWhere(user,'p');
    const [rows] = await pool.query(
      `SELECT p.id product_id,p.product_code,p.name product_name,p.unit,p.stock_quantity,p.default_sale_price,p.default_purchase_price,p.inventory_mode,p.allow_negative_stock,
       COALESCE(cpp.sale_price,p.default_sale_price) sale_price,
       CASE WHEN cpp.sale_price IS NOT NULL THEN 'PRIVATE_PRICE' ELSE 'COMMON_PRICE' END price_type,
       pc.name category_name
       FROM products p
       LEFT JOIN product_categories pc ON pc.id=p.category_id
       LEFT JOIN customer_product_prices cpp ON cpp.product_id=p.id AND cpp.customer_id=? AND cpp.is_active=1
       WHERE p.del_flg=0 AND p.is_active=1 ${own.sql}
       ORDER BY CASE WHEN cpp.sale_price IS NOT NULL THEN 0 ELSE 1 END,pc.sort_order,p.name`,
      [customerId, ...own.params]
    );
    return {customer:customers[0], products:rows};
  }

  async updateCustomerPrice(customerId, productId, salePrice, user=null) {
    await this.ensureProductAccess(productId,user);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(`UPDATE customer_product_prices SET is_active=0 WHERE customer_id=? AND product_id=? AND is_active=1`, [customerId,productId]);
      await conn.query(`INSERT INTO customer_product_prices(customer_id,product_id,sale_price,effective_from,is_active) VALUES(?,?,?,CURDATE(),1)`, [customerId,productId,salePrice]);
      await conn.commit();
      return {message:'Đã sửa giá riêng'};
    } catch(e) {
      await conn.rollback(); throw e;
    } finally { conn.release(); }
  }

  async markCarcassParts() {
    await pool.query(
      `UPDATE products
       SET inventory_mode='CARCASS_PART', allow_negative_stock=1
       WHERE del_flg=0
         AND (
           product_code LIKE 'BO_%'
           OR name LIKE '%bò%'
           OR name LIKE '%Đùi%'
           OR name LIKE '%đùi%'
           OR name LIKE '%Búp%'
           OR name LIKE '%búp%'
           OR name LIKE '%Nạm%'
           OR name LIKE '%nạm%'
           OR name LIKE '%Sườn%'
           OR name LIKE '%sườn%'
           OR name LIKE '%Thăn%'
           OR name LIKE '%thăn%'
         )
         AND inventory_mode='STOCK'`
    );
    return {message:'Đã chuyển nhóm bò/pha lóc sang CARCASS_PART, không kiểm tồn từng phần'};
  }

  async quickProduct(data, user=null) {
    if(!data.name) throw new Error('Thiếu tên hàng');
    await this.assertUniqueProductName(data.name,null,user);
    const code = data.product_code || await this.nextProductCode(data.category_id,user);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [r] = await conn.query(
        `INSERT INTO products(category_id,product_code,name,unit,default_sale_price,default_purchase_price,low_stock_threshold,inventory_mode,allow_negative_stock,del_flg,created_by)
         VALUES(?,?,?,?,?,?,?,?,?,0,?)`,
        [data.category_id||null,code,data.name,data.unit||'kg',data.sale_price||0,0,5,data.inventory_mode||'STOCK',data.allow_negative_stock?1:0,user?.id||null]
      );
      if (data.customer_id) {
        await conn.query(
          `INSERT INTO customer_product_catalogs(customer_id,product_id,sort_order,is_default,is_active,del_flg)
           VALUES(?,?,999,1,1,0)
           ON DUPLICATE KEY UPDATE is_default=1,is_active=1,del_flg=0`,
          [data.customer_id,r.insertId]
        );
      }
      if (data.customer_id && (data.private_price || data.sale_price)) {
        await conn.query(`INSERT INTO customer_product_prices(customer_id,product_id,sale_price,effective_from,is_active) VALUES(?,?,?,CURDATE(),1)`, [data.customer_id,r.insertId,data.private_price||data.sale_price]);
      }
      await conn.commit();
      return {message:'Đã thêm mặt hàng nhanh và đưa vào danh mục khách', product_id:r.insertId, product_code:code};
    } catch(e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }
}
module.exports = new ProductAgent();
