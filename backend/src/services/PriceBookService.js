const pool = require('../config/db');
const { parseLunarText, lunarToSolarDate, solarToLunar } = require('../utils/lunarDate');

function normalizeCalendarType(v) {
  return String(v || 'SOLAR').toUpperCase() === 'LUNAR' ? 'LUNAR' : 'SOLAR';
}
function todayIso() { return new Date().toISOString().slice(0, 10); }
function normalizeSolarDate(value) {
  const raw = String(value || todayIso()).trim();
  // Accept both production API format YYYY-MM-DD and UI/Excel date DD/MM/YYYY.
  const ddmmyyyy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (ddmmyyyy) {
    const d = String(ddmmyyyy[1]).padStart(2, '0');
    const m = String(ddmmyyyy[2]).padStart(2, '0');
    return `${ddmmyyyy[3]}-${m}-${d}`;
  }
  const s = raw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('Ngày hiệu lực dương lịch không hợp lệ. Định dạng đúng: YYYY-MM-DD');
  return s;
}
function lunarSortFromText(text) {
  const p = parseLunarText(text);
  if (!p) return null;
  return Number(p.year) * 10000 + Number(p.month) * 100 + Number(p.day);
}
function lunarTextFromSolar(date) {
  const l = solarToLunar(String(date || todayIso()).slice(0, 10));
  return `${String(l.day).padStart(2, '0')}/${String(l.month).padStart(2, '0')}/${l.year}`;
}
async function customerCalendarType(customerId, conn = pool) {
  const [rows] = await conn.query(`SELECT billing_calendar_type FROM customers WHERE id=? LIMIT 1`, [customerId]);
  return normalizeCalendarType(rows[0]?.billing_calendar_type || 'SOLAR');
}

function resolveBillLookupContext(input = {}, defaultCalendarType = 'SOLAR') {
  const calendarType = normalizeCalendarType(input.calendar_type || input.effective_calendar_type || defaultCalendarType);
  const billDate = normalizeSolarDate(input.bill_date || input.order_date || input.effective_from || input.date || todayIso());
  if (calendarType === 'LUNAR') {
    const lunarText = String(input.lunar_date_text || input.effective_lunar_date_text || '').trim() || lunarTextFromSolar(billDate);
    const sort = lunarSortFromText(lunarText);
    if (!sort) throw new Error('Ngày âm lịch của bill không hợp lệ. Định dạng đúng: DD/MM/YYYY');
    return { calendar_type:'LUNAR', bill_date:billDate, lunar_date_text:lunarText, lunar_sort:sort };
  }
  return { calendar_type:'SOLAR', bill_date:billDate, lunar_date_text:'', lunar_sort:null };
}
function resolveEffectiveMeta(input = {}, defaultCalendarType = 'SOLAR') {
  const calendarType = normalizeCalendarType(input.effective_calendar_type || input.calendar_type || defaultCalendarType);
  if (calendarType === 'LUNAR') {
    const lunarDateText = String(input.effective_lunar_date_text || input.lunar_date_text || '').trim();
    const sort = lunarSortFromText(lunarDateText);
    if (!sort) throw new Error('Ngày hiệu lực âm lịch không hợp lệ. Định dạng đúng: DD/MM/YYYY, ví dụ 01/02/2026');
    const solar = lunarToSolarDate(parseLunarText(lunarDateText)) || normalizeSolarDate(input.effective_from || input.date || todayIso());
    return {
      effective_calendar_type: 'LUNAR',
      effective_from: solar,
      effective_lunar_date_text: lunarDateText,
      effective_lunar_sort: sort,
      display_date: `${lunarDateText} ÂL`
    };
  }
  const from = normalizeSolarDate(input.effective_from || input.date || todayIso());
  return {
    effective_calendar_type: 'SOLAR',
    effective_from: from,
    effective_lunar_date_text: null,
    effective_lunar_sort: null,
    display_date: from
  };
}

