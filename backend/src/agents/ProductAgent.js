const pool = require('../config/db');
const SoftDeleteAgent = require('./SoftDeleteAgent');
const PriceBookService = require('../services/PriceBookService');
const InventoryService = require('../services/InventoryService');
const { normalizeInventoryMode } = require('../utils/inventoryMode');
const { assertSalesFlowInventoryModeCombo } = require('../utils/productSalesFlow');

// The 3 real inventory_mode values a caller-supplied filter may ask for.
// Kept separate from normalizeInventoryMode()'s legacy-alias/fallback
// behavior (see products() below) — a filter is validated, never coerced.
const VALID_INVENTORY_MODE_FILTERS = ['NON_STOCK', 'TRACK_STOCK', 'CARCASS_PART'];

class ProductAgent {
  async nextProductCode(categoryId) {
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
    const [rows] = await pool.query(`SELECT product_code FROM products WHERE product_code LIKE ? ORDER BY id DESC LIMIT 1`, [like]);
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

  async assertUniqueProductName(name, excludeId=null){
    const normalized=this.normalizeName(name);
    if(!normalized) throw new Error('Thiếu tên hàng');
    const params=[normalized];
    let sql=`SELECT id,name FROM products WHERE del_flg=0 AND LOWER(TRIM(name))=?`;
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


  async categories(includeInactive=false) {
    if(!includeInactive){
      const [rows] = await pool.query(`SELECT * FROM product_categories WHERE del_flg=0 AND is_active=1 ORDER BY sort_order,name`);
      return rows;
    }
    const [rows] = await pool.query(
      `SELECT pc.*, COUNT(p.id) product_count
       FROM product_categories pc
       LEFT JOIN products p ON p.category_id=pc.id AND p.del_flg=0
       WHERE pc.del_flg=0
       GROUP BY pc.id
       ORDER BY pc.sort_order,pc.name`
    );
    return rows;
  }

  async assertUniqueCategoryName(name, excludeId=null){
    const normalized=this.normalizeName(name);
    if(!normalized) throw new Error('Thiếu tên nhóm hàng');
    const params=[normalized];
    let sql=`SELECT id,name FROM product_categories WHERE del_flg=0 AND LOWER(TRIM(name))=?`;
    if(excludeId){
      sql+=` AND id<>?`;
      params.push(excludeId);
    }
    sql+=` LIMIT 1`;
    const [rows]=await pool.query(sql,params);
    if(rows.length){
      throw new Error('Danh mục đã tồn tại');
    }
  }

  async addCategory(data) {
    if(!data.name) throw new Error('Thiếu tên nhóm hàng');
    await this.assertUniqueCategoryName(data.name);
    const [result] = await pool.query(`INSERT INTO product_categories(name,sort_order,is_active,del_flg) VALUES(?,?,?,0)`, [data.name, data.sort_order||0, data.is_active===0||data.is_active===false?0:1]);
    return {message:'Đã thêm nhóm hàng', id: result.insertId};
  }

  async updateCategory(id,data) {
    await pool.query(`UPDATE product_categories SET name=?,sort_order=?,is_active=? WHERE id=? AND del_flg=0`, [data.name,data.sort_order||0,data.is_active?1:0,id]);
    return {message:'Đã sửa nhóm hàng'};
  }

  async removeCategory(id, reason, userId) {
    const [[usage]] = await pool.query(`SELECT COUNT(*) cnt FROM products WHERE category_id=?`, [id]);
    if(Number(usage.cnt) > 0) {
      throw new Error('Danh mục đang được sử dụng, không thể xóa.');
    }
    return SoftDeleteAgent.softDelete('category', id, reason, userId);
  }

  // inventoryMode: optional exact-match filter (e.g. 'TRACK_STOCK'), used by
  // callers like the Inventory Count page that must never receive
  // CARCASS_PART/NON_STOCK rows from the server, not just filter them client-
  // side. Omitted (default '') behaves exactly as before — every existing
  // caller of GET /products without the query param is unaffected.
  //
  // Deliberately NOT run through normalizeInventoryMode() here: that helper's
  // job is to coerce a stored/legacy product value (falling back to NON_STOCK
  // for anything unrecognized), which is correct for reading a product row but
  // wrong for a caller-supplied filter — silently treating a typo'd or unknown
  // value as "NON_STOCK" would return misleadingly filtered data instead of
  // an error. A filter value must be exactly one of the 3 real modes or reject.
  //
  // When inventoryMode is supplied, also joins the latest inventory_adjustments
  // row per product (one aggregate subquery, no N+1) so the Inventory Count
  // grid can show "Lần kiểm kê cuối" without a separate request per product.
  async products(q='', inventoryMode='') {
    const like = `%${q}%`;
    const conds = ['p.del_flg=0','p.is_active=1','(p.name LIKE ? OR p.product_code LIKE ?)'];
    const params = [like,like];
    let lastCountJoin = '';
    let lastCountSelect = '';
    if (inventoryMode) {
      const normalized = String(inventoryMode).toUpperCase();
      if (!VALID_INVENTORY_MODE_FILTERS.includes(normalized)) {
        throw Object.assign(
          new Error(`Chế độ tồn kho không hợp lệ: "${inventoryMode}". Chỉ chấp nhận NON_STOCK, TRACK_STOCK, CARCASS_PART.`),
          { status: 400, statusCode: 400 }
        );
      }
      conds.push('p.inventory_mode=?');
      params.push(normalized);
      lastCountJoin = `LEFT JOIN (SELECT product_id, MAX(created_at) last_count_at FROM inventory_adjustments GROUP BY product_id) la ON la.product_id=p.id`;
      lastCountSelect = ', la.last_count_at';
    }
    const [rows] = await pool.query(
      `SELECT p.*,pc.name category_name, pp.name parent_product_name${lastCountSelect}
       FROM products p
       LEFT JOIN product_categories pc ON pc.id=p.category_id
       LEFT JOIN products pp ON pp.id=p.parent_product_id
       ${lastCountJoin}
       WHERE ${conds.join(' AND ')}
       ORDER BY pc.sort_order,p.name`,
      params
    );
    return rows;
  }

  // S1G: shared by addProduct()/updateProduct() — sales_flow and inventory_mode
  // are both mandatory for every new or edited product (never silently defaulted
  // to TRACK_STOCK/CARCASS_PART anymore), and must be an approved combination.
  // Legacy products already stored with sales_flow=NULL are unaffected by this
  // (they're simply never routed through addProduct/updateProduct again until
  // someone explicitly edits them, at which point classification becomes required).
  assertProductClassification(data) {
    const salesFlow = String(data.sales_flow || '').toUpperCase() || null;
    if (!salesFlow) {
      throw Object.assign(
        new Error('Vui lòng chọn Luồng bán (Bò Xô hoặc Hàng Kho) cho mặt hàng.'),
        { status: 400, statusCode: 400, code: 'PRODUCT_SALES_FLOW_REQUIRED' }
      );
    }
    const inventoryMode = String(data.inventory_mode || '').toUpperCase();
    if (!VALID_INVENTORY_MODE_FILTERS.includes(inventoryMode)) {
      throw Object.assign(
        new Error('Vui lòng chọn Chế độ tồn kho hợp lệ cho mặt hàng.'),
        { status: 400, statusCode: 400, code: 'PRODUCT_INVENTORY_MODE_REQUIRED' }
      );
    }
    assertSalesFlowInventoryModeCombo(salesFlow, inventoryMode);
    return { salesFlow, inventoryMode };
  }

  async addProduct(data) {
    if(!data.name) throw new Error('Thiếu tên hàng');
    await this.assertUniqueProductName(data.name);
    if(!data.product_code) data.product_code = await this.nextProductCode(data.category_id);
    const { salesFlow, inventoryMode } = this.assertProductClassification(data);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [r] = await conn.query(
        `INSERT INTO products(category_id,product_code,name,unit,default_sale_price,default_purchase_price,low_stock_threshold,note,is_active,del_flg,inventory_mode,parent_product_id,carcass_group,allow_negative_stock,sales_flow)
         VALUES(?,?,?,?,?,?,?,?,1,0,?,?,?,?,?)`,
        [data.category_id||null,data.product_code,data.name,data.unit||'kg',data.default_sale_price||0,data.default_purchase_price||0,data.low_stock_threshold||5,data.note||'',inventoryMode,data.parent_product_id||null,data.carcass_group||null,data.allow_negative_stock?1:0,salesFlow]
      );
      const initialQty = Number(data.stock_quantity || 0);
      if (initialQty > 0) {
        await InventoryService.in(conn, r.insertId, initialQty, new Date(), 'MANUAL', null, 'Tồn kho ban đầu khi tạo mặt hàng', null);
      }
      await conn.commit();
      return {message:'Đã thêm mặt hàng'};
    } catch(e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }

  // S1H: Product Domain Integrity Guard. Once a product has participated in
  // any business transaction, sales_flow and inventory_mode become immutable —
  // changing either would silently reinterpret historical order/purchase/stock
  // rows under a domain they were never recorded against. Price Book rows
  // alone do NOT count as business history (books can still be rebuilt before
  // Go-live), so this deliberately does not query price_books/price_book_items.
  async hasBusinessHistory(productId) {
    const tables = ['order_items', 'purchase_order_items', 'inventory_receive_items', 'stock_transactions'];
    for (const table of tables) {
      const [[row]] = await pool.query(`SELECT 1 FROM ${table} WHERE product_id=? LIMIT 1`, [productId]);
      if (row) return true;
    }
    return false;
  }

  async assertDomainImmutable(id, salesFlow, inventoryMode) {
    const [[current]] = await pool.query(`SELECT sales_flow,inventory_mode FROM products WHERE id=? AND del_flg=0`, [id]);
    if (!current) return;
    const currentSalesFlow = String(current.sales_flow || '').toUpperCase();
    const currentInventoryMode = normalizeInventoryMode(current.inventory_mode);
    const isChanging = currentSalesFlow !== salesFlow || currentInventoryMode !== inventoryMode;
    if (!isChanging) return;
    if (await this.hasBusinessHistory(id)) {
      throw Object.assign(
        new Error('Sản phẩm đã phát sinh giao dịch.\nKhông được thay đổi Luồng bán hoặc Chế độ tồn.\nVui lòng tạo sản phẩm mới.'),
        { status: 400, statusCode: 400, code: 'PRODUCT_DOMAIN_LOCKED' }
      );
    }
  }

  async updateProduct(id,data) {
    if(!data.name) throw new Error('Thiếu tên hàng');
    await this.assertUniqueProductName(data.name,id);
    const { salesFlow, inventoryMode } = this.assertProductClassification(data);
    await this.assertDomainImmutable(id, salesFlow, inventoryMode);
    await pool.query(
      `UPDATE products SET category_id=?,name=?,unit=?,default_sale_price=?,default_purchase_price=?,low_stock_threshold=?,note=?,is_active=?,inventory_mode=?,parent_product_id=?,carcass_group=?,allow_negative_stock=?,sales_flow=? WHERE id=? AND del_flg=0`,
      [data.category_id||null,data.name,data.unit||'kg',data.default_sale_price||0,data.default_purchase_price||0,data.low_stock_threshold||5,data.note||'',data.is_active?1:0,inventoryMode,data.parent_product_id||null,data.carcass_group||null,data.allow_negative_stock?1:0,salesFlow,id]
    );
    return {message:'Đã sửa mặt hàng'};
  }

  async updatePrice(id, data) {
    await pool.query(`UPDATE products SET default_sale_price=?,default_purchase_price=? WHERE id=? AND del_flg=0`, [data.default_sale_price||0,data.default_purchase_price||0,id]);
    return {message:'Đã sửa giá mặt hàng'};
  }

  async removeProduct(id, reason, userId) {
    return SoftDeleteAgent.softDelete('product', id, reason, userId);
  }

  async customerProducts(customerId) {
    const [customers] = await pool.query(`SELECT * FROM customers WHERE id=? AND del_flg=0`, [customerId]);
    if (!customers.length) throw new Error('Không tìm thấy khách');
    const [rows] = await pool.query(
      `SELECT p.id product_id,p.product_code,p.name product_name,p.unit,p.stock_quantity,p.default_sale_price,p.default_purchase_price,p.inventory_mode,p.allow_negative_stock,p.category_id,
       COALESCE(cpp.sale_price,p.default_sale_price) sale_price,
       CASE WHEN cpp.sale_price IS NOT NULL THEN 'PRIVATE_PRICE' ELSE 'COMMON_PRICE' END price_type,
       pc.name category_name
       FROM products p
       LEFT JOIN product_categories pc ON pc.id=p.category_id
       LEFT JOIN customer_product_prices cpp ON cpp.product_id=p.id AND cpp.customer_id=? AND cpp.is_active=1
       WHERE p.del_flg=0 AND p.is_active=1
       ORDER BY CASE WHEN cpp.sale_price IS NOT NULL THEN 0 ELSE 1 END,pc.sort_order,p.name`,
      [customerId]
    );
    for (const r of rows) {
      const price = await PriceBookService.getEffectivePrice(customerId, r.product_id, new Date().toISOString().slice(0,10));
      if (price) { r.sale_price = price.sale_price; r.price_type = price.price_type; r.price_book_id = price.price_book_id || null; }
    }
    return {customer:customers[0], products:rows};
  }

  async updateCustomerPrice(customerId, productId, salePrice, effectiveFrom=null, userId=null) {
    // V65.44: do not overwrite historical private price rows. Create a new price-book version.
    // S4.2: a book is scoped to one product category — derive it from productId and only
    // carry forward this customer's OTHER products in that same category, never all categories.
    const [[product]] = await pool.query(`SELECT category_id FROM products WHERE id=? AND del_flg=0`, [productId]);
    if (!product) throw Object.assign(new Error('Không tìm thấy sản phẩm'), { status: 404 });
    const categoryId = product.category_id;
    const current = await this.customerProducts(customerId);
    const items = (current.products || [])
      .filter(p => Number(p.category_id) === Number(categoryId) || Number(p.product_id) === Number(productId))
      .map(p => ({
        product_id: p.product_id,
        sale_price: Number(p.product_id)==Number(productId) ? Number(salePrice||0) : Number(p.sale_price||0)
      }));
    return PriceBookService.createOrReplaceBook(customerId, items, effectiveFrom || new Date().toISOString().slice(0,10), userId, 'Update single customer product price', categoryId);
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

  async quickProduct(data) {
    if(!data.name) throw new Error('Thiếu tên hàng');
    await this.assertUniqueProductName(data.name);
    const code = data.product_code || await this.nextProductCode(data.category_id);
    // S1G: quick-add is only ever invoked from the Bò Xô POS screen (CreateOrder.jsx),
    // so its sales_flow default is CARCASS_POS — an explicit caller-supplied
    // sales_flow still wins, and the combination is still validated (a caller
    // that mistakenly asks for TRACK_STOCK here still gets rejected with 400).
    const salesFlow = String(data.sales_flow || 'CARCASS_POS').toUpperCase();
    const inventoryMode = normalizeInventoryMode(data.inventory_mode || 'CARCASS_PART');
    assertSalesFlowInventoryModeCombo(salesFlow, inventoryMode);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [r] = await conn.query(
        `INSERT INTO products(category_id,product_code,name,unit,default_sale_price,default_purchase_price,low_stock_threshold,inventory_mode,allow_negative_stock,del_flg,sales_flow)
         VALUES(?,?,?,?,?,?,?,?,?,0,?)`,
        [data.category_id||null,code,data.name,data.unit||'kg',data.sale_price||0,0,5,inventoryMode,data.allow_negative_stock?1:0,salesFlow]
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
