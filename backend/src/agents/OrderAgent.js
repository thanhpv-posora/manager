const pool = require('../config/db');
const { nanoid } = require('nanoid');
const { nextCode } = require('../utils/code');
const InventoryService = require('../services/InventoryService');
const PrintService = require('../services/PrintService');
const DebtMonthlyInstallmentAgent=require('./DebtMonthlyInstallmentAgent');
const { resolveBillSolarDate }=require('../utils/lunarDate');
const PriceBookService = require('../services/PriceBookService');
const { assertCustomerScope, customerScopeWhere }=require('../middleware/scope');
const { normalizeInventoryMode } = require('../utils/inventoryMode');

function parseLunarDateParts(text){
  const m=String(text||'').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if(!m)return null;
  return {day:Number(m[1]),month:Number(m[2]),year:Number(m[3])};
}


async function buildMissingPriceError(conn, customerId, billDate, missingIds) {
  const ids = [...new Set((missingIds || []).map(x => Number(x)).filter(Boolean))];
  let items = ids.map(id => ({ product_id: id, product_name: `ID ${id}` }));
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const [products] = await conn.query(
      `SELECT id, name FROM products WHERE id IN (${placeholders})`,
      ids
    );
    const names = new Map(products.map(p => [Number(p.id), p.name || `ID ${p.id}`]));
    items = ids.map(id => ({ product_id: id, product_name: names.get(id) || `ID ${id}` }));
  }
  const msg = items.length === 1
    ? `Khách chưa có giá cho mặt hàng ${items[0].product_name}. Vui lòng cập nhật bảng giá riêng trước khi lưu bill.`
    : `Khách chưa có giá cho ${items.length} mặt hàng: ${items.map(x => x.product_name).join(', ')}. Vui lòng cập nhật bảng giá riêng trước khi lưu bill.`;
  const err = new Error(msg);
  err.status = 400;
  err.statusCode = 400;
  err.code = 'PRICE_NOT_FOUND';
  err.details = { customer_id: customerId, bill_date: billDate, items };
  return err;
}

function businessError(message, code) {
  const err = new Error(message);
  err.status = 400; err.statusCode = 400; err.code = code;
  return err;
}

// Mixed Sales Phase 1A: sales_flow is a DERIVED value, never trusted from the
// frontend — neither data.sales_flow nor any item.inventory_mode/item.sales_flow
// sent in the request body is read here. Every item's product row is re-read
// fresh from the DB inside the transaction, and both the per-item branch and
// the order-header branch are computed from that alone.
//
//   CARCASS_PART -> item sales_flow = CARCASS_POS
//   TRACK_STOCK  -> item sales_flow = INVENTORY_SALE (unless allow_negative_stock=1 — see below)
//   NON_STOCK    -> rejects the whole bill; out of scope for both branches until
//                   separately approved (V1 of mixed sales only models CARCASS_PART/TRACK_STOCK)
//
// allow_negative_stock=1 on a TRACK_STOCK item rejects the whole bill for the
// same reason V1 never supports negative stock: InventoryPolicyResolver.resolve()
// (unchanged, see OrderAgent's own S11 audit) treats allow_negative_stock=1 as
// needStockCheck=false, meaning postOut() SKIPS the stock check and the balance
// update entirely rather than deducting below zero — Bán hàng kho must never
// silently take that skip-path.
//
// Order header: one distinct item branch -> that branch; two distinct branches
// (CARCASS_POS + INVENTORY_SALE both present) -> MIXED; zero items classified
// (shouldn't happen — create() already requires at least one item) -> null.
async function deriveItemsSalesFlow(conn, items) {
  const productIds = [...new Set((items || []).map(it => Number(it.product_id)).filter(Boolean))];
  const itemFlowByProductId = new Map();
  if (!productIds.length) return { itemFlowByProductId, orderSalesFlow: null };

  const [rows] = await conn.query(
    `SELECT id, name, inventory_mode, allow_negative_stock FROM products WHERE id IN (?)`,
    [productIds]
  );
  const byId = new Map(rows.map(r => [Number(r.id), r]));

  const nonStockNames = [];
  const negativeStockNames = [];
  const flows = new Set();

  for (const pid of productIds) {
    const p = byId.get(pid);
    // A product_id that doesn't resolve here is left unclassified — the existing
    // price-resolution step later in create() is what surfaces "product not found"
    // for a genuinely bad product_id; this function must not duplicate that error.
    if (!p) continue;
    const mode = normalizeInventoryMode(p.inventory_mode);
    if (mode === 'NON_STOCK') { nonStockNames.push(p.name); continue; }
    if (mode === 'TRACK_STOCK' && Number(p.allow_negative_stock) === 1) { negativeStockNames.push(p.name); continue; }
    const flow = mode === 'TRACK_STOCK' ? 'INVENTORY_SALE' : 'CARCASS_POS';
    itemFlowByProductId.set(pid, flow);
    flows.add(flow);
  }

  if (nonStockNames.length) {
    const err = new Error(`Mặt hàng không quản lý tồn kho (NON_STOCK) chưa được hỗ trợ trong bán hàng kết hợp: ${nonStockNames.join(', ')}`);
    err.status = 400; err.statusCode = 400; err.code = 'SALES_FLOW_NON_STOCK_NOT_SUPPORTED';
    throw err;
  }
  if (negativeStockNames.length) {
    const err = new Error(`Bán hàng kho không hỗ trợ mặt hàng cho phép bán âm: ${negativeStockNames.join(', ')}`);
    err.status = 400; err.statusCode = 400; err.code = 'SALES_FLOW_NEGATIVE_STOCK_NOT_ALLOWED';
    throw err;
  }

  const orderSalesFlow = flows.size === 0 ? null : (flows.size === 1 ? [...flows][0] : 'MIXED');
  return { itemFlowByProductId, orderSalesFlow };
}

