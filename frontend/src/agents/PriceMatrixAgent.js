function normalizeRowsV636(rows){
  return (rows||[]).map((r,idx)=>({
    product_id:Number(r.product_id||r.id),
    sort_order:Number(r.sort_order||idx+1),
    private_price:Number(String(r.private_price||r.price||0).replace(/[,\s]/g,''))||0,
    is_default:r.is_default?1:0,
    is_active:r.is_active===0?0:1
  })).filter(x=>x.product_id);
}

const pool = require('../config/db');

async function ensureCustomerAccessV626(customerId,user){
  if(user&&user.role==='CUSTOMER'){
    const [rows]=await pool.query(`SELECT id FROM customers WHERE id=? AND (id=? OR parent_customer_id=?) AND del_flg=0`,[customerId,user.customer_id,user.customer_id]);
    if(!rows.length) throw new Error('Không có quyền xem khách hàng này');
  }
}

function customerScopeSqlV626(user,alias='c'){
  if(user&&user.role==='CUSTOMER'){
    return {sql:` AND (${alias}.id=${Number(user.customer_id||0)} OR ${alias}.parent_customer_id=${Number(user.customer_id||0)})`};
  }
  return {sql:''};
}

class PriceMatrixAgent {
  constructor(){this.version='6.9.0';this.responsibility='Private price matrix, customer catalog package, Excel-like price editing';}

