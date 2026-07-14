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

// CTO rule: Customer.billing_calendar_type is the source of truth — a price book's
// calendar_type must always match its own customer's. resolvePriceBookMeta() already
// defaults to the customer's calendar type when the caller doesn't specify one, but never
// rejects an explicit mismatch (e.g. from the book-edit calendar-type selector); this is
// the server-side backstop for that.
async function assertCalendarMatchesCustomer(conn, customerId, calendarType) {
  const custCt = await customerCalendarType(conn, customerId);
  const bookCt = normalizeCalendarType(calendarType);
  if (bookCt !== custCt) {
    throw Object.assign(
      new Error(`Loại lịch của bảng giá (${bookCt==='LUNAR'?'Âm lịch':'Dương lịch'}) không khớp với lịch tính bill của khách hàng (${custCt==='LUNAR'?'Âm lịch':'Dương lịch'}).`),
      { status: 400, code: 'CALENDAR_TYPE_MISMATCH' }
    );
  }
}

// S4.2: category is the pricing scope. A book may only contain products whose
// products.category_id matches the book's category — never trust the frontend
// for this, always re-check server-side against the database.
async function assertItemsMatchCategory(conn, categoryId, items) {
  const productIds = [...new Set((items || []).map(p => Number(p.product_id)).filter(Boolean))];
  if (!productIds.length) return;
  const [rows] = await conn.query(
    `SELECT id, name, category_id FROM products WHERE id IN (?)`,
    [productIds]
  );
  const mismatched = rows.filter(r => Number(r.category_id) !== Number(categoryId));
  if (mismatched.length) {
    const names = mismatched.map(r => r.name).join(', ');
    throw Object.assign(
      new Error(`Sản phẩm không thuộc danh mục của bảng giá này: ${names}`),
      { status: 400 }
    );
  }
}

