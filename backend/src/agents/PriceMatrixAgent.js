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
const PriceBookService = require('../services/PriceBookService');

function normalizeEffectiveFrom(value){
  const s=String(value||new Date().toISOString().slice(0,10)).slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('Ngày hiệu lực dương lịch không hợp lệ. Định dạng đúng: YYYY-MM-DD');
  return s;
}
function normalizeCalendarType(v){return String(v||'SOLAR').toUpperCase()==='LUNAR'?'LUNAR':'SOLAR'}
async function customerCalendarType(conn,customerId){
  const [rows]=await conn.query(`SELECT billing_calendar_type FROM customers WHERE id=? LIMIT 1`,[customerId]);
  return normalizeCalendarType(rows[0]?.billing_calendar_type||'SOLAR');
}
async function resolvePriceBookMeta(conn,customerId,data={}){
  const defaultCt=await customerCalendarType(conn,customerId);
  return PriceBookService.resolveEffectiveMeta(data, defaultCt);
}

async function upsertBook(conn, customerId, meta, { bookName, note, status='ACTIVE' }, userId, priceItems) {
  const [existing] = await conn.query(
    `SELECT id FROM customer_price_books
     WHERE customer_id=? AND effective_from=? AND effective_calendar_type=?
       AND COALESCE(status,'ACTIVE')<>'DELETED'
     LIMIT 1`,
    [customerId, meta.effective_from, meta.effective_calendar_type]
  );
  let bookId;
  if (existing.length) {
    bookId = existing[0].id;
    await conn.query(
      `UPDATE customer_price_books SET book_name=COALESCE(?,book_name), status=?, note=?, updated_at=NOW() WHERE id=?`,
      [bookName || null, status, note || null, bookId]
    );
    await conn.query(`DELETE FROM customer_price_book_items WHERE price_book_id=?`, [bookId]);
  } else {
    const [r] = await conn.query(
      `INSERT INTO customer_price_books(customer_id,book_name,effective_from,effective_calendar_type,effective_lunar_date_text,effective_lunar_sort,status,note,created_by) VALUES(?,?,?,?,?,?,?,?,?)`,
      [customerId, bookName, meta.effective_from, meta.effective_calendar_type, meta.effective_lunar_date_text, meta.effective_lunar_sort, status, note || null, userId || null]
    );
    bookId = r.insertId;
  }
  for (const p of priceItems || []) {
    if (!p.product_id) continue;
    await conn.query(
      `INSERT INTO customer_price_book_items(price_book_id,customer_id,product_id,sale_price,note) VALUES(?,?,?,?,?)`,
      [bookId, customerId, p.product_id, Number(p.sale_price||0), p.note || null]
    );
  }
  return { price_book_id: bookId, created: !existing.length };
}

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
    for (const r of rows) {
      const price = await PriceBookService.getEffectivePrice(customerId, r.product_id, new Date().toISOString().slice(0,10), pool, customers[0].billing_calendar_type, '');
      if (price) { r.private_price = price.price_type==='COMMON_PRICE' ? null : price.sale_price; r.effective_price = price.sale_price; r.price_type = price.price_type; r.price_book_id = price.price_book_id || null; }
    }
    return {customer:customers[0], rows};
  }

  async saveMatrix(customerId, items, userId, effectiveMetaPayload = {}) {
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

          // V65.44: keep legacy table untouched for fallback; active production price is stored in customer_price_books.
          // A full book is created after catalog updates, so every product has a deterministic version.
          await conn.query(
            `INSERT INTO price_change_logs(customer_id,product_id,old_price,new_price,reason,changed_by)
             VALUES(?,?,?,?,?,?)`,
            [customerId, productId, oldPrice, price, 'V6.9 price matrix update', userId || null]
          );
        }
      }

      const priceItems = (items || [])
        .filter(it => it.private_price !== '' && it.private_price !== null && it.private_price !== undefined && !Number.isNaN(Number(it.private_price||0)))
        .map(it => ({ product_id:it.product_id, sale_price:Number(it.private_price||0) }));
      if (priceItems.length) {
        const meta = await resolvePriceBookMeta(conn, customerId, effectiveMetaPayload);
        await upsertBook(conn, customerId, meta,
          { bookName:`Bảng giá từ ${meta.display_date}`, note:`V65.50 price matrix ${meta.effective_calendar_type} effective ${meta.display_date}`, status:'ACTIVE' },
          userId, priceItems);
      }
      await conn.commit();
      return {message:'Đã lưu bảng giá riêng'};
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

    if(catalogRows.length) {
      for (const r of catalogRows) {
        const price = await PriceBookService.getEffectivePrice(customerId, r.product_id, new Date().toISOString().slice(0,10), pool, customers[0].billing_calendar_type, '');
        if(price){ r.sale_price=price.sale_price; r.price_type=price.price_type; r.price_book_id=price.price_book_id || null; }
      }
      const hasPrivate = catalogRows.some(r => r.price_type && r.price_type !== 'COMMON_PRICE');
      // hasPrivate → show only private-priced products (normal POS flow)
      // !hasPrivate → show all products; frontend will allow manual price entry
      const products = hasPrivate ? catalogRows.filter(r=>r.price_type&&r.price_type!=='COMMON_PRICE') : catalogRows;
      return {customer:customers[0], products, source:'CUSTOMER_CATALOG', no_private_prices:!hasPrivate};
    }

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
    for (const r of fallback) {
      const price = await PriceBookService.getEffectivePrice(customerId, r.product_id, new Date().toISOString().slice(0,10), pool, customers[0].billing_calendar_type, '');
      if(price){ r.sale_price=price.sale_price; r.price_type=price.price_type; r.price_book_id=price.price_book_id || null; }
    }
    const hasPrivate = fallback.some(r => r.price_type && r.price_type !== 'COMMON_PRICE');
    const products = hasPrivate ? fallback.filter(r=>r.price_type&&r.price_type!=='COMMON_PRICE') : fallback;
    return {customer:customers[0], products, source:'ALL_PRODUCTS_FALLBACK', no_private_prices:!hasPrivate};
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

  async copyCatalog(fromCustomerId, toCustomerId, userId, effectiveMetaPayload = {}) {
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

      const meta = await resolvePriceBookMeta(conn, toCustomerId, effectiveMetaPayload);
      const srcCt = await customerCalendarType(conn, fromCustomerId);
      const [prices] = await conn.query(
        `SELECT bi.product_id, bi.sale_price
         FROM customer_price_books b
         JOIN customer_price_book_items bi ON bi.price_book_id=b.id
         WHERE b.customer_id=? AND COALESCE(b.status,'ACTIVE')='ACTIVE'
           AND COALESCE(b.effective_calendar_type,'SOLAR')=?
         ORDER BY CASE WHEN COALESCE(b.effective_calendar_type,'SOLAR')='LUNAR' THEN COALESCE(b.effective_lunar_sort,0) ELSE 0 END DESC,
                  b.effective_from DESC,b.id DESC`,
        [fromCustomerId, srcCt]
      );
      const priceMap = new Map();
      prices.forEach(p => { if(!priceMap.has(String(p.product_id))) priceMap.set(String(p.product_id), p); });

      if(priceMap.size) {
        const copyItems=[...priceMap.values()].map(p=>({product_id:p.product_id,sale_price:Number(p.sale_price||0),note:`Copy from customer ${fromCustomerId}`}));
        await upsertBook(conn,toCustomerId,meta,
          {bookName:`Bảng giá copy từ khách ${fromCustomerId} - ${meta.display_date}`,note:`Copy price book from customer ${fromCustomerId}`,status:'ACTIVE'},
          userId,copyItems);
        for(const p of priceMap.values()){
          await conn.query(`INSERT INTO price_change_logs(customer_id,product_id,old_price,new_price,reason,changed_by) VALUES(?,?,?,?,?,?)`,[toCustomerId,p.product_id,null,p.sale_price,`Copy price book from customer ${fromCustomerId} effective ${meta.display_date}`,userId||null]);
        }
      }

      await conn.commit();
      return {message:'Đã copy gói danh mục và bảng giá sang khách mới', effective_from:meta.effective_from, effective_calendar_type:meta.effective_calendar_type, effective_lunar_date_text:meta.effective_lunar_date_text, copied_prices:priceMap.size};
    } catch(e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  async listBooks(customerId) {
    const [books] = await pool.query(
      `SELECT b.id,b.customer_id,b.book_name,b.effective_from,b.effective_to,b.effective_calendar_type,b.effective_lunar_date_text,b.effective_lunar_sort,b.status,b.note,b.created_at,b.updated_at,
              COUNT(DISTINCT bi.product_id) item_count,
              COUNT(DISTINCT oi.order_id) bill_count,
              COUNT(DISTINCT CASE WHEN COALESCE(o.paid_amount,0)>0 OR o.payment_status IN ('PAID','PARTIAL') OR pa.id IS NOT NULL THEN oi.order_id END) paid_bill_count,
              COUNT(DISTINCT CASE WHEN oi.order_id IS NOT NULL AND COALESCE(o.paid_amount,0)=0 AND (o.payment_status IS NULL OR o.payment_status NOT IN ('PAID','PARTIAL')) AND pa.id IS NULL THEN oi.order_id END) unpaid_bill_count
       FROM customer_price_books b
       LEFT JOIN customer_price_book_items bi ON bi.price_book_id=b.id
       LEFT JOIN order_items oi ON oi.price_book_id=b.id
       LEFT JOIN orders o ON o.id=oi.order_id AND o.status<>'CANCELLED'
       LEFT JOIN payment_allocations pa ON pa.order_id=o.id
       WHERE b.customer_id=? AND COALESCE(b.status,'ACTIVE')<>'DELETED'
       GROUP BY b.id
       ORDER BY COALESCE(b.effective_lunar_sort,0) DESC,b.effective_from DESC,b.id DESC`,
      [customerId]
    );
    return books.map(x=>({
      ...x,
      can_edit: Number(x.paid_bill_count||0)===0,
      can_delete: Number(x.paid_bill_count||0)===0,
      lock_reason: Number(x.paid_bill_count||0)>0 ? `Đã có ${x.paid_bill_count} bill phát sinh thu tiền` : ''
    }));
  }

  async getBook(bookId) {
    const [books] = await pool.query(
      `SELECT b.*,
              COUNT(DISTINCT oi.order_id) bill_count,
              COUNT(DISTINCT CASE WHEN COALESCE(o.paid_amount,0)>0 OR o.payment_status IN ('PAID','PARTIAL') OR pa.id IS NOT NULL THEN oi.order_id END) paid_bill_count,
              COUNT(DISTINCT CASE WHEN oi.order_id IS NOT NULL AND COALESCE(o.paid_amount,0)=0 AND (o.payment_status IS NULL OR o.payment_status NOT IN ('PAID','PARTIAL')) AND pa.id IS NULL THEN oi.order_id END) unpaid_bill_count
       FROM customer_price_books b
       LEFT JOIN order_items oi ON oi.price_book_id=b.id
       LEFT JOIN orders o ON o.id=oi.order_id AND o.status<>'CANCELLED'
       LEFT JOIN payment_allocations pa ON pa.order_id=o.id
       WHERE b.id=?
       GROUP BY b.id`,
      [bookId]
    );
    if(!books.length) throw new Error('Không tìm thấy bảng giá');
    const [items] = await pool.query(
      `SELECT bi.id,bi.price_book_id,bi.customer_id,bi.product_id,COALESCE(p.name,CONCAT('ID ',bi.product_id)) product_name,
              p.product_code,p.unit,bi.sale_price,bi.note
       FROM customer_price_book_items bi
       LEFT JOIN products p ON p.id=bi.product_id
       WHERE bi.price_book_id=?
       ORDER BY p.name,bi.product_id`,
      [bookId]
    );
    const b = books[0];
    return {...b, items, can_edit:Number(b.paid_bill_count||0)===0, can_delete:Number(b.paid_bill_count||0)===0};
  }

  async recalcUnpaidOrdersForBook(conn, bookId) {
    const [orders] = await conn.query(
      `SELECT DISTINCT o.id
       FROM orders o
       JOIN order_items oi ON oi.order_id=o.id
       LEFT JOIN payment_allocations pa ON pa.order_id=o.id
       WHERE oi.price_book_id=? AND o.status<>'CANCELLED'
         AND COALESCE(o.paid_amount,0)=0
         AND (o.payment_status IS NULL OR o.payment_status NOT IN ('PAID','PARTIAL'))
         AND pa.id IS NULL`,
      [bookId]
    );
    for (const o of orders) {
      await conn.query(
        `UPDATE order_items oi
         JOIN customer_price_book_items bi ON bi.price_book_id=oi.price_book_id AND bi.product_id=oi.product_id
         SET oi.sale_price=bi.sale_price,
             oi.total_price=ROUND(COALESCE(oi.quantity,0)*COALESCE(bi.sale_price,0),2)
         WHERE oi.order_id=? AND oi.price_book_id=?`,
        [o.id, bookId]
      );
      const [sumRows] = await conn.query(`SELECT COALESCE(SUM(total_price),0) total FROM order_items WHERE order_id=?`, [o.id]);
      const itemTotal = Number(sumRows[0]?.total || 0);
      const [orows] = await conn.query(`SELECT installment_amount FROM orders WHERE id=? FOR UPDATE`, [o.id]);
      const installment = Number(orows[0]?.installment_amount || 0);
      const total = itemTotal + installment;
      await conn.query(
        `UPDATE orders SET current_bill_amount=?, total_amount=?, debt_amount=?, payment_status='UNPAID' WHERE id=?`,
        [itemTotal, total, total, o.id]
      );
    }
    return orders.length;
  }

  async updateBook(bookId, data, userId) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [paid] = await conn.query(
        `SELECT COUNT(DISTINCT o.id) cnt
         FROM orders o
         JOIN order_items oi ON oi.order_id=o.id
         LEFT JOIN payment_allocations pa ON pa.order_id=o.id
         WHERE oi.price_book_id=? AND o.status<>'CANCELLED'
           AND (COALESCE(o.paid_amount,0)>0 OR o.payment_status IN ('PAID','PARTIAL') OR pa.id IS NOT NULL)`,
        [bookId]
      );
      if(Number(paid[0]?.cnt||0)>0) throw new Error(`Bảng giá đã có ${paid[0].cnt} bill phát sinh thu tiền, không thể sửa`);
      const [curBookRows]=await conn.query(`SELECT customer_id FROM customer_price_books WHERE id=? LIMIT 1`,[bookId]);
      if(!curBookRows.length) throw new Error('Không tìm thấy bảng giá');
      const meta = await resolvePriceBookMeta(conn, curBookRows[0].customer_id, data);
      const [conflict]=await conn.query(
        `SELECT id FROM customer_price_books
         WHERE customer_id=? AND effective_from=? AND effective_calendar_type=?
           AND COALESCE(status,'ACTIVE')<>'DELETED' AND id<>?
         LIMIT 1`,
        [curBookRows[0].customer_id, meta.effective_from, meta.effective_calendar_type, bookId]
      );
      if(conflict.length) throw Object.assign(
        new Error(`Đã tồn tại bảng giá cho ngày ${meta.display_date} (ID: ${conflict[0].id}). Vui lòng chọn ngày khác hoặc sửa trực tiếp bảng giá đó.`),
        {status:409, statusCode:409}
      );
      const status = data.status || 'ACTIVE';
      await conn.query(
        `UPDATE customer_price_books
         SET book_name=COALESCE(?,book_name), effective_from=?, effective_to=NULL, effective_calendar_type=?, effective_lunar_date_text=?, effective_lunar_sort=?, status=?, note=?, updated_at=NOW()
         WHERE id=?`,
        [data.book_name || null, meta.effective_from, meta.effective_calendar_type, meta.effective_lunar_date_text, meta.effective_lunar_sort, status, data.note || null, bookId]
      );
      if(Array.isArray(data.items)) {
        for(const it of data.items) {
          if(!it.product_id) continue;
          await conn.query(
            `INSERT INTO customer_price_book_items(price_book_id,customer_id,product_id,sale_price,note)
             SELECT ?,customer_id,?,?,? FROM customer_price_books WHERE id=?
             ON DUPLICATE KEY UPDATE sale_price=VALUES(sale_price), note=VALUES(note)`,
            [bookId, it.product_id, Number(it.sale_price||0), it.note || null, bookId]
          );
        }
      }
      const recalculated_orders = await this.recalcUnpaidOrdersForBook(conn, bookId);
      await conn.commit();
      return {message:'Đã cập nhật bảng giá', price_book_id:Number(bookId), recalculated_orders};
    } catch(e) { await conn.rollback(); throw e; }
    finally { conn.release(); }
  }

  async deleteBook(bookId, userId) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [paid] = await conn.query(
        `SELECT COUNT(DISTINCT o.id) cnt
         FROM orders o
         JOIN order_items oi ON oi.order_id=o.id
         LEFT JOIN payment_allocations pa ON pa.order_id=o.id
         WHERE oi.price_book_id=? AND o.status<>'CANCELLED'
           AND (COALESCE(o.paid_amount,0)>0 OR o.payment_status IN ('PAID','PARTIAL') OR pa.id IS NOT NULL)`,
        [bookId]
      );
      if(Number(paid[0]?.cnt||0)>0) throw new Error(`Bảng giá đã có ${paid[0].cnt} bill phát sinh thu tiền, không thể xóa`);
      // Nếu có bill chưa thu tiền, giữ nguyên giá trên bill nhưng bỏ liên kết price_book_id để tránh trỏ vào bảng giá đã xóa.
      await conn.query(`UPDATE order_items oi JOIN orders o ON o.id=oi.order_id SET oi.price_type='MANUAL_PRICE', oi.price_book_id=NULL WHERE oi.price_book_id=?`, [bookId]);
      await conn.query(`UPDATE customer_price_books SET status='DELETED', note=CONCAT(COALESCE(note,''),' | deleted V65.50'), updated_at=NOW() WHERE id=?`, [bookId]);
      await conn.commit();
      return {message:'Đã xóa mềm bảng giá', price_book_id:Number(bookId)};
    } catch(e) { await conn.rollback(); throw e; }
    finally { conn.release(); }
  }

  async saveAllSafe(customerId, body, user) {
    const { assertCustomerScope } = require('../middleware/scope');
    await assertCustomerScope(user, customerId);
    return this.saveMatrix(
      customerId,
      body.items,
      user?.id || null,
      {
        effective_from: body.effective_from,
        effective_calendar_type: body.effective_calendar_type,
        effective_lunar_date_text: body.effective_lunar_date_text
      }
    );
  }

  async copyBook(bookId, data, userId) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [books]=await conn.query(`SELECT * FROM customer_price_books WHERE id=? LIMIT 1`,[bookId]);
      if(!books.length) throw new Error('Không tìm thấy bảng giá cần copy');
      const src=books[0];
      const toCustomerId=Number(data.customer_id || data.to_customer_id || src.customer_id);
      const meta=await resolvePriceBookMeta(conn, toCustomerId, data);
      const [srcItems]=await conn.query(`SELECT product_id,sale_price FROM customer_price_book_items WHERE price_book_id=?`,[bookId]);
      const copyItems=srcItems.map(p=>({product_id:p.product_id,sale_price:Number(p.sale_price||0),note:`Copy from price_book_id ${bookId}`}));
      const {price_book_id:newBookId}=await upsertBook(conn,toCustomerId,meta,
        {bookName:data.book_name||`Copy từ bảng giá #${bookId} - ${meta.display_date}`,note:data.note||`Copy from price_book_id ${bookId}`,status:'ACTIVE'},
        userId,copyItems);
      await conn.commit();
      return {message:'Đã copy bảng giá', price_book_id:newBookId, effective_from:meta.effective_from, effective_calendar_type:meta.effective_calendar_type, effective_lunar_date_text:meta.effective_lunar_date_text};
    } catch(e) { await conn.rollback(); throw e; }
    finally { conn.release(); }
  }

}

module.exports = new PriceMatrixAgent();