class PriceBookService {
  resolveEffectiveMeta(input, defaultCalendarType) { return resolveEffectiveMeta(input, defaultCalendarType); }
  lunarSortFromText(text) { return lunarSortFromText(text); }
  resolveBillLookupContext(input, defaultCalendarType) { return resolveBillLookupContext(input, defaultCalendarType); }
  async customerCalendarType(customerId, conn = pool) { return customerCalendarType(customerId, conn); }

  // S4.3: resolve the CustomerPriceCategory id for (customerId, categoryId). Never creates
  // one — creation is always an explicit user action (POS guided init / Price Matrix), never
  // silent. Returns null when the pair has no CustomerPriceCategory yet (customer has never
  // been set up for that category), which callers treat as "no price book can exist here".
  async resolveCustomerPriceCategoryId(customerId, categoryId, conn = pool) {
    if (!customerId || !categoryId) return null;
    const [rows] = await conn.query(
      `SELECT id FROM customer_price_categories WHERE customer_id=? AND category_id=? LIMIT 1`,
      [customerId, categoryId]
    );
    return rows.length ? rows[0].id : null;
  }

  // Perf fix: bulk equivalent of calling getEffectivePrice() once per product in a category.
  // PriceMatrixAgent.matrix() previously called getEffectivePrice() per row, which itself
  // issued up to 5 queries (product category lookup, CustomerPriceCategory resolve, price
  // book lookup, legacy fallback, default fallback) — an N+1 that measured at 255 queries /
  // ~3.2s for a 53-product category. This resolves the SAME per-product "most recent
  // applicable price across all book versions" logic in a fixed small number of set-based
  // queries instead of one round trip per product.
  //
  // Semantics preserved exactly: getEffectivePrice()'s book-lookup query joins
  // customer_price_book_items to customer_price_books and picks the single most recent
  // (by effective_from/effective_lunar_sort) row PER PRODUCT — not "the newest book for the
  // category" — because a newer book version may not touch every product (partial price
  // updates are valid), so an older version can still be the correct source for some
  // products. The window-function query below reproduces that per-product ranking exactly
  // via PARTITION BY product_id, then LIMIT-1-per-group via rn=1.
  //
  // Returns a Map<productId, {sale_price, price_type:'PRICE_BOOK'|'PRIVATE_PRICE', price_book_id,
  // effective_from?, effective_lunar_date_text?, effective_lunar_sort?}> containing only
  // products that resolved via a price book or the legacy customer_product_prices table
  // (the last 3 fields are only present for PRICE_BOOK hits, mirroring getEffectivePrice()'s
  // return shape). Products absent from the map have no PRICE_BOOK/PRIVATE_PRICE match — the
  // caller (which already has products.default_sale_price from its own base query) applies
  // the COMMON_PRICE fallback itself, exactly as getEffectivePrice() would.
  // getEffectivePrice() itself is intentionally left untouched — this is a separate, additive
  // bulk path used by matrix(), customerCatalogForOrder(), and getEffectivePrices() below —
  // not a change to the generic single-product API.
  async getEffectivePricesForCategory(customerId, categoryId, billDate = null, calendarType = null, lunarDateText = '', conn = pool) {
    const defaultCt = calendarType || await customerCalendarType(customerId, conn);
    const ctx = resolveBillLookupContext({ bill_date: billDate, calendar_type: defaultCt, lunar_date_text: lunarDateText }, defaultCt);
    const priceMap = new Map();

    const customerPriceCategoryId = await this.resolveCustomerPriceCategoryId(customerId, categoryId, conn);
    if (customerPriceCategoryId) {
      let rows;
      if (ctx.calendar_type === 'LUNAR') {
        [rows] = await conn.query(
          `SELECT x.product_id, x.sale_price, x.price_book_id, x.effective_lunar_date_text, x.effective_lunar_sort
           FROM (
             SELECT bi.product_id, bi.sale_price, b.id price_book_id,
                    b.effective_lunar_date_text, b.effective_lunar_sort,
                    ROW_NUMBER() OVER (
                      PARTITION BY bi.product_id
                      ORDER BY COALESCE(b.effective_lunar_sort,0) DESC, b.id DESC
                    ) rn
             FROM customer_price_book_items bi
             JOIN customer_price_books b ON b.id = bi.price_book_id
             WHERE b.customer_price_category_id = ?
               AND COALESCE(b.status,'ACTIVE') = 'ACTIVE'
               AND COALESCE(b.effective_calendar_type,'SOLAR') = 'LUNAR'
               AND COALESCE(b.effective_lunar_sort,0) <= ?
           ) x
           WHERE x.rn = 1`,
          [customerPriceCategoryId, ctx.lunar_sort]
        );
      } else {
        [rows] = await conn.query(
          `SELECT x.product_id, x.sale_price, x.price_book_id, x.effective_from
           FROM (
             SELECT bi.product_id, bi.sale_price, b.id price_book_id, b.effective_from,
                    ROW_NUMBER() OVER (
                      PARTITION BY bi.product_id
                      ORDER BY b.effective_from DESC, b.id DESC
                    ) rn
             FROM customer_price_book_items bi
             JOIN customer_price_books b ON b.id = bi.price_book_id
             WHERE b.customer_price_category_id = ?
               AND COALESCE(b.status,'ACTIVE') = 'ACTIVE'
               AND COALESCE(b.effective_calendar_type,'SOLAR') = 'SOLAR'
               AND b.effective_from <= ?
           ) x
           WHERE x.rn = 1`,
          [customerPriceCategoryId, ctx.bill_date]
        );
      }
      for (const r of rows) {
        priceMap.set(Number(r.product_id), {
          sale_price: Number(r.sale_price || 0), price_type: 'PRICE_BOOK', price_book_id: r.price_book_id,
          effective_from: r.effective_from, effective_lunar_date_text: r.effective_lunar_date_text, effective_lunar_sort: r.effective_lunar_sort
        });
      }
    }

    // Legacy fallback (pre-S4.2 table) — independent of CustomerPriceCategory, same as
    // getEffectivePrice()'s unconditional legacy check. Only fills gaps the book map missed.
    const [legacyRows] = await conn.query(
      `SELECT x.product_id, x.sale_price
       FROM (
         SELECT product_id, sale_price,
                ROW_NUMBER() OVER (PARTITION BY product_id ORDER BY effective_from DESC, id DESC) rn
         FROM customer_product_prices
         WHERE customer_id = ? AND is_active = 1
           AND (effective_from IS NULL OR effective_from <= ?)
       ) x
       WHERE x.rn = 1`,
      [customerId, ctx.bill_date]
    );
    for (const r of legacyRows) {
      const productId = Number(r.product_id);
      if (!priceMap.has(productId)) {
        priceMap.set(productId, { sale_price: Number(r.sale_price || 0), price_type: 'PRIVATE_PRICE', price_book_id: null });
      }
    }

    return priceMap;
  }