async function upsertBook(conn, customerId, categoryId, meta, { bookName, note, status='ACTIVE' }, userId, priceItems) {
  if (!categoryId) throw Object.assign(new Error('Thiếu danh mục hàng hóa cho bảng giá'), { status: 400 });
  await assertCalendarMatchesCustomer(conn, customerId, meta.effective_calendar_type);

  // S4.3: a price book can only be created under an existing CustomerPriceCategory —
  // never auto-created here. Caller (POS guided init / Price Matrix "+ add category") is
  // responsible for creating it first via an explicit user action.
  const customerPriceCategoryId = await PriceBookService.resolveCustomerPriceCategoryId(customerId, categoryId, conn);
  if (!customerPriceCategoryId) {
    throw Object.assign(
      new Error('Khách hàng chưa có Danh mục giá cho danh mục hàng hóa này. Vui lòng tạo trước khi lưu bảng giá.'),
      { status: 400, code: 'CUSTOMER_PRICE_CATEGORY_NOT_FOUND' }
    );
  }
  // Lock the CustomerPriceCategory row for the rest of this transaction so a concurrent
  // deleteCustomerPriceCategory() (which takes the same lock before its "any books left?"
  // check) can't delete the category out from under a book being created right now.
  await conn.query(`SELECT id FROM customer_price_categories WHERE id=? FOR UPDATE`, [customerPriceCategoryId]);

  await assertItemsMatchCategory(conn, categoryId, priceItems);

  const [existing] = await conn.query(
    `SELECT id FROM customer_price_books
     WHERE customer_price_category_id=? AND effective_from=? AND effective_calendar_type=?
       AND COALESCE(status,'ACTIVE')<>'DELETED'
     LIMIT 1`,
    [customerPriceCategoryId, meta.effective_from, meta.effective_calendar_type]
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
      `INSERT INTO customer_price_books(customer_id,category_id,customer_price_category_id,book_name,effective_from,effective_calendar_type,effective_lunar_date_text,effective_lunar_sort,status,note,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [customerId, categoryId, customerPriceCategoryId, bookName, meta.effective_from, meta.effective_calendar_type, meta.effective_lunar_date_text, meta.effective_lunar_sort, status, note || null, userId || null]
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

  // ── S4.3: Customer Price Category (Customer + Product Category, the pricing-scope entity
  //         a price book version belongs to) ──────────────────────────────────────────────

  async listCustomerPriceCategories(customerId) {
    const [rows] = await pool.query(
      `SELECT cpc.id, cpc.customer_id, cpc.category_id, pc.name category_name,
              cpc.is_default, cpc.display_order, cpc.note, cpc.created_at, cpc.updated_at
       FROM customer_price_categories cpc
       LEFT JOIN product_categories pc ON pc.id=cpc.category_id
       WHERE cpc.customer_id=?
       ORDER BY cpc.display_order, cpc.id`,
      [customerId]
    );
    return rows;
  }

  // POS Case 0/1/2/3 resolution:
  //   0 categories               -> needs_initialization (guided init, POS must prompt+confirm)
  //   1 category                 -> auto-select it
  //   2+ categories, one default -> auto-select the default
  //   2+ categories, no default  -> requires_selection (Case 3)
  async resolveCustomerCategorySelection(customerId) {
    const categories = await this.listCustomerPriceCategories(customerId);
    if (!categories.length) {
      return { categories, auto_selected_category_id: null, requires_selection: false, needs_initialization: true };
    }
    if (categories.length === 1) {
      return { categories, auto_selected_category_id: categories[0].category_id, requires_selection: false, needs_initialization: false };
    }
    const defaultRow = categories.find(c => Number(c.is_default) === 1);
    if (defaultRow) {
      return { categories, auto_selected_category_id: defaultRow.category_id, requires_selection: false, needs_initialization: false };
    }
    return { categories, auto_selected_category_id: null, requires_selection: true, needs_initialization: false };
  }

  // The single source of truth for creating a CustomerPriceCategory — reused identically by
  // POS's guided-init/add-category confirm flow and by Price Matrix's "+ add category".
  // Never called implicitly from a price-lookup or price-book save path; always an explicit
  // user-confirmed action. is_default/display_order are decided here, not by the caller:
  // the customer's first-ever category becomes the default (display_order=1); any later one
  // is never default and goes to the end of the list.
  async createCustomerPriceCategory(customerId, categoryId, { note } = {}) {
    if (!categoryId) throw Object.assign(new Error('Thiếu danh mục hàng hóa'), { status: 400 });
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[cat]] = await conn.query(`SELECT id FROM product_categories WHERE id=? LIMIT 1`, [categoryId]);
      if (!cat) throw Object.assign(new Error('Không tìm thấy danh mục hàng hóa'), { status: 404 });

      // Lock the customer row (always exists, unlike the category set which may be empty)
      // so two concurrent "first category" creates for the same customer can't both see
      // COUNT=0 and both become is_default=1 — this fully serializes category creation
      // per customer, closing the race a "FOR UPDATE" on zero existing rows would miss.
      await conn.query(`SELECT id FROM customers WHERE id=? FOR UPDATE`, [customerId]);

      const [existing] = await conn.query(
        `SELECT id FROM customer_price_categories WHERE customer_id=? AND category_id=? LIMIT 1`,
        [customerId, categoryId]
      );
      if (existing.length) {
        await conn.commit();
        return { id: existing[0].id, already_exists: true, message: 'Danh mục giá đã tồn tại cho khách hàng này' };
      }

      const [[countRow]] = await conn.query(
        `SELECT COUNT(*) cnt FROM customer_price_categories WHERE customer_id=?`,
        [customerId]
      );
      const isFirst = Number(countRow.cnt) === 0;
      let displayOrder = 1;
      if (!isFirst) {
        const [[maxRow]] = await conn.query(`SELECT COALESCE(MAX(display_order),0) mx FROM customer_price_categories WHERE customer_id=?`, [customerId]);
        displayOrder = Number(maxRow.mx) + 1;
      }
      const [r] = await conn.query(
        `INSERT INTO customer_price_categories(customer_id, category_id, is_default, display_order, note) VALUES(?,?,?,?,?)`,
        [customerId, categoryId, isFirst ? 1 : 0, displayOrder, note || null]
      );
      await conn.commit();
      return {
        id: r.insertId, customer_id: Number(customerId), category_id: Number(categoryId),
        is_default: isFirst, display_order: displayOrder, message: 'Đã tạo danh mục giá cho khách hàng'
      };
    } catch (e) { await conn.rollback(); throw e; }
    finally { conn.release(); }
  }

  async setDefaultCustomerPriceCategory(id) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[row]] = await conn.query(`SELECT customer_id FROM customer_price_categories WHERE id=? LIMIT 1 FOR UPDATE`, [id]);
      if (!row) throw Object.assign(new Error('Không tìm thấy danh mục giá'), { status: 404 });
      await conn.query(`UPDATE customer_price_categories SET is_default=0 WHERE customer_id=?`, [row.customer_id]);
      await conn.query(`UPDATE customer_price_categories SET is_default=1 WHERE id=?`, [id]);
      await conn.commit();
      return { message: 'Đã đặt làm danh mục giá mặc định', id: Number(id) };
    } catch (e) { await conn.rollback(); throw e; }
    finally { conn.release(); }
  }

  async reorderCustomerPriceCategories(customerId, items) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const list = (items || []).filter(it => it && it.id);
      // display_order is unique per customer (uq_cpc_customer_display_order), so writing
      // final values directly can transiently collide with another row's current value
      // mid-loop (e.g. swapping order 1<->2). Two-phase update: park every row being
      // touched at a negative, guaranteed-unused value first, then set final values.
      for (const it of list) {
        await conn.query(
          `UPDATE customer_price_categories SET display_order=-id WHERE id=? AND customer_id=?`,
          [it.id, customerId]
        );
      }
      for (const it of list) {
        await conn.query(
          `UPDATE customer_price_categories SET display_order=? WHERE id=? AND customer_id=?`,
          [Number(it.display_order || 0), it.id, customerId]
        );
      }
      await conn.commit();
      return { message: 'Đã cập nhật thứ tự danh mục giá' };
    } catch (e) { await conn.rollback(); throw e; }
    finally { conn.release(); }
  }

  async deleteCustomerPriceCategory(id) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      // Same row lock upsertBook() takes before creating a book under this category —
      // serializes this "delete if no books" check against a concurrent book creation.
      const [[row]] = await conn.query(`SELECT customer_id, category_id FROM customer_price_categories WHERE id=? LIMIT 1 FOR UPDATE`, [id]);
      if (!row) throw Object.assign(new Error('Không tìm thấy danh mục giá'), { status: 404 });
      const [[bookCount]] = await conn.query(
        `SELECT COUNT(*) cnt FROM customer_price_books WHERE customer_price_category_id=? AND COALESCE(status,'ACTIVE')<>'DELETED'`,
        [id]
      );
      if (Number(bookCount.cnt) > 0) {
        throw Object.assign(new Error(`Không thể xóa: danh mục giá này đang có ${bookCount.cnt} bảng giá.`), { status: 409, statusCode: 409 });
      }
      await conn.query(`DELETE FROM customer_price_categories WHERE id=?`, [id]);
      await conn.commit();
      return { message: 'Đã xóa danh mục giá' };
    } catch (e) { await conn.rollback(); throw e; }
    finally { conn.release(); }
  }

  async matrix(customerId, categoryId) {
    if (!categoryId) throw Object.assign(new Error('Thiếu danh mục hàng hóa'), { status: 400 });
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
       WHERE p.del_flg=0 AND p.is_active=1 AND p.category_id=?
       ORDER BY COALESCE(cpc.is_default,0) DESC, COALESCE(cpc.sort_order,p.id), pc.sort_order, p.name`,
      [customerId, customerId, categoryId]
    );
    // Perf fix: previously called PriceBookService.getEffectivePrice() once per row here —
    // measured at 255 queries / ~3.2s for a 53-product category (up to 5 queries per product:
    // product-category lookup, CustomerPriceCategory resolve, price-book lookup, legacy
    // fallback, default fallback). Bulk-resolved below in a fixed ~4 queries total regardless
    // of product count. Rows with no PRICE_BOOK/PRIVATE_PRICE hit keep the COMMON_PRICE values
    // the base query above already computed (default_sale_price) — identical fallback
    // behavior to what getEffectivePrice() would have returned per-row.
    const todayIso = new Date().toISOString().slice(0,10);
    const priceMap = await PriceBookService.getEffectivePricesForCategory(customerId, categoryId, todayIso, customers[0].billing_calendar_type, '', pool);
    for (const r of rows) {
      const hit = priceMap.get(Number(r.product_id));
      if (hit) { r.private_price = hit.sale_price; r.effective_price = hit.sale_price; r.price_type = hit.price_type; r.price_book_id = hit.price_book_id || null; }
    }
    return {customer:customers[0], category_id:Number(categoryId), rows};
  }

  async saveMatrix(customerId, items, userId, effectiveMetaPayload = {}, categoryId = null) {
    if (!categoryId) throw Object.assign(new Error('Thiếu danh mục hàng hóa'), { status: 400 });
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await assertItemsMatchCategory(conn, categoryId, items);

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
        await upsertBook(conn, customerId, categoryId, meta,
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

  async customerCatalogForOrder(customerId, categoryId) {
    // S4.2: 1 POS bill = 1 customer + 1 category. The catalog and its prices must
    // never span multiple categories, or a bill could mix Bò and Gà products.
    if (!categoryId) throw Object.assign(new Error('Thiếu danh mục hàng hóa'), { status: 400 });
    const [customers] = await pool.query(`SELECT * FROM customers WHERE id=? AND del_flg=0`, [customerId]);
    if(!customers.length) throw new Error('Không tìm thấy khách hàng');

    // Perf fix: previously called PriceBookService.getEffectivePrice() once per row here (both
    // branches) — measured at up to 190 queries / ~1.8s for a 47-product catalog. Bulk-resolved
    // below in a fixed ~4 queries regardless of product count, reusing the same bulk resolver
    // built for Price Matrix (identical semantics: per-product latest price across book
    // versions, SOLAR/LUNAR, legacy fallback).
    const todayIso = new Date().toISOString().slice(0,10);
    const priceMap = await PriceBookService.getEffectivePricesForCategory(customerId, categoryId, todayIso, customers[0].billing_calendar_type, '', pool);

    // applyPriceMap mirrors getEffectivePrice()'s fallback chain exactly: PRICE_BOOK/legacy
    // PRIVATE_PRICE hits from the bulk map win; everything else becomes COMMON_PRICE from
    // products.default_sale_price. This does NOT just "leave the base query's own value" for
    // misses — the base query's cpp LEFT JOIN has no effective_from date filter (unlike the
    // bulk resolver's date-scoped legacy query), so on a future-dated legacy price row it
    // would report PRIVATE_PRICE when the date-correct answer is COMMON_PRICE. Explicitly
    // forcing the fallback keeps this identical to the original per-row getEffectivePrice()
    // behavior, which was always date-aware.
    const applyPriceMap = (list) => {
      for (const r of list) {
        const hit = priceMap.get(Number(r.product_id));
        if (hit) { r.sale_price = hit.sale_price; r.price_type = hit.price_type; r.price_book_id = hit.price_book_id || null; }
        else { r.sale_price = Number(r.default_sale_price || 0); r.price_type = 'COMMON_PRICE'; r.price_book_id = null; }
        delete r.default_sale_price;
      }
    };

    const [catalogRows] = await pool.query(
      `SELECT p.id product_id, p.product_code, p.name product_name, p.unit, p.stock_quantity,
              p.inventory_mode, p.allow_negative_stock, pc.name category_name, p.default_sale_price,
              cpc.sort_order
       FROM customer_product_catalogs cpc
       JOIN products p ON p.id=cpc.product_id AND p.del_flg=0 AND p.is_active=1 AND p.category_id=?
       LEFT JOIN product_categories pc ON pc.id=p.category_id
       WHERE cpc.customer_id=? AND cpc.del_flg=0 AND cpc.is_active=1 AND cpc.is_default=1
       ORDER BY cpc.sort_order, pc.sort_order, p.name`,
      [categoryId, customerId]
    );

    // A product with a valid effective price in this customer's current Price Book must never
    // be hidden from the POS catalog just because it has no (or a stale/removed)
    // customer_product_catalogs row — adding/editing a Price Book Item (PriceMatrixAgent.
    // updateBook) never touches that table, so a product added straight to an existing book
    // would otherwise be priced but invisible in POS/Excel import. Merge those in here.
    const catalogProductIds = new Set(catalogRows.map(r => Number(r.product_id)));
    const pricedMissingIds = [...priceMap.keys()].filter(pid => !catalogProductIds.has(Number(pid)));
    let mergedRows = catalogRows;
    if (pricedMissingIds.length) {
      const [pricedMissingRows] = await pool.query(
        `SELECT p.id product_id, p.product_code, p.name product_name, p.unit, p.stock_quantity,
                p.inventory_mode, p.allow_negative_stock, pc.name category_name, p.default_sale_price,
                p.id sort_order
         FROM products p
         LEFT JOIN product_categories pc ON pc.id=p.category_id
         WHERE p.del_flg=0 AND p.is_active=1 AND p.category_id=? AND p.id IN (?)`,
        [categoryId, pricedMissingIds]
      );
      mergedRows = [...catalogRows, ...pricedMissingRows];
    }

    if(mergedRows.length) {
      applyPriceMap(mergedRows);
      const hasPrivate = mergedRows.some(r => r.price_type && r.price_type !== 'COMMON_PRICE');
      // hasPrivate → show only private-priced products (normal POS flow)
      // !hasPrivate → show all products; frontend will allow manual price entry
      const products = (hasPrivate ? mergedRows.filter(r=>r.price_type&&r.price_type!=='COMMON_PRICE') : mergedRows)
        .sort((a,b)=>(a.sort_order-b.sort_order)||String(a.product_name).localeCompare(String(b.product_name)));
      return {customer:customers[0], products, source:'CUSTOMER_CATALOG', no_private_prices:!hasPrivate};
    }

    const [fallback] = await pool.query(
      `SELECT p.id product_id, p.product_code, p.name product_name, p.unit, p.stock_quantity,
              p.inventory_mode, p.allow_negative_stock, pc.name category_name, p.default_sale_price,
              p.id sort_order
       FROM products p
       LEFT JOIN product_categories pc ON pc.id=p.category_id
       WHERE p.del_flg=0 AND p.is_active=1 AND p.category_id=?
       ORDER BY pc.sort_order, p.name`,
      [categoryId]
    );
    applyPriceMap(fallback);
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

  async copyCatalog(fromCustomerId, toCustomerId, userId, effectiveMetaPayload = {}, categoryId = null) {
    if (!categoryId) throw Object.assign(new Error('Thiếu danh mục hàng hóa để copy bảng giá'), { status: 400 });
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [items] = await conn.query(
        `SELECT cpc.product_id, cpc.sort_order, cpc.is_default
         FROM customer_product_catalogs cpc
         JOIN products p ON p.id=cpc.product_id
         WHERE cpc.customer_id=? AND cpc.del_flg=0 AND cpc.is_active=1 AND p.category_id=?`,
        [fromCustomerId, categoryId]
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
      const fromCustomerPriceCategoryId = await PriceBookService.resolveCustomerPriceCategoryId(fromCustomerId, categoryId, conn);
      let prices = [];
      if (fromCustomerPriceCategoryId) {
        [prices] = await conn.query(
          `SELECT bi.product_id, bi.sale_price
           FROM customer_price_books b
           JOIN customer_price_book_items bi ON bi.price_book_id=b.id
           WHERE b.customer_price_category_id=? AND COALESCE(b.status,'ACTIVE')='ACTIVE'
             AND COALESCE(b.effective_calendar_type,'SOLAR')=?
           ORDER BY CASE WHEN COALESCE(b.effective_calendar_type,'SOLAR')='LUNAR' THEN COALESCE(b.effective_lunar_sort,0) ELSE 0 END DESC,
                    b.effective_from DESC,b.id DESC`,
          [fromCustomerPriceCategoryId, srcCt]
        );
      }
      const priceMap = new Map();
      prices.forEach(p => { if(!priceMap.has(String(p.product_id))) priceMap.set(String(p.product_id), p); });

      if(priceMap.size) {
        const copyItems=[...priceMap.values()].map(p=>({product_id:p.product_id,sale_price:Number(p.sale_price||0),note:`Copy from customer ${fromCustomerId}`}));
        await upsertBook(conn,toCustomerId,categoryId,meta,
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

  async listBooks(customerId, categoryId) {
    if (!categoryId) throw Object.assign(new Error('Thiếu danh mục hàng hóa'), { status: 400 });
    const customerPriceCategoryId = await PriceBookService.resolveCustomerPriceCategoryId(customerId, categoryId, pool);
    if (!customerPriceCategoryId) return [];
    const [books] = await pool.query(
      `SELECT b.id,b.customer_id,b.category_id,b.book_name,b.effective_from,b.effective_to,b.effective_calendar_type,b.effective_lunar_date_text,b.effective_lunar_sort,b.status,b.note,b.created_at,b.updated_at,
              COUNT(DISTINCT bi.product_id) item_count,
              COUNT(DISTINCT oi.order_id) bill_count,
              COUNT(DISTINCT CASE WHEN COALESCE(o.paid_amount,0)>0 OR o.payment_status IN ('PAID','PARTIAL') OR pa.id IS NOT NULL THEN oi.order_id END) paid_bill_count,
              COUNT(DISTINCT CASE WHEN oi.order_id IS NOT NULL AND COALESCE(o.paid_amount,0)=0 AND (o.payment_status IS NULL OR o.payment_status NOT IN ('PAID','PARTIAL')) AND pa.id IS NULL THEN oi.order_id END) unpaid_bill_count
       FROM customer_price_books b
       LEFT JOIN customer_price_book_items bi ON bi.price_book_id=b.id
       LEFT JOIN order_items oi ON oi.price_book_id=b.id
       LEFT JOIN orders o ON o.id=oi.order_id AND o.status<>'CANCELLED'
       LEFT JOIN payment_allocations pa ON pa.order_id=o.id
       WHERE b.customer_price_category_id=? AND COALESCE(b.status,'ACTIVE')<>'DELETED'
       GROUP BY b.id
       ORDER BY COALESCE(b.effective_lunar_sort,0) DESC,b.effective_from DESC,b.id DESC`,
      [customerPriceCategoryId]
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
      `SELECT b.*, MAX(pc.name) category_name,
              COUNT(DISTINCT oi.order_id) bill_count,
              COUNT(DISTINCT CASE WHEN COALESCE(o.paid_amount,0)>0 OR o.payment_status IN ('PAID','PARTIAL') OR pa.id IS NOT NULL THEN oi.order_id END) paid_bill_count,
              COUNT(DISTINCT CASE WHEN oi.order_id IS NOT NULL AND COALESCE(o.paid_amount,0)=0 AND (o.payment_status IS NULL OR o.payment_status NOT IN ('PAID','PARTIAL')) AND pa.id IS NULL THEN oi.order_id END) unpaid_bill_count
       FROM customer_price_books b
       LEFT JOIN customer_price_categories cpc ON cpc.id=b.customer_price_category_id
       LEFT JOIN product_categories pc ON pc.id=cpc.category_id
       LEFT JOIN order_items oi ON oi.price_book_id=b.id
       LEFT JOIN orders o ON o.id=oi.order_id AND o.status<>'CANCELLED'
       LEFT JOIN payment_allocations pa ON pa.order_id=o.id
       WHERE b.id=?
       GROUP BY b.id`,
      [bookId]
    );
    if(!books.length) throw new Error('Không tìm thấy bảng giá');
    // S4.4 CTO simplification: row-level lock. A Price Book Item is locked independently of
    // the book once it has participated in any OrderItem (paid or not — simpler and more
    // conservative than the old whole-book "paid bill" gate). Locked items keep their price
    // but can never be edited or deleted; unlocked items and brand-new items are unaffected
    // by other locked rows in the same book.
    const [items] = await pool.query(
      `SELECT bi.id,bi.price_book_id,bi.customer_id,bi.product_id,COALESCE(p.name,CONCAT('ID ',bi.product_id)) product_name,
              p.product_code,p.unit,bi.sale_price,bi.note,
              COUNT(DISTINCT oi.order_id) used_in_bill_count
       FROM customer_price_book_items bi
       LEFT JOIN products p ON p.id=bi.product_id
       LEFT JOIN order_items oi ON oi.price_book_id=bi.price_book_id AND oi.product_id=bi.product_id
       WHERE bi.price_book_id=?
       GROUP BY bi.id
       ORDER BY p.name,bi.product_id`,
      [bookId]
    );
    const itemsWithLock = items.map(it => ({
      ...it,
      can_edit: Number(it.used_in_bill_count||0)===0,
      can_delete: Number(it.used_in_bill_count||0)===0,
      lock_reason: Number(it.used_in_bill_count||0)>0 ? '🔒 Đã sử dụng trong bill' : ''
    }));
    const b = books[0];
    // Book-level can_edit/can_delete now govern the book's own header fields (name/calendar
    // type/effective date/status) only — unchanged trigger (any paid bill), unchanged
    // meaning. Item-level editing/adding is independent of this flag; see itemsWithLock.
    return {...b, items: itemsWithLock, can_edit:Number(b.paid_bill_count||0)===0, can_delete:Number(b.paid_bill_count||0)===0};
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
      const [curBookRows]=await conn.query(`SELECT customer_id, category_id, customer_price_category_id, effective_calendar_type FROM customer_price_books WHERE id=? LIMIT 1`,[bookId]);
      if(!curBookRows.length) throw new Error('Không tìm thấy bảng giá');
      // category_id / customer_price_category_id are part of the book's identity (business
      // key) and are immutable after creation — ignore anything the client sends on update.
      const bookCategoryId = curBookRows[0].category_id;
      const bookCustomerPriceCategoryId = curBookRows[0].customer_price_category_id;
      const bookStoredCalendarType = normalizeCalendarType(curBookRows[0].effective_calendar_type);

      // S4.4 CTO simplification: row-level lock replaces the old whole-book gate. The book's
      // own header fields (name/calendar type/effective date/status) keep the prior
      // "any paid bill on this book" gate, unchanged — see headerLocked below, this is the
      // exact same query/condition updateBook always used. Item add/edit/delete is now
      // independent of that flag; see the per-item locked-product check further down.
      const [paid] = await conn.query(
        `SELECT COUNT(DISTINCT o.id) cnt
         FROM orders o
         JOIN order_items oi ON oi.order_id=o.id
         LEFT JOIN payment_allocations pa ON pa.order_id=o.id
         WHERE oi.price_book_id=? AND o.status<>'CANCELLED'
           AND (COALESCE(o.paid_amount,0)>0 OR o.payment_status IN ('PAID','PARTIAL') OR pa.id IS NOT NULL)`,
        [bookId]
      );
      const headerLocked = Number(paid[0]?.cnt||0)>0;

      if(Array.isArray(data.items)) await assertItemsMatchCategory(conn, bookCategoryId, data.items);

      if (!headerLocked) {
        const meta = await resolvePriceBookMeta(conn, curBookRows[0].customer_id, data);
        // CTO final rule: Customer.billing_calendar_type is authoritative only when creating a
        // NEW price book (see upsertBook). An existing book's effective_calendar_type is fixed
        // at creation and can never be converted afterwards — reject only if this request is
        // actually trying to change it. If it's unchanged, never compare it against the
        // customer's CURRENT billing_calendar_type: that field may have diverged since this
        // book was created, and re-checking it here would make an otherwise-untouched
        // historical book permanently uneditable.
        if (meta.effective_calendar_type !== bookStoredCalendarType) {
          throw Object.assign(
            new Error(`Không thể đổi loại lịch của bảng giá đã tồn tại (đang là ${bookStoredCalendarType==='LUNAR'?'Âm lịch':'Dương lịch'}).`),
            { status: 400, code: 'CALENDAR_TYPE_IMMUTABLE' }
          );
        }
        const [conflict]=await conn.query(
          `SELECT id FROM customer_price_books
           WHERE customer_price_category_id=? AND effective_from=? AND effective_calendar_type=?
             AND COALESCE(status,'ACTIVE')<>'DELETED' AND id<>?
           LIMIT 1`,
          [bookCustomerPriceCategoryId, meta.effective_from, meta.effective_calendar_type, bookId]
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
      }

      if(Array.isArray(data.items)) {
        const [existingItems] = await conn.query(
          `SELECT product_id FROM customer_price_book_items WHERE price_book_id=?`,
          [bookId]
        );
        // A Price Book Item is locked the moment it has participated in any OrderItem —
        // never trust the frontend for this, always re-check server-side. Locked items are
        // silently left untouched (price/note unchanged, never deleted) no matter what the
        // payload contains; new items and unlocked existing items are unaffected.
        const [lockedRows] = await conn.query(
          `SELECT DISTINCT product_id FROM order_items WHERE price_book_id=?`,
          [bookId]
        );
        const lockedProductIds = new Set(lockedRows.map(r => Number(r.product_id)));
        const existingProductIds = new Set(existingItems.map(r => Number(r.product_id)));
        const payloadProductIds = new Set(data.items.filter(it=>it.product_id).map(it=>Number(it.product_id)));

        for(const it of data.items) {
          if(!it.product_id) continue;
          const pid = Number(it.product_id);
          if (existingProductIds.has(pid) && lockedProductIds.has(pid)) continue; // locked — never edit
          await conn.query(
            `INSERT INTO customer_price_book_items(price_book_id,customer_id,product_id,sale_price,note)
             SELECT ?,customer_id,?,?,? FROM customer_price_books WHERE id=?
             ON DUPLICATE KEY UPDATE sale_price=VALUES(sale_price), note=VALUES(note)`,
            [bookId, pid, Number(it.sale_price||0), it.note || null, bookId]
          );
        }

        // Rows present in the DB but missing from the payload were removed client-side.
        // Delete them, but only if unlocked — a locked row can never be deleted, even by
        // omission, so it is silently preserved.
        for (const pid of existingProductIds) {
          if (payloadProductIds.has(pid)) continue;
          if (lockedProductIds.has(pid)) continue;
          await conn.query(`DELETE FROM customer_price_book_items WHERE price_book_id=? AND product_id=?`, [bookId, pid]);
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
      },
      body.category_id
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
      const {price_book_id:newBookId}=await upsertBook(conn,toCustomerId,src.category_id,meta,
        {bookName:data.book_name||`Copy từ bảng giá #${bookId} - ${meta.display_date}`,note:data.note||`Copy from price_book_id ${bookId}`,status:'ACTIVE'},
        userId,copyItems);
      await conn.commit();
      return {message:'Đã copy bảng giá', price_book_id:newBookId, effective_from:meta.effective_from, effective_calendar_type:meta.effective_calendar_type, effective_lunar_date_text:meta.effective_lunar_date_text};
    } catch(e) { await conn.rollback(); throw e; }
    finally { conn.release(); }
  }

}

module.exports = new PriceMatrixAgent();