// Mixed Sales Phase 1B Task 5: replaces the old "1 bill = 1 products.category_id"
// rule (assertItemsSingleCategory / assertItemMatchesOrderCategory, both removed)
// with "each sales_flow may use at most one Customer Price Category" — a mixed
// bill may span two product_categories (one per flow) as long as neither flow's
// non-null category count exceeds 1.
//
// For every item with a resolved price_book_id, the book -> category chain is
// re-read fresh from the DB (never trusted from the frontend) and validated:
//   - the price book belongs to this customer (PRICE_BOOK_WRONG_CUSTOMER)
//   - the product is actually a line in that price book (PRODUCT_NOT_IN_PRICE_BOOK)
//   - the category belongs to this customer (PRICE_CATEGORY_WRONG_CUSTOMER)
//   - when the category has been explicitly classified (sales_flow IS NOT NULL),
//     it still matches the item's freshly-derived sales_flow — a mismatch here is
//     Hidden Risk 2: products.inventory_mode was changed after the category was
//     set up (e.g. CARCASS_PART -> TRACK_STOCK), so a category that used to fit
//     no longer does. NULL category.sales_flow (every pre-existing category today)
//     skips this check entirely — backward compatible, never rejected solely for
//     being unclassified.
//
// Items with no price_book_id (NULL category — Hidden Risk 1) are allowed and
// excluded from the per-flow category count only when their resolved price_type
// proves the price came from an unambiguous non-category source (legacy private
// price, product default, or an explicit manual override). Any other combination
// (e.g. price_type claims PRICE_BOOK but price_book_id is somehow null) is
// rejected with a clear Vietnamese business error — never a crash.
//
// seedFlowCategorySets lets addItem() pre-populate the categories already
// committed on this order (from its existing order_items rows) so a second item
// can't smuggle in a second category for a flow that's already locked in.
const NULL_CATEGORY_UNAMBIGUOUS_PRICE_TYPES = new Set(['PRIVATE_PRICE', 'COMMON_PRICE', 'MANUAL_PRICE']);
async function assertItemsCategoryPerFlow(conn, customerId, items, itemFlowByProductId, seedFlowCategorySets) {
  const categoryByProductId = new Map();
  const flowCategorySets = {
    CARCASS_POS: new Set(seedFlowCategorySets?.CARCASS_POS || []),
    INVENTORY_SALE: new Set(seedFlowCategorySets?.INVENTORY_SALE || []),
  };

  for (const it of items || []) {
    const pid = Number(it.product_id);
    const flow = itemFlowByProductId.get(pid);
    if (!flow) continue; // unresolved product_id — surfaced elsewhere (price resolution / "not found")
    const label = it.product_name || `ID ${pid}`;

    if (it.price_book_id) {
      const [[book]] = await conn.query(
        `SELECT id, customer_id, customer_price_category_id FROM customer_price_books WHERE id=? LIMIT 1`,
        [it.price_book_id]
      );
      if (!book) throw businessError(`Bảng giá không hợp lệ cho mặt hàng "${label}".`, 'PRICE_BOOK_NOT_FOUND');
      if (Number(book.customer_id) !== Number(customerId)) {
        throw businessError(`Bảng giá của mặt hàng "${label}" không thuộc khách hàng này.`, 'PRICE_BOOK_WRONG_CUSTOMER');
      }
      const [[lineItem]] = await conn.query(
        `SELECT id FROM customer_price_book_items WHERE price_book_id=? AND product_id=? LIMIT 1`,
        [it.price_book_id, pid]
      );
      if (!lineItem) throw businessError(`Mặt hàng "${label}" không có trong bảng giá đã chọn.`, 'PRODUCT_NOT_IN_PRICE_BOOK');

      let categoryId = book.customer_price_category_id ? Number(book.customer_price_category_id) : null;
      if (categoryId) {
        const [[cat]] = await conn.query(
          `SELECT id, customer_id, sales_flow FROM customer_price_categories WHERE id=? LIMIT 1`,
          [categoryId]
        );
        if (!cat || Number(cat.customer_id) !== Number(customerId)) {
          throw businessError(`Danh mục giá của mặt hàng "${label}" không thuộc khách hàng này.`, 'PRICE_CATEGORY_WRONG_CUSTOMER');
        }
        // Phase 1B Gate Fix: NULL is its own logical state (LEGACY/UNKNOWN), never an
        // implicit CARCASS_POS. CARCASS_POS keeps the pre-existing legacy-compat
        // allowance (a NULL/unclassified category is accepted for it, unchanged).
        // INVENTORY_SALE gets no such allowance — it may resolve ONLY through a
        // category explicitly classified INVENTORY_SALE. The prior
        // `cat.sales_flow && cat.sales_flow !== flow` check silently passed whenever
        // cat.sales_flow was NULL (falsy short-circuit), regardless of flow — that
        // was the bypass: an INVENTORY_SALE item could resolve price through any
        // unclassified Legacy category. Closed here without touching the CARCASS_POS
        // branch's existing behavior or wording.
        if (flow === 'INVENTORY_SALE') {
          if (!cat.sales_flow) {
            throw businessError('Danh mục giá chưa được phân loại cho bán hàng kho.', 'PRICE_CATEGORY_NOT_CLASSIFIED_FOR_INVENTORY_SALE');
          }
          if (cat.sales_flow !== 'INVENTORY_SALE') {
            throw businessError('Danh mục giá không thuộc phân hệ bán hàng kho.', 'PRICE_CATEGORY_NOT_INVENTORY_SALE');
          }
        } else if (cat.sales_flow && cat.sales_flow !== flow) {
          throw businessError(
            `Sản phẩm '${label}' đã thay đổi tính chất kho và không còn phù hợp với danh mục giá này.`,
            'PRICE_CATEGORY_SALES_FLOW_MISMATCH'
          );
        }
        const flowSet = flowCategorySets[flow];
        if (flowSet && flowSet.size >= 1 && !flowSet.has(categoryId)) {
          throw businessError(
            flow === 'CARCASS_POS'
              ? 'Bill chỉ được dùng 1 danh mục giá Bò Xô. Đang phát hiện nhiều danh mục giá khác nhau.'
              : 'Bill chỉ được dùng 1 danh mục giá Bán hàng kho. Đang phát hiện nhiều danh mục giá khác nhau.',
            'MULTIPLE_PRICE_CATEGORIES_PER_FLOW'
          );
        }
        if (flowSet) flowSet.add(categoryId);
      }
      categoryByProductId.set(pid, categoryId);
    } else {
      // Same default create()/addItem() already apply at INSERT time (it.price_type
      // || 'MANUAL_PRICE') — an explicit manual entry with no price_type field sent
      // at all is exactly as unambiguous as one that spells out 'MANUAL_PRICE'.
      const effectivePriceType = it.price_type || 'MANUAL_PRICE';
      if (!NULL_CATEGORY_UNAMBIGUOUS_PRICE_TYPES.has(effectivePriceType)) {
        throw businessError(
          `Không xác định được nguồn giá cho mặt hàng "${label}". Vui lòng kiểm tra lại bảng giá hoặc nhập giá thủ công.`,
          'AMBIGUOUS_PRICE_SOURCE'
        );
      }
      categoryByProductId.set(pid, null);
    }
  }

  return { categoryByProductId };
}