  // CTO S4.3 governance: customer_price_books/customer_price_book_items must only ever be
  // read/written from PriceBookService or PriceMatrixAgent — no other module may query them
  // directly. This is the shared lookup for "the active price book's line items for a
  // partner/customer at a given effective date, optionally scoped to a category" — used by
  // getEffectivePrice() (customer POS pricing) and by SupplierPurchaseCatalogResolver
  // (supplier purchase catalog), which delegates here instead of querying the table itself.
  async findActiveBookItemsForPartner(partnerId, meta, categoryId = null, conn = pool) {
    let customerPriceCategoryId = null;
    if (categoryId) {
      customerPriceCategoryId = await this.resolveCustomerPriceCategoryId(partnerId, categoryId, conn);
      if (!customerPriceCategoryId) return [];
    }
    const categoryFilter = customerPriceCategoryId ? 'AND customer_price_category_id = ?' : '';
    const categoryParam = customerPriceCategoryId ? [customerPriceCategoryId] : [];
    let bookRows;
    if (meta.effective_calendar_type === 'LUNAR') {
      [bookRows] = await conn.query(
        `SELECT id FROM customer_price_books
         WHERE customer_id = ? AND COALESCE(status, 'ACTIVE') = 'ACTIVE'
           AND COALESCE(effective_calendar_type, 'SOLAR') = 'LUNAR'
           AND COALESCE(effective_lunar_sort, 0) <= ?
           ${categoryFilter}
         ORDER BY COALESCE(effective_lunar_sort, 0) DESC, id DESC
         LIMIT 1`,
        [partnerId, meta.effective_lunar_sort, ...categoryParam]
      );
    } else {
      [bookRows] = await conn.query(
        `SELECT id FROM customer_price_books
         WHERE customer_id = ? AND COALESCE(status, 'ACTIVE') = 'ACTIVE'
           AND COALESCE(effective_calendar_type, 'SOLAR') = 'SOLAR'
           AND effective_from <= ?
           ${categoryFilter}
         ORDER BY effective_from DESC, id DESC
         LIMIT 1`,
        [partnerId, meta.effective_from, ...categoryParam]
      );
    }
    if (!bookRows.length) return [];

    const [rows] = await conn.query(
      `SELECT bi.product_id, bi.sale_price AS purchase_price,
              p.name product_name, p.product_code,
              p.inventory_mode, p.unit default_unit,
              pc.name category_name,
              COALESCE(pc.sort_order, 9999) category_sort_order
       FROM customer_price_book_items bi
       JOIN products p ON p.id = bi.product_id AND p.del_flg = 0 AND p.is_active = 1
       LEFT JOIN product_categories pc ON pc.id = p.category_id
       WHERE bi.price_book_id = ?
       ORDER BY COALESCE(pc.sort_order, 9999), p.name`,
      [bookRows[0].id]
    );
    return rows;
  }

