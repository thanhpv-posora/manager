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

  async getEffectivePrice(customerId, productId, billDate = null, conn = pool, calendarType = null, lunarDateText = '') {
    const defaultCt = calendarType || await customerCalendarType(customerId, conn);
    const ctx = resolveBillLookupContext({ bill_date: billDate, calendar_type: defaultCt, lunar_date_text: lunarDateText }, defaultCt);

    if (ctx.calendar_type === 'LUNAR') {
      const [rows] = await conn.query(
        `SELECT bi.sale_price, b.id price_book_id, b.effective_lunar_date_text, b.effective_lunar_sort
         FROM customer_price_books b
         JOIN customer_price_book_items bi ON bi.price_book_id=b.id
         WHERE b.customer_id=? AND bi.product_id=?
           AND COALESCE(b.status,'ACTIVE')='ACTIVE'
           AND COALESCE(b.effective_calendar_type,'SOLAR')='LUNAR'
           AND COALESCE(b.effective_lunar_sort,0)<=?
         ORDER BY COALESCE(b.effective_lunar_sort,0) DESC,b.id DESC
         LIMIT 1`,
        [customerId, productId, ctx.lunar_sort]
      );
      if (rows.length) return { sale_price:Number(rows[0].sale_price||0), price_type:'PRICE_BOOK', price_book_id:rows[0].price_book_id, effective_lunar_date_text:rows[0].effective_lunar_date_text, effective_lunar_sort:rows[0].effective_lunar_sort };
    } else {
      const [rows] = await conn.query(
        `SELECT bi.sale_price, b.id price_book_id, b.effective_from
         FROM customer_price_books b
         JOIN customer_price_book_items bi ON bi.price_book_id=b.id
         WHERE b.customer_id=? AND bi.product_id=?
           AND COALESCE(b.status,'ACTIVE')='ACTIVE'
           AND COALESCE(b.effective_calendar_type,'SOLAR')='SOLAR'
           AND b.effective_from<=?
         ORDER BY b.effective_from DESC,b.id DESC
         LIMIT 1`,
        [customerId, productId, ctx.bill_date]
      );
      if (rows.length) return { sale_price:Number(rows[0].sale_price||0), price_type:'PRICE_BOOK', price_book_id:rows[0].price_book_id, effective_from:rows[0].effective_from };
    }

    const [legacy] = await conn.query(
      `SELECT sale_price FROM customer_product_prices
       WHERE customer_id=? AND product_id=? AND is_active=1
       ORDER BY effective_from DESC,id DESC LIMIT 1`,
      [customerId, productId]
    );
    if (legacy.length) return { sale_price:Number(legacy[0].sale_price||0), price_type:'PRIVATE_PRICE', price_book_id:null };

    const [products] = await conn.query(`SELECT default_sale_price FROM products WHERE id=? LIMIT 1`, [productId]);
    if (products.length) return { sale_price:Number(products[0].default_sale_price||0), price_type:'COMMON_PRICE', price_book_id:null };
    return null;
  }


  async getEffectivePrices(customerId, productIds, context = {}, conn = pool) {
    const ids = [...new Set((productIds || []).map(x => Number(x)).filter(Boolean))];
    const defaultCt = context.calendar_type || await customerCalendarType(customerId, conn);
    const ctx = resolveBillLookupContext(context, defaultCt);
    const prices = {};
    for (const productId of ids) {
      const price = await this.getEffectivePrice(customerId, productId, ctx.bill_date, conn, ctx.calendar_type, ctx.lunar_date_text);
      prices[productId] = price || null;
    }
    return { customer_id:Number(customerId), ...ctx, prices };
  }

  async createOrReplaceBook(customerId, items, effectiveFromOrPayload, userId = null, note = '') {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const defaultCt = await customerCalendarType(customerId, conn);
      const meta = resolveEffectiveMeta(
        typeof effectiveFromOrPayload === 'object' ? effectiveFromOrPayload : { effective_from: effectiveFromOrPayload },
        defaultCt
      );
      const [r] = await conn.query(
        `INSERT INTO customer_price_books(customer_id,book_name,effective_from,effective_calendar_type,effective_lunar_date_text,effective_lunar_sort,status,note,created_by)
         VALUES(?,?,?,?,?,?,?,?,?)`,
        [customerId, `Bảng giá từ ${meta.display_date}`, meta.effective_from, meta.effective_calendar_type, meta.effective_lunar_date_text, meta.effective_lunar_sort, 'ACTIVE', note || 'Price book versioning', userId]
      );
      for (const it of items || []) {
        if (!it.product_id) continue;
        await conn.query(
          `INSERT INTO customer_price_book_items(price_book_id,customer_id,product_id,sale_price,note)
           VALUES(?,?,?,?,?)`,
          [r.insertId, customerId, it.product_id, Number(it.sale_price ?? it.private_price ?? 0), it.note || null]
        );
      }
      await conn.commit();
      return { message:'Đã tạo phiên bản bảng giá mới', price_book_id:r.insertId, ...meta };
    } catch (e) { await conn.rollback(); throw e; }
    finally { conn.release(); }
  }
}

module.exports = new PriceBookService();