function solarDateParts(dateText){
  const m=String(dateText||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(m)return {day:Number(m[3]),month:Number(m[2]),year:Number(m[1])};
  const d=dateText?new Date(dateText):new Date();
  return {day:d.getDate(),month:d.getMonth()+1,year:d.getFullYear()};
}

async function monthlyInstallmentForOrder(order){
  const calendarType=String(order.calendar_type||'SOLAR').toUpperCase()==='LUNAR'?'LUNAR':'SOLAR';
  let period;
  if(calendarType==='LUNAR') period=parseLunarDateParts(order.lunar_date_text)||solarDateParts(order.order_date);
  else period=solarDateParts(order.order_date);
  const row=await DebtMonthlyInstallmentAgent.getActiveInstallment(order.customer_id,period.month,period.year,calendarType,period.day);
  return {...row, bill_day:period.day, installment_month:period.month, installment_year:period.year, calendar_type:calendarType};
}

class OrderAgent {
  constructor(){this.version='65.55.0';this.responsibility='Order POS blocks future shipping dates and uses shipping-date effective price book';}

  async ensureOrderEditable(conn, orderId) {
    const [rows] = await conn.query(`SELECT id,status,is_locked,locked_at,payment_status,customer_id FROM orders WHERE id=? FOR UPDATE`, [orderId]);
    if (!rows.length) throw new Error('Không tìm thấy bill');
    const o = rows[0];
    if (String(o.status || '').toUpperCase() === 'CANCELLED') throw new Error('Bill đã hủy, không thể sửa');
    if (Number(o.is_locked || 0) === 1 || o.locked_at) throw new Error('Bill đã chốt sổ, không thể sửa');
    const [allocs] = await conn.query(`SELECT COUNT(*) cnt FROM payment_allocations WHERE order_id=?`, [orderId]).catch(async e => { if (e && (e.code==='ER_NO_SUCH_TABLE'||e.errno===1146)) return [[{cnt:0}]]; throw e; });
    if (Number(allocs[0]?.cnt || 0) > 0) throw new Error('Bill đã có thu tiền/phân bổ, không thể sửa hàng. Hãy điều chỉnh bằng phiếu khác.');
    return o;
  }

  async lock(orderId, data={}, user={}) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query(`SELECT id,status,is_locked,locked_at FROM orders WHERE id=? FOR UPDATE`, [orderId]);
      if (!rows.length) throw new Error('Không tìm thấy bill');
      if (String(rows[0].status || '').toUpperCase() === 'CANCELLED') throw new Error('Bill đã hủy, không thể chốt');
      try {
        await conn.query(`UPDATE orders SET is_locked=1, locked_at=NOW(), locked_by=?, lock_note=? WHERE id=?`, [user?.id || null, data.note || data.lock_note || null, orderId]);
      } catch(e) {
        if (e && (e.code==='ER_BAD_FIELD_ERROR'||e.errno===1054)) throw new Error('Chưa chạy migration khóa bill V65.47');
        throw e;
      }
      await conn.commit();
      return {message:'Đã chốt sổ bill', order_id:Number(orderId)};
    } catch(e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }

  // S8.2 Order Cancel + Reversal.
  //
  // Never delete: cancellation is status-change + append-only compensating
  // ledger events (debt_transactions, stock_transactions), matching the ledger
  // contracts already established for debt (S8.1A) and inventory (INV-004/S5.2-C).
  // orders / order_items rows are never touched beyond flipping status and the
  // dedicated cancel_* audit columns — the bill remains a historical document
  // (original quantity/price/total/price_book/inventory_mode/stock_checked
  // untouched, total_amount untouched).
  //
  // Concurrency: SELECT ... FOR UPDATE on the orders row is the single
  // concurrency guard, same proven idiom as lock()/ensureOrderEditable()/
  // PaymentAgent.revertPaymentEffects() elsewhere in this codebase — the
  // status check happens only after the row lock is held, inside this
  // transaction, so a second concurrent cancel() call blocks until the first
  // commits, then re-reads status='CANCELLED' fresh and is rejected. This also
  // makes a retried/duplicate client request (e.g. after a timeout) safe: if
  // the first attempt already committed, the retry sees CANCELLED and is
  // rejected — no second reversal is ever posted.
  async cancel(orderId, data = {}, user = {}) {
    const reason = String(data.reason || data.cancel_reason || '').trim();
    if (!reason) throw Object.assign(new Error('Vui lòng nhập lý do hủy bill'), { status: 400 });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query(
        `SELECT id,status,is_locked,locked_at,customer_id,order_code,paid_amount
         FROM orders WHERE id=? FOR UPDATE`,
        [orderId]
      );
      if (!rows.length) throw Object.assign(new Error('Không tìm thấy bill'), { status: 404 });
      const o = rows[0];

      if (String(o.status || '').toUpperCase() === 'CANCELLED')
        throw Object.assign(new Error('Bill đã hủy, không thể hủy lại'), { status: 400 });
      if (Number(o.is_locked || 0) === 1 || o.locked_at)
        throw Object.assign(new Error('Bill đã chốt sổ, không thể hủy'), { status: 400 });

      await assertCustomerScope(user, o.customer_id);

      // Guard: payment_allocations — any bill this receipt was actually applied to.
      const [allocs] = await conn.query(
        `SELECT COUNT(*) cnt FROM payment_allocations WHERE order_id=?`, [orderId]
      ).catch(async e => { if (e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146)) return [[{ cnt: 0 }]]; throw e; });
      if (Number(allocs[0]?.cnt || 0) > 0)
        throw Object.assign(new Error('Bill đã có thu tiền/phân bổ, không thể hủy. Vui lòng hủy phiếu thu liên quan trước.'), { status: 400 });

      // Guard: legacy direct payments (payments.order_id, pre-payment_allocations bills).
      let directPayCount = 0;
      try {
        const [r] = await conn.query(
          `SELECT COUNT(*) cnt FROM payments WHERE order_id=? AND COALESCE(status,'ACTIVE')<>'CANCELLED'`, [orderId]
        );
        directPayCount = Number(r[0]?.cnt || 0);
      } catch (e) {
        if (!(e && (e.code === 'ER_BAD_FIELD_ERROR' || e.errno === 1054))) throw e;
        const [r] = await conn.query(`SELECT COUNT(*) cnt FROM payments WHERE order_id=?`, [orderId]);
        directPayCount = Number(r[0]?.cnt || 0);
      }
      if (directPayCount > 0)
        throw Object.assign(new Error('Bill đã có phiếu thu áp dụng, không thể hủy. Vui lòng hủy phiếu thu liên quan trước.'), { status: 400 });

      // Guard: any money already recorded against this bill, regardless of path.
      if (Number(o.paid_amount || 0) > 0)
        throw Object.assign(new Error('Bill đã ghi nhận tiền đã thu, không thể hủy.'), { status: 400 });

      // Debt reversal — append-only compensation, never rewrite the original SALE row.
      await this._reverseOrderDebt(conn, orderId, o.customer_id, user?.id || null);

      // Inventory reversal — through the single-writer boundary (InventoryService),
      // decided from order_items' frozen historical facts, not the product's
      // current config. Bò Xô / NON_STOCK lines post no row (see method doc).
      await InventoryService.reverseOrderInventory(
        conn, orderId, user?.id || null,
        `Hoàn tồn kho do hủy bill ${o.order_code}: ${reason}`
      );

      await conn.query(
        `UPDATE orders SET status='CANCELLED', debt_amount=0, cancelled_at=NOW(), cancelled_by=?, cancel_reason=? WHERE id=?`,
        [user?.id || null, reason, orderId]
      );

      await conn.commit();
      return { message: 'Đã hủy bill', order_id: Number(orderId), order_code: o.order_code };
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }

  // S8.2: mirrors PaymentAgent.reverseDebtLedgerForPayment (S8.1A) exactly —
  // never DELETE/UPDATE a posted debt_transactions row; net the order's current
  // signed ledger contribution to zero with one compensating row, computed from
  // a fresh SUM (not assumed to be a single SALE row) so it stays correct
  // whichever ADJUSTMENT_INCREASE/DECREASE delta rows Add Item/Edit Item (S8.1)
  // may have appended since creation. The guards in cancel() above already
  // guarantee no PAYMENT row exists for this order_id before this runs, so net
  // is always >=0 in practice — computed generically anyway, matching the
  // S8.1A precedent, rather than hardcoded to a single direction.
  async _reverseOrderDebt(conn, orderId, customerId, userId) {
    const [[row]] = await conn.query(
      `SELECT COALESCE(SUM(CASE
          WHEN type IN ('SALE','ADJUSTMENT_INCREASE') THEN amount
          WHEN type IN ('PAYMENT','ADJUSTMENT_DECREASE') THEN -amount
          ELSE 0 END),0) net_effect
       FROM debt_transactions WHERE order_id=?`,
      [orderId]
    );
    const net = Number(row.net_effect || 0);
    if (Math.abs(net) < 0.01) return 0;
    const reverseType = net < 0 ? 'ADJUSTMENT_INCREASE' : 'ADJUSTMENT_DECREASE';
    await conn.query(
      `INSERT INTO debt_transactions(customer_id,order_id,transaction_date,type,amount,note,created_by)
       VALUES(?,?,?,?,?,?,?)`,
      [customerId, orderId, new Date().toISOString().slice(0, 10), reverseType, Math.abs(net), `Đảo bút toán công nợ do hủy bill #${orderId}`, userId || null]
    );
    return net;
  }

  async loadLegacyDirectPayments(orderId) {
    const [rows] = await pool.query(
      `SELECT p.id payment_id, p.order_id, p.amount allocated_amount, 'LEGACY_DIRECT_PAYMENT' allocation_type,
              p.payment_code, p.payment_date, p.payment_method, p.cash_amount, p.bank_amount, p.amount payment_amount, p.note
       FROM payments p WHERE p.order_id=?
       ORDER BY p.payment_date ASC, p.id ASC`,
      [orderId]
    );
    return rows;
  }

  async loadOrderPaymentAllocations(orderId) {
    // V65.34: payment history must be shown per bill allocation, not by the payment row order_id only.
    // This keeps old debt payments understandable: money used to clear an older bill is printed on that old bill.
    try {
      try {
        const [rows] = await pool.query(
          `SELECT pa.id allocation_id, pa.payment_id, pa.order_id, pa.amount allocated_amount,
                  COALESCE(pa.cash_amount,0) allocation_cash_amount,
                  COALESCE(pa.bank_amount,0) allocation_bank_amount,
                  pa.allocation_type,
                  p.payment_code, p.payment_date, p.payment_method, p.cash_amount, p.bank_amount, p.amount payment_amount, p.note
           FROM payment_allocations pa
           JOIN payments p ON p.id=pa.payment_id
           WHERE pa.order_id=?
           ORDER BY p.payment_date ASC, p.id ASC, pa.id ASC`,
          [orderId]
        );
        if (rows.length) return rows;
        // V65.44: if allocation table exists but this bill was paid before allocation rows were introduced,
        // print the direct payment rows instead of showing an empty payment history.
        return await this.loadLegacyDirectPayments(orderId);
      } catch (e2) {
        if (!(e2 && (e2.code === 'ER_BAD_FIELD_ERROR' || e2.errno === 1054))) throw e2;
        const [rows] = await pool.query(
          `SELECT pa.id allocation_id, pa.payment_id, pa.order_id, pa.amount allocated_amount,
                  0 allocation_cash_amount, 0 allocation_bank_amount,
                  pa.allocation_type,
                  p.payment_code, p.payment_date, p.payment_method, p.cash_amount, p.bank_amount, p.amount payment_amount, p.note
           FROM payment_allocations pa
           JOIN payments p ON p.id=pa.payment_id
           WHERE pa.order_id=?
           ORDER BY p.payment_date ASC, p.id ASC, pa.id ASC`,
          [orderId]
        );
        if (rows.length) return rows;
        return await this.loadLegacyDirectPayments(orderId);
      }
    } catch (e) {
      if (!(e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146))) throw e;
return await this.loadLegacyDirectPayments(orderId);
    }
  }

  async list(user, query={}) {
    const where=[], params=[];
    if (user.role==='CUSTOMER') {
      const scope=await customerScopeWhere(user,'o.customer_id');
      where.push(scope.clause); params.push(...scope.params);
    }
    if (query.from_date || query.from) { where.push('DATE(o.order_date)>=?'); params.push(String(query.from_date||query.from).slice(0,10)); }
    if (query.to_date || query.to) { where.push('DATE(o.order_date)<=?'); params.push(String(query.to_date||query.to).slice(0,10)); }
    if (query.customer_name || query.customer) { where.push('c.name LIKE ?'); params.push('%'+String(query.customer_name||query.customer).trim()+'%'); }
    const [rows] = await pool.query(
      `SELECT o.*,c.name customer_name FROM orders o JOIN customers c ON c.id=o.customer_id
       ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY o.order_date DESC,o.id DESC`,
      params
    );
    return rows;
  }

  async get(id,user) {
    const [orders] = await pool.query(
      `SELECT o.*,c.name customer_name,c.phone,c.address FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.id=?`,
      [id]
    );
    if (!orders.length) throw new Error('Không tìm thấy bill');
    const order = orders[0];
    await assertCustomerScope(user, order.customer_id);
    const [items] = await pool.query(`SELECT * FROM order_items WHERE order_id=? ORDER BY id`, [id]);
    const [oldDebts] = await pool.query(
      `SELECT id,order_code,order_date,total_amount,paid_amount,debt_amount,calendar_type,lunar_date_text
       FROM orders
       WHERE customer_id=? AND status<>'CANCELLED' AND debt_amount>0
         AND (order_date < ? OR (order_date = ? AND id < ?))
       ORDER BY order_date ASC,id ASC`,
      [order.customer_id, order.order_date, order.order_date, order.id]
    );
    const [payRows]=await pool.query(`SELECT * FROM payments WHERE order_id=? ORDER BY id DESC LIMIT 1`,[id]);
    let monthly_installment=await monthlyInstallmentForOrder(order);
    if(payRows[0]?.monthly_installment_id){
      try{
        const [used]=await pool.query(`SELECT * FROM debt_monthly_installments WHERE id=? LIMIT 1`,[payRows[0].monthly_installment_id]);
        if(used[0]) monthly_installment=used[0];
      }catch(e){}
    }
    const payment_allocations = await this.loadOrderPaymentAllocations(order.id);
    const allocation_paid_total = payment_allocations.reduce((sum,x)=>sum+Number(x.allocated_amount||0),0);
    const payment_summary = { allocated_paid_total: allocation_paid_total, remaining_debt: Math.max(0, Number(order.total_amount||0)-allocation_paid_total) };
    return {...order, items, old_debts:oldDebts, old_debt_total:oldDebts.reduce((s,x)=>s+Number(x.debt_amount||0),0), monthly_installment, payment:payRows[0]||null, payment_allocations, payment_summary};
  }

  async getByToken(token) {
    const [orders] = await pool.query(
      `SELECT o.*,c.name customer_name,c.phone,c.address FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.private_token=? LIMIT 1`,
      [token]
    );
    if (!orders.length) throw new Error('Không tìm thấy bill');
    const order = orders[0];
    const [items] = await pool.query(`SELECT * FROM order_items WHERE order_id=? ORDER BY id`, [order.id]);
    const [oldDebts] = await pool.query(
      `SELECT id,order_code,order_date,total_amount,paid_amount,debt_amount,calendar_type,lunar_date_text
       FROM orders
       WHERE customer_id=? AND status<>'CANCELLED' AND debt_amount>0
         AND (order_date < ? OR (order_date = ? AND id < ?))
       ORDER BY order_date ASC,id ASC`,
      [order.customer_id, order.order_date, order.order_date, order.id]
    );
    const [payRows]=await pool.query(`SELECT * FROM payments WHERE order_id=? ORDER BY id DESC LIMIT 1`,[order.id]);
    let monthly_installment=await monthlyInstallmentForOrder(order);
    if(payRows[0]?.monthly_installment_id){
      try{
        const [used]=await pool.query(`SELECT * FROM debt_monthly_installments WHERE id=? LIMIT 1`,[payRows[0].monthly_installment_id]);
        if(used[0]) monthly_installment=used[0];
      }catch(e){}
    }
    const payment_allocations = await this.loadOrderPaymentAllocations(order.id);
    const allocation_paid_total = payment_allocations.reduce((sum,x)=>sum+Number(x.allocated_amount||0),0);
    const payment_summary = { allocated_paid_total: allocation_paid_total, remaining_debt: Math.max(0, Number(order.total_amount||0)-allocation_paid_total) };
    return {...order, items, old_debts:oldDebts, old_debt_total:oldDebts.reduce((s,x)=>s+Number(x.debt_amount||0),0), monthly_installment, payment:payRows[0]||null, payment_allocations, payment_summary};
  }

  async create(data, user) {
    if (!data.items || !data.items.length) throw new Error('Bill phải có ít nhất 1 mặt hàng');
    // F3: quantity must be > 0 — rejects 0, negative, and null/undefined (Number(null||undefined)
    // is 0/NaN, both fail the `> 0` check) before any price resolution or inventory write.
    for (const it of data.items) {
      if (!(Number(it.quantity) > 0)) {
        throw new Error(`Số lượng "${it.product_name || ('ID ' + it.product_id)}" phải lớn hơn 0`);
      }
    }
    await assertCustomerScope(user, data.customer_id);

    // S6.5: idempotency fast path. Optimistic, outside any transaction — the real
    // guarantee is the UNIQUE constraint + catch around the INSERT below. This
    // just skips repeating all the expensive work (price resolution, category
    // checks) for the common case of an obvious replay (e.g. the UI didn't
    // visibly update in time and the user clicked "Lưu bill" again).
    if (data.idempotency_key) {
      const [[existing]] = await pool.query(
        `SELECT id, order_code FROM orders WHERE idempotency_key = ? LIMIT 1`,
        [data.idempotency_key]
      );
      if (existing) return { message: 'Đã tạo bill', order_id: existing.id, order_code: existing.order_code };
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const { itemFlowByProductId, orderSalesFlow } = await deriveItemsSalesFlow(conn, data.items);
      const code = await nextCode(conn,'orders','order_code','BILL');
      const safeCalendarType=data.calendar_type==='LUNAR'?'LUNAR':'SOLAR';
      const safeLunarDateText=safeCalendarType==='LUNAR'?(data.lunar_date_text||''):'';
      const billSolarDate=resolveBillSolarDate(safeCalendarType,data.order_date,safeLunarDateText);
      const todayIso = new Date(Date.now()+7*60*60*1000).toISOString().slice(0,10);
      if (String(billSolarDate||'').slice(0,10) > todayIso) {
        const err = new Error('Không thể tạo bill có ngày xuất hàng lớn hơn ngày hiện tại');
        err.statusCode = 400;
        err.code = 'FUTURE_BILL_DATE';
        err.details = { calendar_type: safeCalendarType, order_date: billSolarDate, lunar_date_text: safeLunarDateText, today: todayIso };
        throw err;
      }

      // V65.52 critical fix:
      // POS manual entry and Excel import must both use the price book effective at the bill shipping date.
      // Do NOT trust the sale_price already present in frontend items because it may come from the newest
      // customer catalog load, while Excel/bill date may be older (e.g. 08/01 AL must not use 01/02 AL price).
      const missingPriceProductIds = [];
      for (const it of data.items) {
        if (!it.product_id) continue;
        const isExplicitManual = it.manual_price === true || it.force_manual_price === true;
        if (!isExplicitManual) {
          const price = await PriceBookService.getEffectivePrice(data.customer_id, it.product_id, billSolarDate, conn, safeCalendarType, safeLunarDateText);
          if (!price || Number(price.sale_price)<=0) {
            missingPriceProductIds.push(it.product_id);
            continue;
          }
          it.sale_price = price.sale_price;
          it.price_type = price.price_type;
          it.price_book_id = price.price_book_id || null;
        } else if (!it.sale_price || Number(it.sale_price)<=0) {
          missingPriceProductIds.push(it.product_id);
        }
      }
      if (missingPriceProductIds.length) throw await buildMissingPriceError(conn, data.customer_id, billSolarDate, missingPriceProductIds);

      // Mixed Sales Phase 1B: dual price category / price isolation per sales_flow,
      // validated only after every item's price_book_id/price_type is server-resolved
      // above — this check depends on those resolved values, not raw frontend input.
      const { categoryByProductId } = await assertItemsCategoryPerFlow(conn, data.customer_id, data.items, itemFlowByProductId, null);

      const itemTotal = data.items.reduce((s,it)=>s+Number(it.quantity||0)*Number(it.sale_price||0),0);
      // V6.51 critical fix: order total must include the effective daily installment.
      // Otherwise a bill paid only for today's items is incorrectly marked PAID and the installment debt disappears.
      const installmentAmount = Number(data.monthly_installment_amount ?? data.installment_amount ?? 0);
      const total = itemTotal + installmentAmount;
      const paid = 0; // V65.47: Bill không xử lý tiền. Tiền chỉ ghi ở menu Thu tiền.
      const debt = Math.max(0,total-paid);
      const pstatus = paid<=0?'UNPAID':paid>=total?'PAID':'PARTIAL';
      let r;
      try {
        [r] = await conn.query(
          `INSERT INTO orders(order_code,customer_id,order_date,delivery_date,status,payment_status,total_amount,paid_amount,debt_amount,private_token,note,created_by,idempotency_key,sales_flow)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [code,data.customer_id,billSolarDate,data.delivery_date||null,'DELIVERED',pstatus,total,paid,debt,nanoid(24),data.note||'',user.id,data.idempotency_key||null,orderSalesFlow]
        );
      } catch (e) {
        // S6.5: a genuine concurrent duplicate (same idempotency_key, two requests
        // racing) hits the UNIQUE constraint here — the loser rolls back and returns
        // the winner's order instead of erroring or creating a second bill. Same
        // proven pattern as stock_transactions.receive_dedup_key.
        //
        // Deliberately not narrowed to "only if the error mentions idempotency":
        // nextCode() (order_code generation, a separate pre-existing utility, not
        // touched here) has its own unrelated read-then-increment race, so a
        // genuine concurrent idempotency_key collision can sometimes surface as an
        // order_code duplicate instead, depending on which unique index MySQL
        // reports first. Any duplicate-key error is treated as "maybe this was our
        // own race" — if an order with this exact idempotency_key exists after
        // rolling back, return it; if not, this duplicate was for an unrelated
        // reason and the original error is rethrown unchanged.
        const isDupKey = e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062);
        if (data.idempotency_key && isDupKey) {
          await conn.rollback();
          const [[existing]] = await pool.query(`SELECT id, order_code FROM orders WHERE idempotency_key = ? LIMIT 1`, [data.idempotency_key]);
          if (existing) return { message: 'Đã tạo bill', order_id: existing.id, order_code: existing.order_code };
        }
        throw e;
      }

const orderId = r.insertId;
    // V6.51: persist bill calendar and installment fields so POS, payment, print, and reports use the same values.
    try{
      const monthlyInstallmentId=Number(data.monthly_installment_id||0)||null;
      await conn.query(
        `UPDATE orders SET calendar_type=?, lunar_date_text=?, current_bill_amount=?, installment_amount=?, monthly_installment_id=? WHERE id=?`,
        [safeCalendarType,safeLunarDateText,itemTotal,installmentAmount,monthlyInstallmentId,orderId]
      );
    }catch(e){
      // Ignore if DB has not migrated optional V6.51 columns yet.
    }
      for (const it of data.items) {
        const line = Number(it.quantity||0)*Number(it.sale_price||0);
        const inv = await InventoryService.out(conn,it.product_id,it.quantity,billSolarDate,'SALE',orderId,`Xuất bill ${code}`,user.id);
        // Mixed Sales Phase 1A/1B: per-item sales_flow and customer_price_category_id,
        // computed by deriveItemsSalesFlow()/assertItemsCategoryPerFlow() above from
        // freshly-read DB facts — never from the request body.
        const itemSalesFlow = itemFlowByProductId.get(Number(it.product_id)) || null;
        const itemCategoryId = categoryByProductId.has(Number(it.product_id)) ? categoryByProductId.get(Number(it.product_id)) : null;
        try {
          await conn.query(
            `INSERT INTO order_items(order_id,product_id,product_name,unit,quantity,sale_price,total_price,price_type,price_book_id,note,inventory_mode,stock_checked,sales_flow,customer_price_category_id)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [orderId,it.product_id,it.product_name,it.unit||'kg',it.quantity,it.sale_price,line,it.price_type||'MANUAL_PRICE',it.price_book_id||null,it.note||null,inv.inventory_mode,inv.stock_checked?1:0,itemSalesFlow,itemCategoryId]
          );
        } catch (e) {
          // Backward compatibility if production DB has not run V65.44.1 migration yet.
          const safePriceType = (it.price_type === 'PRICE_BOOK') ? 'PRIVATE_PRICE' : (it.price_type || 'MANUAL_PRICE');
          await conn.query(
            `INSERT INTO order_items(order_id,product_id,product_name,unit,quantity,sale_price,total_price,price_type,note,inventory_mode,stock_checked)
             VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
            [orderId,it.product_id,it.product_name,it.unit||'kg',it.quantity,it.sale_price,line,safePriceType,it.note||null,inv.inventory_mode,inv.stock_checked?1:0]
          );
        }
      }
      if (debt > 0) {
        await conn.query(
          `INSERT INTO debt_transactions(customer_id,order_id,transaction_date,type,amount,note,created_by)
           VALUES(?,?,?,'SALE',?,?,?)`,
          [data.customer_id,orderId,billSolarDate,debt,`Công nợ bill ${code}`,user.id]
        );
      }

      // V65.38: if customer had unused paid money from older receipts, apply it automatically
      // to this newly-created bill by Ngày xuất hàng order. This prevents tiền dư from
      // becoming unmanaged when the next bill is created after the receipt was recorded.
      try {
        const PaymentAgent = require('./PaymentAgent');
        await PaymentAgent.allocateExistingCreditsToOpenBills(conn, data.customer_id, user.id);
      } catch (e) {
        // Do not block bill creation if the optional credit table has not been migrated yet.
        if (!(e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146))) throw e;
      }

      await conn.commit();
      return {message:'Đã tạo bill', order_id:orderId, order_code:code};
    } catch(e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }


  // S8.1: userId is only used to attribute the debt_transactions delta row
  // below (created_by) — recalculation itself is unaffected by who triggered it.
  async recalcOrderTotals(conn, orderId, userId = null) {
    const [sumRows] = await conn.query(`SELECT COALESCE(SUM(total_price),0) total FROM order_items WHERE order_id=?`, [orderId]);
    const itemTotal = Number(sumRows[0].total || 0);
    const [orderRows] = await conn.query(
      `SELECT customer_id, order_code, order_date, paid_amount, installment_amount, debt_amount
       FROM orders WHERE id=? FOR UPDATE`,
      [orderId]
    );
    const o = orderRows[0] || {};
    const paid = Number(o.paid_amount || 0);
    const installmentAmount = Number(o.installment_amount || 0);
    const oldDebt = Number(o.debt_amount || 0);
    const total = itemTotal + installmentAmount;
    const debt = Math.max(0, total - paid);
    const status = paid <= 0 ? 'UNPAID' : paid >= total ? 'PAID' : 'PARTIAL';
    await conn.query(
      `UPDATE orders SET current_bill_amount=?, total_amount=?, debt_amount=?, payment_status=? WHERE id=?`,
      [itemTotal, total, debt, status, orderId]
    );

    // S8.1 debt sync: debt_transactions is an immutable append-only ledger
    // (type ENUM mirrors stock_transactions' IN/OUT/ADJUSTMENT_INCREASE/
    // DECREASE design, and PaymentAgent already posts ADJUSTMENT_INCREASE
    // rows for installment top-ups) — never rewrite the original SALE row.
    // Add Item / Edit Item must post a delta row here so SUM(amount) keeps
    // matching orders.debt_amount, the same way InventoryMovementService
    // posts a delta row for every inventory-affecting edit.
    const delta = debt - oldDebt;
    if (Math.abs(delta) >= 0.01 && o.customer_id) {
      const adjType = delta > 0 ? 'ADJUSTMENT_INCREASE' : 'ADJUSTMENT_DECREASE';
      await conn.query(
        `INSERT INTO debt_transactions(customer_id,order_id,transaction_date,type,amount,note,created_by)
         VALUES(?,?,?,?,?,?,?)`,
        [o.customer_id, orderId, o.order_date, adjType, Math.abs(delta), `Điều chỉnh công nợ theo thay đổi dòng hàng bill ${o.order_code} (trước: ${oldDebt}, sau: ${debt})`, userId || null]
      );
    }

    return { item_total:itemTotal, total_amount:total, debt_amount:debt, payment_status:status };
  }

  async resolveAddItemProduct(conn, order, data) {
    const productId = Number(data.product_id || 0);
    if (productId > 0) {
      const [rows] = await conn.query(
        `SELECT p.id product_id,p.name product_name,p.unit,p.default_sale_price,p.inventory_mode,p.allow_negative_stock,
                COALESCE(cpp.sale_price,p.default_sale_price,0) sale_price,
                CASE WHEN cpp.sale_price IS NOT NULL THEN 'PRIVATE_PRICE' ELSE 'COMMON_PRICE' END price_type
         FROM products p
         LEFT JOIN customer_product_prices cpp ON cpp.product_id=p.id AND cpp.customer_id=? AND cpp.is_active=1
         WHERE p.id=? AND p.del_flg=0 AND p.is_active=1 LIMIT 1`,
        [order.customer_id, productId]
      );
      if(!rows.length) throw new Error('Không tìm thấy mặt hàng đã chọn');
      const price = await PriceBookService.getEffectivePrice(order.customer_id, productId, order.order_date, conn, order.calendar_type, order.lunar_date_text);
      if(price){ rows[0].sale_price=price.sale_price; rows[0].price_type=price.price_type; rows[0].price_book_id=price.price_book_id || null; }
      return rows[0];
    }

    const name = String(data.product_name || data.name || '').trim();
    if(!name) throw new Error('Thiếu tên mặt hàng cần thêm');

    const [exists] = await conn.query(
      `SELECT p.id product_id,p.name product_name,p.unit,p.default_sale_price,p.inventory_mode,p.allow_negative_stock,
              COALESCE(cpp.sale_price,p.default_sale_price,0) sale_price,
              CASE WHEN cpp.sale_price IS NOT NULL THEN 'PRIVATE_PRICE' ELSE 'COMMON_PRICE' END price_type
       FROM products p
       LEFT JOIN customer_product_prices cpp ON cpp.product_id=p.id AND cpp.customer_id=? AND cpp.is_active=1
       WHERE p.del_flg=0 AND p.is_active=1 AND LOWER(TRIM(p.name))=LOWER(TRIM(?)) LIMIT 1`,
      [order.customer_id, name]
    );
    if(exists.length) {
      const price = await PriceBookService.getEffectivePrice(order.customer_id, exists[0].product_id, order.order_date, conn, order.calendar_type, order.lunar_date_text);
      if(price){ exists[0].sale_price=price.sale_price; exists[0].price_type=price.price_type; exists[0].price_book_id=price.price_book_id || null; }
      return exists[0];
    }

    const salePrice = Number(data.sale_price || data.price || 0);
    if(!(salePrice > 0)) throw new Error('Mặt hàng mới cần nhập giá bán');
    const code = 'QK' + Date.now().toString().slice(-10);
    const unit = data.unit || 'kg';
    const [r] = await conn.query(
      `INSERT INTO products(category_id,product_code,name,unit,default_sale_price,default_purchase_price,stock_quantity,low_stock_threshold,note,is_active,del_flg,inventory_mode,allow_negative_stock)
       VALUES(NULL,?,?,?,?,0,0,5,'Tạo nhanh từ sửa bill',1,0,?,1)`,
      [code, name, unit, salePrice, data.inventory_mode || 'CARCASS_PART']
    );
    const newId = r.insertId;
    try{
      await conn.query(
        `INSERT INTO customer_product_catalogs(customer_id,product_id,sort_order,is_default,is_active,del_flg)
         VALUES(?,?,999,1,1,0)
         ON DUPLICATE KEY UPDATE is_default=1,is_active=1,del_flg=0`,
        [order.customer_id, newId]
      );
      await conn.query(
        `INSERT INTO customer_product_prices(customer_id,product_id,sale_price,effective_from,is_active)
         VALUES(?,?,?,CURDATE(),1)`,
        [order.customer_id, newId, salePrice]
      );
    }catch(e){}
    return {product_id:newId, product_name:name, unit, sale_price:salePrice, price_type:'MANUAL_PRICE', inventory_mode:data.inventory_mode || 'CARCASS_PART', allow_negative_stock:1};
  }

  // Mixed Sales Phase 1B Task 7: applies the same shared derive/validate resolver
  // create() uses — deriveItemsSalesFlow() + assertItemsCategoryPerFlow() — to a
  // single new item, seeded with the categories already committed on this order's
  // existing lines (so a second Add Item can't smuggle in a second category for a
  // flow that's already locked in). Recomputes the order header's sales_flow
  // afterward from the full, now-updated item set.
  async recomputeOrderSalesFlow(conn, orderId) {
    const [rows] = await conn.query(
      `SELECT DISTINCT sales_flow FROM order_items WHERE order_id=? AND sales_flow IS NOT NULL`,
      [orderId]
    );
    const flows = rows.map(r => r.sales_flow);
    const headerFlow = flows.length === 0 ? null : (flows.length === 1 ? flows[0] : 'MIXED');
    await conn.query(`UPDATE orders SET sales_flow=? WHERE id=?`, [headerFlow, orderId]);
    return headerFlow;
  }

  async addItem(orderId, data, user={}) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [orders] = await conn.query(`SELECT * FROM orders WHERE id=? FOR UPDATE`, [orderId]);
      if(!orders.length) throw new Error('Không tìm thấy bill');
      const order = orders[0];
      if(order.status === 'CANCELLED') throw new Error('Bill đã hủy, không thể thêm hàng');
      await assertCustomerScope(user, order.customer_id);
      await this.ensureOrderEditable(conn, orderId);

      const p = await this.resolveAddItemProduct(conn, order, data);

      const { itemFlowByProductId } = await deriveItemsSalesFlow(conn, [{ product_id: p.product_id }]);
      const itemFlow = itemFlowByProductId.get(Number(p.product_id)) || null;

      const [existingFlowRows] = await conn.query(
        `SELECT DISTINCT sales_flow, customer_price_category_id FROM order_items
         WHERE order_id=? AND sales_flow IS NOT NULL AND customer_price_category_id IS NOT NULL`,
        [orderId]
      );
      const seedFlowCategorySets = { CARCASS_POS: [], INVENTORY_SALE: [] };
      for (const r of existingFlowRows) {
        if (seedFlowCategorySets[r.sales_flow]) seedFlowCategorySets[r.sales_flow].push(Number(r.customer_price_category_id));
      }
      // p.price_type/p.price_book_id are already backend-resolved by
      // resolveAddItemProduct() (via PriceBookService.getEffectivePrice for an
      // existing product, or an explicit MANUAL_PRICE for a brand-new quick-add
      // product) — validated here, not data.price_type/data.price_book_id.
      const { categoryByProductId } = await assertItemsCategoryPerFlow(
        conn, order.customer_id,
        [{ product_id: p.product_id, product_name: p.product_name, price_book_id: p.price_book_id || null, price_type: p.price_type }],
        itemFlowByProductId, seedFlowCategorySets
      );
      const itemCategoryId = categoryByProductId.has(Number(p.product_id)) ? categoryByProductId.get(Number(p.product_id)) : null;

      const qty = Number(data.quantity || data.qty || 0);
      if(!(qty > 0)) throw new Error('Số lượng phải lớn hơn 0');
      const salePrice = Number(data.sale_price || data.price || p.sale_price || 0);
      if(!(salePrice >= 0)) throw new Error('Giá bán không hợp lệ');
      const line = qty * salePrice;
      const inv = await InventoryService.out(conn, p.product_id, qty, order.order_date, 'SALE', orderId, `Thêm hàng vào bill ${order.order_code}`, user.id || order.created_by || null);
      try {
        await conn.query(
          `INSERT INTO order_items(order_id,product_id,product_name,unit,quantity,sale_price,total_price,price_type,price_book_id,note,inventory_mode,stock_checked,sales_flow,customer_price_category_id)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [orderId, p.product_id, p.product_name, p.unit || data.unit || 'kg', qty, salePrice, line, p.price_type || 'MANUAL_PRICE', p.price_book_id || null, data.note || null, inv.inventory_mode, inv.stock_checked?1:0, itemFlow, itemCategoryId]
        );
      } catch (e) {
        const safePriceType = p.price_type === 'PRICE_BOOK' ? 'PRIVATE_PRICE' : (p.price_type || 'MANUAL_PRICE');
        await conn.query(
          `INSERT INTO order_items(order_id,product_id,product_name,unit,quantity,sale_price,total_price,price_type,note,inventory_mode,stock_checked)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          [orderId, p.product_id, p.product_name, p.unit || data.unit || 'kg', qty, salePrice, line, safePriceType, data.note || null, inv.inventory_mode, inv.stock_checked?1:0]
        );
      }
      await this.recomputeOrderSalesFlow(conn, orderId);
      const totals = await this.recalcOrderTotals(conn, orderId, user?.id || null);
      await conn.commit();
      return {message:'Đã thêm mặt hàng vào bill', ...totals};
    } catch(e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }

  async updateItem(orderId, itemId, data, user={}) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const o = await this.ensureOrderEditable(conn, orderId);
      await assertCustomerScope(user, o.customer_id);
      const [items] = await conn.query(`SELECT * FROM order_items WHERE id=? AND order_id=? FOR UPDATE`, [itemId,orderId]);
      if (!items.length) throw new Error('Không tìm thấy dòng bill');
      const old = items[0];
      const newQty = Number(data.quantity);
      if (!(newQty > 0)) throw new Error('Số lượng phải lớn hơn 0');
      // S8.1: same threshold addItem() already uses for an existing product
      // (>=0 — zero price is allowed, matching that approved rule; create()'s
      // stricter >0 only applies to initial bill creation, not editing an
      // existing line). Unlike addItem()'s fallback chain (data.sale_price ||
      // data.price || p.sale_price || 0), an edit has no legitimate fallback
      // source — null/undefined/non-numeric must be rejected outright rather
      // than silently coerced to 0.
      const rawPrice = data.sale_price;
      const newPrice = Number(rawPrice);
      if (rawPrice === null || rawPrice === undefined || rawPrice === '' || !Number.isFinite(newPrice) || newPrice < 0) {
        throw new Error('Giá bán không hợp lệ');
      }
      const newTotal = newQty * newPrice;
      await conn.query(`UPDATE order_items SET quantity=?, sale_price=?, total_price=? WHERE id=?`, [newQty,newPrice,newTotal,itemId]);
      await InventoryService.adjustOrderItem(conn, old.product_id, Number(old.quantity), newQty);
      await this.recalcOrderTotals(conn, orderId, user?.id || null);
      await conn.commit();
      return {message:'Đã sửa dòng bill'};
    } catch(e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }

  async printK80ByToken(token) {
    // V65.35: K80 must use the same professional payment-allocation summary as A4,
    // including separated cash/bank amounts per bill allocation.
    return PrintService.billK80Html(await this.getByToken(token));
  }

  async printHtmlById(id, user) { return PrintService.billHtml(await this.get(id, user)); }
  async printHtmlByToken(token) { return PrintService.billHtml(await this.getByToken(token)); }
}
module.exports = new OrderAgent();