  async getEffectivePrice(customerId, productId, billDate = null, conn = pool, calendarType = null, lunarDateText = '') {
    const defaultCt = calendarType || await customerCalendarType(customerId, conn);
    const ctx = resolveBillLookupContext({ bill_date: billDate, calendar_type: defaultCt, lunar_date_text: lunarDateText }, defaultCt);

    // S4.3: category is the pricing scope. The caller never supplies it — it is derived
    // server-side from the product being priced, then resolved to the customer's
    // CustomerPriceCategory (the entity a price book version actually belongs to).
    // No CustomerPriceCategory yet means no price book can exist for it either — falls
    // straight through to the legacy/default price chain below.
    const [[productRow]] = await conn.query(`SELECT category_id FROM products WHERE id=? LIMIT 1`, [productId]);
    const categoryId = productRow ? productRow.category_id : null;
    const customerPriceCategoryId = await this.resolveCustomerPriceCategoryId(customerId, categoryId, conn);

    if (customerPriceCategoryId) {
      if (ctx.calendar_type === 'LUNAR') {
        const [rows] = await conn.query(
          `SELECT bi.sale_price, b.id price_book_id, b.effective_lunar_date_text, b.effective_lunar_sort
           FROM customer_price_books b
           JOIN customer_price_book_items bi ON bi.price_book_id=b.id
           WHERE b.customer_price_category_id=? AND bi.product_id=?
             AND COALESCE(b.status,'ACTIVE')='ACTIVE'
             AND COALESCE(b.effective_calendar_type,'SOLAR')='LUNAR'
             AND COALESCE(b.effective_lunar_sort,0)<=?
           ORDER BY COALESCE(b.effective_lunar_sort,0) DESC,b.id DESC
           LIMIT 1`,
          [customerPriceCategoryId, productId, ctx.lunar_sort]
        );
        if (rows.length) return { sale_price:Number(rows[0].sale_price||0), price_type:'PRICE_BOOK', price_book_id:rows[0].price_book_id, effective_lunar_date_text:rows[0].effective_lunar_date_text, effective_lunar_sort:rows[0].effective_lunar_sort };
      } else {
        const [rows] = await conn.query(
          `SELECT bi.sale_price, b.id price_book_id, b.effective_from
           FROM customer_price_books b
           JOIN customer_price_book_items bi ON bi.price_book_id=b.id
           WHERE b.customer_price_category_id=? AND bi.product_id=?
             AND COALESCE(b.status,'ACTIVE')='ACTIVE'
             AND COALESCE(b.effective_calendar_type,'SOLAR')='SOLAR'
             AND b.effective_from<=?
           ORDER BY b.effective_from DESC,b.id DESC
           LIMIT 1`,
          [customerPriceCategoryId, productId, ctx.bill_date]
        );
        if (rows.length) return { sale_price:Number(rows[0].sale_price||0), price_type:'PRICE_BOOK', price_book_id:rows[0].price_book_id, effective_from:rows[0].effective_from };
      }
    }

    const [legacy] = await conn.query(
      `SELECT sale_price FROM customer_product_prices
       WHERE customer_id=? AND product_id=? AND is_active=1
         AND (effective_from IS NULL OR effective_from <= ?)
       ORDER BY effective_from DESC,id DESC LIMIT 1`,
      [customerId, productId, ctx.bill_date]
    );
    if (legacy.length) return { sale_price:Number(legacy[0].sale_price||0), price_type:'PRIVATE_PRICE', price_book_id:null };

    const [products] = await conn.query(`SELECT default_sale_price FROM products WHERE id=? LIMIT 1`, [productId]);
    if (products.length) return { sale_price:Number(products[0].default_sale_price||0), price_type:'COMMON_PRICE', price_book_id:null };
    return null;
  }