  async matrix(customerId) {
    const [customers] = await pool.query(`SELECT * FROM customers WHERE id=? AND del_flg=0`, [customerId]);
    if(!customers.length) throw new Error('Không tìm thấy khách hàng');

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
       WHERE p.del_flg=0 AND p.is_active=1
       ORDER BY COALESCE(cpc.is_default,0) DESC, COALESCE(cpc.sort_order,p.id), pc.sort_order, p.name`,
      [customerId, customerId]
    );
    return {customer:customers[0], rows};
  }

  async saveMatrix(customerId, items, userId, effectiveFrom = null) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      for(const it of items || []) {
        const productId = it.product_id;
        const inCatalog = it.in_catalog ? 1 : 0;
        const sortOrder = Number(it.sort_order || 0);
        const price = it.private_price === '' || it.private_price === null || it.private_price === undefined
          ? null
          : Number(it.private_price || 0);

        if(inCatalog) {
          await conn.query(
            `INSERT INTO customer_product_catalogs(customer_id,product_id,sort_order,is_default,is_active,del_flg)
             VALUES(?,?,?,?,1,0)
             ON DUPLICATE KEY UPDATE sort_order=VALUES(sort_order), is_default=1, is_active=1, del_flg=0`,
            [customerId, productId, sortOrder, 1]
          );
        } else {
          await conn.query(
            `UPDATE customer_product_catalogs SET is_default=0,is_active=0,del_flg=1 WHERE customer_id=? AND product_id=?`,
            [customerId, productId]
          );
        }

        if(price !== null && !Number.isNaN(price)) {
          const [oldRows] = await conn.query(
            `SELECT sale_price FROM customer_product_prices WHERE customer_id=? AND product_id=? AND is_active=1 LIMIT 1`,
            [customerId, productId]
          );
          const oldPrice = oldRows.length ? oldRows[0].sale_price : null;

          await conn.query(
            `UPDATE customer_product_prices SET is_active=0 WHERE customer_id=? AND product_id=? AND is_active=1`,
            [customerId, productId]
          );
          await conn.query(
            `INSERT INTO customer_product_prices(customer_id,product_id,sale_price,effective_from,is_active)
             VALUES(?,?,?,CURDATE(),1)`,
            [customerId, productId, price]
          );
          await conn.query(
            `INSERT INTO price_change_logs(customer_id,product_id,old_price,new_price,reason,changed_by)
             VALUES(?,?,?,?,?,?)`,
            [customerId, productId, oldPrice, price, 'V6.9 price matrix update', userId || null]
          );
        }
      }

      await conn.commit();
      return {message:'Đã lưu bảng giá riêng và gói danh mục khách hàng'};
    } catch(e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  async customerCatalogForOrder(customerId) {
    const [customers] = await pool.query(`SELECT * FROM customers WHERE id=? AND del_flg=0`, [customerId]);
    if(!customers.length) throw new Error('Không tìm thấy khách hàng');

    const [catalogRows] = await pool.query(
      `SELECT p.id product_id, p.product_code, p.name product_name, p.unit, p.stock_quantity,
              p.inventory_mode, p.allow_negative_stock, pc.name category_name,
              COALESCE(cpp.sale_price,p.default_sale_price) sale_price,
              CASE WHEN cpp.sale_price IS NULL THEN 'COMMON_PRICE' ELSE 'PRIVATE_PRICE' END price_type,
              cpc.sort_order
       FROM customer_product_catalogs cpc
       JOIN products p ON p.id=cpc.product_id AND p.del_flg=0 AND p.is_active=1
       LEFT JOIN product_categories pc ON pc.id=p.category_id
       LEFT JOIN customer_product_prices cpp ON cpp.product_id=p.id AND cpp.customer_id=cpc.customer_id AND cpp.is_active=1
       WHERE cpc.customer_id=? AND cpc.del_flg=0 AND cpc.is_active=1 AND cpc.is_default=1
       ORDER BY cpc.sort_order, pc.sort_order, p.name`,
      [customerId]
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
       WHERE p.del_flg=0 AND p.is_active=1
       ORDER BY pc.sort_order, p.name`,
      [customerId]
    );
    return {customer:customers[0], products:fallback, source:'ALL_PRODUCTS_FALLBACK'};
  }

  async reorderCatalog(customerId, items) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for(const it of items || []) {
        await conn.query(
          `UPDATE customer_product_catalogs SET sort_order=? WHERE customer_id=? AND product_id=? AND del_flg=0`,
          [Number(it.sort_order||0), customerId, it.product_id]
        );
      }
      await conn.commit();
      return {message:'Đã cập nhật thứ tự danh mục khách'};
    } catch(e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  async copyCatalog(fromCustomerId, toCustomerId, userId, effectiveFrom = null) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [items] = await conn.query(
        `SELECT product_id, sort_order, is_default FROM customer_product_catalogs
         WHERE customer_id=? AND del_flg=0 AND is_active=1`,
        [fromCustomerId]
      );
      for(const it of items) {
        await conn.query(
          `INSERT INTO customer_product_catalogs(customer_id,product_id,sort_order,is_default,is_active,del_flg)
           VALUES(?,?,?,?,1,0)
           ON DUPLICATE KEY UPDATE sort_order=VALUES(sort_order), is_default=VALUES(is_default), is_active=1, del_flg=0`,
          [toCustomerId, it.product_id, it.sort_order, it.is_default]
        );
      }

      const from = normalizeEffectiveFrom(effectiveFrom);
      const [prices] = await conn.query(
        `SELECT bi.product_id, bi.sale_price
         FROM customer_price_books b
         JOIN customer_price_book_items bi ON bi.price_book_id=b.id
         WHERE b.customer_id=? AND b.status='ACTIVE'
           AND b.effective_from<=? AND (b.effective_to IS NULL OR b.effective_to>=?)
         ORDER BY b.effective_from DESC,b.id DESC`,
        [fromCustomerId, from, from]
      );
      const priceMap = new Map();
      prices.forEach(p => { if(!priceMap.has(String(p.product_id))) priceMap.set(String(p.product_id), p); });

      if(priceMap.size) {
        await conn.query(
          `UPDATE customer_price_books SET effective_to=DATE_SUB(?, INTERVAL 1 DAY), status='CLOSED'
           WHERE customer_id=? AND status='ACTIVE' AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?)`,
          [from, toCustomerId, from, from]
        );
        const [book] = await conn.query(
          `INSERT INTO customer_price_books(customer_id,book_name,effective_from,status,note,created_by) VALUES(?,?,?,?,?,?)`,
          [toCustomerId, `Bảng giá copy từ khách ${fromCustomerId} - ${from}`, from, 'ACTIVE', `Copy price book from customer ${fromCustomerId}`, userId || null]
        );
        for(const p of priceMap.values()) {
          await conn.query(
            `INSERT INTO customer_price_book_items(price_book_id,customer_id,product_id,sale_price,note) VALUES(?,?,?,?,?)`,
            [book.insertId, toCustomerId, p.product_id, Number(p.sale_price||0), `Copy from customer ${fromCustomerId}`]
          );
          await conn.query(`INSERT INTO price_change_logs(customer_id,product_id,old_price,new_price,reason,changed_by) VALUES(?,?,?,?,?,?)`, [toCustomerId, p.product_id, null, p.sale_price, `Copy price book from customer ${fromCustomerId} effective ${from}`, userId || null]);
        }
      }

      await conn.commit();
      return {message:'Đã copy gói danh mục và bảng giá sang khách mới', effective_from:from, copied_prices:priceMap.size};
    } catch(e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }
}

module.exports = new PriceMatrixAgent();