  // Perf fix: this is POS's "re-resolve by bill shipping date" preview call (V65.52) — the
  // frontend calls it right after customerCatalogForOrder() (which resolves by *today*) to
  // correct prices for a bill dated differently, e.g. an imported Excel bill or a lunar date
  // in the past. Previously called getEffectivePrice() once per product id — an N+1 that
  // stacked on top of every POS catalog load even after customerCatalogForOrder() itself was
  // fixed. In practice all ids here belong to the same category (POS enforces "1 bill = 1
  // category"), so this groups by category (defensively handling more than one, though that
  // shouldn't occur) and calls the bulk resolver once per distinct category — a fixed small
  // number of queries instead of one per product.
  async getEffectivePrices(customerId, productIds, context = {}, conn = pool) {
    const ids = [...new Set((productIds || []).map(x => Number(x)).filter(Boolean))];
    const defaultCt = context.calendar_type || await customerCalendarType(customerId, conn);
    const ctx = resolveBillLookupContext(context, defaultCt);
    const prices = {};
    if (!ids.length) return { customer_id:Number(customerId), ...ctx, prices };

    const [productRows] = await conn.query(`SELECT id, category_id, default_sale_price FROM products WHERE id IN (?)`, [ids]);
    const productMeta = new Map(productRows.map(r => [Number(r.id), r]));

    const idsByCategory = new Map();
    for (const id of ids) {
      const catId = productMeta.has(id) ? productMeta.get(id).category_id : null;
      if (!idsByCategory.has(catId)) idsByCategory.set(catId, []);
      idsByCategory.get(catId).push(id);
    }

    for (const [catId, catIds] of idsByCategory.entries()) {
      const priceMap = catId ? await this.getEffectivePricesForCategory(customerId, catId, ctx.bill_date, ctx.calendar_type, ctx.lunar_date_text, conn) : new Map();
      for (const id of catIds) {
        const hit = priceMap.get(id);
        if (hit) { prices[id] = hit; continue; }
        const meta = productMeta.get(id);
        prices[id] = meta ? { sale_price: Number(meta.default_sale_price || 0), price_type: 'COMMON_PRICE', price_book_id: null } : null;
      }
    }
    return { customer_id:Number(customerId), ...ctx, prices };
  }

  async createOrReplaceBook(customerId, items, effectiveFromOrPayload, userId = null, note = '', categoryId = null) {
    if (!categoryId) throw Object.assign(new Error('Thiếu danh mục hàng hóa cho bảng giá'), { status: 400 });
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // S4.3: a price book can only be created under an existing CustomerPriceCategory —
      // never auto-created here. The caller (POS guided init / Price Matrix) is responsible
      // for creating it first via an explicit user action.
      const customerPriceCategoryId = await this.resolveCustomerPriceCategoryId(customerId, categoryId, conn);
      if (!customerPriceCategoryId) {
        throw Object.assign(
          new Error('Khách hàng chưa có Danh mục giá cho danh mục hàng hóa này. Vui lòng tạo trước khi lưu bảng giá.'),
          { status: 400, code: 'CUSTOMER_PRICE_CATEGORY_NOT_FOUND' }
        );
      }

      // S4.2: a book may only contain products of its own category — never trust the caller.
      const productIds = [...new Set((items || []).map(x => Number(x.product_id)).filter(Boolean))];
      if (productIds.length) {
        const [prodRows] = await conn.query(`SELECT id, name, category_id FROM products WHERE id IN (?)`, [productIds]);
        const mismatched = prodRows.filter(r => Number(r.category_id) !== Number(categoryId));
        if (mismatched.length) {
          throw Object.assign(
            new Error(`Sản phẩm không thuộc danh mục của bảng giá này: ${mismatched.map(r => r.name).join(', ')}`),
            { status: 400 }
          );
        }
      }

      const defaultCt = await customerCalendarType(customerId, conn);
      const meta = resolveEffectiveMeta(
        typeof effectiveFromOrPayload === 'object' ? effectiveFromOrPayload : { effective_from: effectiveFromOrPayload },
        defaultCt
      );
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
          `UPDATE customer_price_books SET book_name=COALESCE(?,book_name), status='ACTIVE', note=?, updated_at=NOW() WHERE id=?`,
          [`Bảng giá từ ${meta.display_date}`, note || 'Price book versioning', bookId]
        );
        await conn.query(`DELETE FROM customer_price_book_items WHERE price_book_id=?`, [bookId]);
      } else {
        const [r] = await conn.query(
          `INSERT INTO customer_price_books(customer_id,category_id,customer_price_category_id,book_name,effective_from,effective_calendar_type,effective_lunar_date_text,effective_lunar_sort,status,note,created_by)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          [customerId, categoryId, customerPriceCategoryId, `Bảng giá từ ${meta.display_date}`, meta.effective_from, meta.effective_calendar_type, meta.effective_lunar_date_text, meta.effective_lunar_sort, 'ACTIVE', note || 'Price book versioning', userId]
        );
        bookId = r.insertId;
      }
      for (const it of items || []) {
        if (!it.product_id) continue;
        await conn.query(
          `INSERT INTO customer_price_book_items(price_book_id,customer_id,product_id,sale_price,note)
           VALUES(?,?,?,?,?)`,
          [bookId, customerId, it.product_id, Number(it.sale_price ?? it.private_price ?? 0), it.note || null]
        );
      }
      await conn.commit();
      return { message: existing.length ? 'Đã cập nhật phiên bản bảng giá' : 'Đã tạo phiên bản bảng giá mới', price_book_id: bookId, ...meta };
    } catch (e) { await conn.rollback(); throw e; }
    finally { conn.release(); }
  }
}

module.exports = new PriceBookService();
