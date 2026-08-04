'use strict';
const pool = require('../config/db');
const { nextCode } = require('../utils/code');
const { assertCustomerScope, customerScopeWhere } = require('../middleware/scope');
const InventoryService = require('../services/InventoryService');

// ReturnAgent — S9.2 Sales Return Foundation (refined per S9.2A CTO review),
// extended by S9.3R (Cancel) and S9.4 (Warehouse Receive & Inspection).
//
// Scope: Create Return Request, list, Cancel, and now the full warehouse
// workflow — Receive -> Inspect (repeatable) -> Complete/Reject. Debt/payment
// business logic still does not exist anywhere in this agent — that remains a
// later story, out of scope for S9.4 per its own locked rules (no payment, no
// refund, no debt adjustment in this story).
//
// Immutability, revised for S9.4: this agent still NEVER writes to orders,
// order_items, debt_transactions, or payments. It now DOES write to
// stock_transactions — but only via InventoryService.in() inside complete(),
// only for lines dispositioned RESTOCK, only when transitioning
// INSPECTING -> COMPLETED (locked rule #5). Every read of orders/order_items
// below is still SELECT-only (including the FOR UPDATE reads — a row lock is
// not a write).
//
// Return state lives exclusively in sales_returns.status — there is no
// orders.return_status cache column (CTO directive: avoid duplicated truth).
// status/return_reason_code are VARCHAR, not ENUM (S9.2A Decision #1) — the
// REASON_CODES/status literals below are the actual validation; the database
// imposes no constraint on allowed values, so adding a new reason code never
// requires an ALTER TABLE.
//
// Repository boundary (S9.2A Decision #4, audited not changed): this agent
// queries orders/order_items directly rather than through OrderAgent. This
// matches the established, already-consistent pattern elsewhere in this
// codebase — PaymentAgent.js (e.g. `SELECT ... FROM orders ... FOR UPDATE`
// inside revertPaymentEffects), ReportAgent.js, DebtInstallmentAgent.js, and
// aiInsight.service.js/aiPayment.service.js all query orders/order_items
// directly; there is no repository/DAO abstraction anywhere in this codebase
// (confirmed architecture is Route -> Agent -> Service -> Database, not
// Agent -> Repository). Keeping direct SQL here is consistency with the
// existing pattern, not a deviation from it.
//
// Concurrency/idempotency mirrors two already-proven idioms in this codebase:
//   - OrderAgent.create()'s idempotency_key pre-check -> insert -> catch
//     ER_DUP_ENTRY -> re-select pattern (OrderAgent.js:606-694).
//   - InventoryService.reverseOrderInventory()'s ascending-id processing order,
//     to avoid lock-ordering deadlocks when a request touches multiple lines.

const ORDER_STATUSES_RETURNABLE = ['CONFIRMED', 'DELIVERED'];
const REASON_CODES = ['WRONG_ITEM', 'CUSTOMER_CHANGED_MIND', 'QUALITY_COMPLAINT', 'QUANTITY_ERROR', 'PRICE_DISPUTE', 'OTHER'];

// sales_returns.status stays VARCHAR (S9.2A Decision #1) — these constants are
// the actual validation, same pattern as REASON_CODES above. APPROVED was
// removed per the S9.3R locked FS (Manager Review is a permission gate on the
// receive() action below, not a status). S9.4 locked state machine:
//   REQUESTED -> RECEIVED -> INSPECTING -> COMPLETED / REJECTED
//   REQUESTED -> CANCELLED (S9.3R, unchanged by S9.4)
const STATUS_REQUESTED = 'REQUESTED';
const STATUS_CANCELLED = 'CANCELLED';
const STATUS_RECEIVED = 'RECEIVED';
const STATUS_INSPECTING = 'INSPECTING';
const STATUS_COMPLETED = 'COMPLETED';
const STATUS_REJECTED = 'REJECTED';
const ALL_STATUSES = [STATUS_REQUESTED, STATUS_CANCELLED, STATUS_RECEIVED, STATUS_INSPECTING, STATUS_COMPLETED, STATUS_REJECTED];

// S9.4 locked rule #4: disposition is closed-set, no other values. Applies to
// the ACCEPTED portion of a line only — rejected_qty is never dispositioned,
// it is simply excluded from restock (locked rule #6 scope: no financial
// consequence to a rejected unit in this story either).
const DISPOSITIONS = ['RESTOCK', 'PROCESS', 'SCRAP'];

function badRequest(message, code) {
  const err = new Error(message);
  err.status = 400; err.statusCode = 400;
  if (code) err.code = code;
  return err;
}

function notFound(message) {
  const err = new Error(message);
  err.status = 404; err.statusCode = 404;
  return err;
}

// S9.3 audit logging: reuses the existing audit_logs table (id, user_id, action,
// entity_type, entity_id, note, created_at — bootstrap.js) verbatim, the same
// shape aiSupplierOrdering.service.js already writes to for AI-generated PO
// drafts. No new table, no new logging service — this is the only
// general-purpose, entity-agnostic audit table in the schema, so "reuse
// existing audit framework" means writing to it in its existing shape, not
// inventing a parallel mechanism. Never allowed to block the calling action if
// the write itself fails (matches aiSupplierOrdering.service.js's own
// try/catch-and-continue discipline for this exact table).
async function writeAuditLog(conn, userId, action, returnId, note) {
  try {
    await conn.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, note) VALUES (?,?,?,?,?)`,
      [userId || null, action, 'sales_returns', returnId, note || null]
    );
  } catch (e) {
    // audit_logs is best-effort — never fail Create/Cancel because the
    // audit trail itself couldn't be written.
  }
}

class ReturnAgent {
  // POST /api/orders/:id/returns
  async create(orderId, data = {}, user = {}) {
    orderId = Number(orderId);
    if (!orderId) throw badRequest('Thiếu mã bill');

    const rawItems = Array.isArray(data.items) ? data.items : [];
    if (!rawItems.length) throw badRequest('Vui lòng chọn ít nhất một dòng hàng để trả');

    const reasonCode = REASON_CODES.includes(data.return_reason_code) ? data.return_reason_code : null;
    if (!reasonCode) throw badRequest('Vui lòng chọn lý do trả hàng hợp lệ', 'RETURN_REASON_REQUIRED');

    const idempotencyKey = data.idempotency_key ? String(data.idempotency_key).slice(0, 100) : null;

    // Idempotent replay fast path — identical shape to OrderAgent.create()'s
    // optimistic pre-check outside the transaction.
    if (idempotencyKey) {
      const [existing] = await pool.query(
        `SELECT id FROM sales_returns WHERE idempotency_key=? LIMIT 1`, [idempotencyKey]
      );
      if (existing.length) return this._buildCreateResponse(existing[0].id);
    }

    // S9.3: reject duplicate item lines within one request — two lines targeting
    // the same order_item_id in a single payload is a client-input error (e.g. a
    // double-added row in the New Return form), not two legitimate separate
    // return claims. A genuine second return against the same line later is
    // still allowed (that's the existing remaining-quantity check below, across
    // separate requests) — this only catches duplicates within THIS payload.
    const seenOrderItemIds = new Set();
    for (const line of rawItems) {
      const oid = Number(line.order_item_id);
      if (seenOrderItemIds.has(oid)) {
        throw badRequest(`Dòng hàng #${oid} bị chọn trùng lặp trong yêu cầu trả hàng`, 'DUPLICATE_ITEM_LINE');
      }
      seenOrderItemIds.add(oid);
    }

    // Deterministic processing order (ascending order_item_id) — avoids
    // lock-ordering deadlocks against another concurrent return request touching
    // an overlapping set of lines, same discipline as reverseOrderInventory().
    const items = [...rawItems].sort((a, b) => Number(a.order_item_id) - Number(b.order_item_id));

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Order must exist, be in customer's scope, and be in a state a return can
      // apply to. Read-only lock (FOR UPDATE) — orders is never written here.
      // is_locked ("chốt sổ") is deliberately NOT checked: that lock freezes the
      // bill's own totals from being edited; it says nothing about whether goods
      // already sold on that bill can later be physically returned. Flagged to
      // CTO as an explicit policy choice, not an oversight (see audit response).
      const [orders] = await conn.query(
        `SELECT id, status, customer_id FROM orders WHERE id=? FOR UPDATE`, [orderId]
      );
      if (!orders.length) throw notFound('Không tìm thấy bill');
      const order = orders[0];
      const status = String(order.status || '').toUpperCase();

      if (status === 'CANCELLED') throw badRequest('Bill đã hủy, không thể tạo yêu cầu trả hàng', 'ORDER_CANCELLED');
      if (!ORDER_STATUSES_RETURNABLE.includes(status)) throw badRequest('Bill chưa giao, không thể tạo yêu cầu trả hàng', 'ORDER_NOT_RETURNABLE');

      await assertCustomerScope(user, order.customer_id);

      const returnCode = await nextCode(conn, 'sales_returns', 'return_code', 'RET');

      const [insResult] = await conn.query(
        `INSERT INTO sales_returns
           (return_code, order_id, customer_id, status, return_reason_code, return_reason_note,
            idempotency_key, created_by)
         VALUES (?,?,?,'REQUESTED',?,?,?,?)`,
        [returnCode, orderId, order.customer_id, reasonCode, data.return_reason_note || null, idempotencyKey, user?.id || null]
      );
      const returnId = insResult.insertId;

      for (const line of items) {
        const orderItemId = Number(line.order_item_id);
        const qtyRequested = Number(line.quantity_requested || line.quantity || 0);
        if (!orderItemId) throw badRequest('Thiếu dòng hàng gốc (order_item_id)');
        if (!(qtyRequested > 0)) throw badRequest('Số lượng trả phải lớn hơn 0');

        // Read-only lock on the original line for the duration of this
        // check+insert — order_items is never written (S9.2 immutability rule).
        // This is the sole concurrency guard against two simultaneous return
        // requests jointly over-claiming this line's original quantity.
        const [orderItems] = await conn.query(
          `SELECT id, order_id, product_id, quantity, sale_price, unit
           FROM order_items WHERE id=? FOR UPDATE`, [orderItemId]
        );
        if (!orderItems.length) throw badRequest(`Không tìm thấy dòng hàng gốc #${orderItemId}`);
        const oi = orderItems[0];
        if (Number(oi.order_id) !== orderId) throw badRequest(`Dòng hàng #${orderItemId} không thuộc bill này`);

        // S9.3R: product eligibility no longer gates return creation on the
        // product's current catalog status (removed the old PRODUCT_DELETED
        // check here). order_items already froze product_id/sale_price/unit at
        // sale time; per the locked FS, a product being soft-deleted/inactive/
        // discontinued after the sale must not, by itself, invalidate a
        // historical return — the order line and product reference existing is
        // sufficient.

        // Remaining-quantity check: live SUM over sales_return_items, not a cache
        // column (order_items.returned_quantity was deliberately not added — CTO
        // directive). Runs inside the same transaction, under the FOR UPDATE lock
        // above, so it also sees this request's own earlier inserts if the same
        // order_item_id appears more than once in one payload. Joined to
        // sales_returns and filtered to status <> 'CANCELLED' (S9.3R fix): a
        // cancelled return's requested quantity must not permanently reduce what
        // can still be returned on this line, per the locked FS's "non-cancelled
        // cumulative quantity" rule.
        const [[alreadyRow]] = await conn.query(
          `SELECT COALESCE(SUM(sri.quantity_requested),0) already
           FROM sales_return_items sri
           JOIN sales_returns sr ON sr.id = sri.return_id
           WHERE sri.order_item_id=? AND sr.status <> 'CANCELLED'`, [orderItemId]
        );
        const already = Number(alreadyRow.already || 0);
        const remaining = Number(oi.quantity) - already;
        if (qtyRequested > remaining + 0.0001) {
          throw badRequest(
            `Số lượng trả (${qtyRequested}) vượt quá số lượng còn lại có thể trả (${remaining}) của dòng #${orderItemId}`,
            'RETURN_QTY_EXCEEDS_REMAINING'
          );
        }

        // Traceability (S9.1 audit rule): link to the original Inventory OUT row
        // where one exists — but ONLY when unambiguous (S9.2A Decision #3).
        //
        // Evidence this must not be a bare LIMIT 1: stock_transactions.reference_id
        // stores the ORDER id, not the order_item id — confirmed at
        // InventoryService.applyOrderInventory() -> postOut(conn, p.id, qty,
        // orderDate, 'SALE', orderId, ...) (InventoryService.js:178-199), which
        // passes orderId, never item.id, as reference_id. OrderAgent.create()
        // (OrderAgent.js:590-670) has no guard preventing two lines with the same
        // product_id in one order, and order_items has no UNIQUE(order_id,
        // product_id) constraint (bootstrap.js order_items definition — only an
        // index on order_id). Therefore if an order has two lines for the same
        // product, this WHERE clause matches two indistinguishable OUT rows, and
        // a bare LIMIT 1 would silently attribute the return to whichever one the
        // query planner returns first — no way to know which order_item it
        // actually belongs to at the stock_transactions level as currently
        // designed (it was never given the granularity to know). Guessing wrong
        // here is worse than not linking at all (BR-CORE-002 traceability), so
        // this only links when there is exactly one candidate; otherwise NULL.
        // A single order_item generating multiple OUT rows was NOT found anywhere
        // (postOut is called exactly once per item at creation time; edits go
        // through adjustOrderItem()'s reference_type='MANUAL' path, never 'SALE') —
        // the ambiguity runs the other direction, across sibling order_items of
        // the same order+product, not within one order_item.
        const [sourceOutCandidates] = await conn.query(
          `SELECT id FROM stock_transactions WHERE reference_type='SALE' AND reference_id=? AND product_id=?`,
          [orderId, oi.product_id]
        );
        const sourceStockTransactionId = sourceOutCandidates.length === 1 ? sourceOutCandidates[0].id : null;

        // Only the "ask" columns exist on this table at all (S9.2A Decision #5 —
        // disposition/inspection columns were removed as future-story schema, not
        // just left unwritten). frozen_unit_price/frozen_unit copy the original
        // line's sale_price/unit verbatim — never re-resolved from current pricing.
        // frozen_unit stays free-text VARCHAR (S9.2A Decision #2): order_items has
        // no unit_id/product_unit_id to reuse — see file header.
        await conn.query(
          `INSERT INTO sales_return_items
             (return_id, order_item_id, product_id, source_stock_transaction_id,
              quantity_requested, frozen_unit_price, frozen_unit)
           VALUES (?,?,?,?,?,?,?)`,
          [returnId, orderItemId, oi.product_id, sourceStockTransactionId, qtyRequested, oi.sale_price, oi.unit]
        );
      }

      await writeAuditLog(conn, user?.id, 'SALES_RETURN_CREATED', returnId, `Tạo yêu cầu trả hàng ${returnCode} cho bill #${orderId}`);

      await conn.commit();
      return this._buildCreateResponse(returnId);
    } catch (e) {
      await conn.rollback();
      // idempotency_key race: two concurrent identical retries can both miss the
      // pre-check above and both attempt the INSERT — the UNIQUE constraint on
      // sales_returns.idempotency_key is the real backstop, mirroring
      // OrderAgent.create()'s ER_DUP_ENTRY recovery (OrderAgent.js:686-694).
      if (idempotencyKey && e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062)) {
        const [existing] = await pool.query(
          `SELECT id FROM sales_returns WHERE idempotency_key=? LIMIT 1`, [idempotencyKey]
        );
        if (existing.length) return this._buildCreateResponse(existing[0].id);
      }
      throw e;
    } finally {
      conn.release();
    }
  }

  async _buildCreateResponse(returnId) {
    const [[header]] = await pool.query(`SELECT * FROM sales_returns WHERE id=?`, [returnId]);
    const [items] = await pool.query(`SELECT * FROM sales_return_items WHERE return_id=? ORDER BY id ASC`, [returnId]);
    return {
      message: 'Đã tạo yêu cầu trả hàng',
      return_id: returnId,
      return_code: header?.return_code,
      status: header?.status,
      items,
    };
  }

  // GET /api/orders/:id/returns — header + lines. No financial data — read-only,
  // sales-return tables only. `inspections` on each item is now a real query
  // (S9.4): the S9.2A comment this replaced explicitly kept the field name in
  // the response shape so S9.4 could start populating it without an API
  // contract change — this is that change.
  async list(orderId, user = {}) {
    orderId = Number(orderId);
    if (!orderId) throw badRequest('Thiếu mã bill');

    const [orders] = await pool.query(`SELECT id, customer_id FROM orders WHERE id=?`, [orderId]);
    if (!orders.length) throw notFound('Không tìm thấy bill');
    await assertCustomerScope(user, orders[0].customer_id);

    const [returns] = await pool.query(`SELECT * FROM sales_returns WHERE order_id=? ORDER BY id DESC`, [orderId]);
    if (!returns.length) return { order_id: orderId, returns: [] };

    const returnIds = returns.map(r => r.id);
    const returnPlaceholders = returnIds.map(() => '?').join(',');
    const [items] = await pool.query(
      `SELECT * FROM sales_return_items WHERE return_id IN (${returnPlaceholders}) ORDER BY id ASC`, returnIds
    );

    const inspectionsByItem = await this._inspectionsByItem(items.map(it => it.id));

    const itemsByReturn = new Map();
    for (const it of items) {
      const list = itemsByReturn.get(it.return_id) || [];
      list.push({ ...it, inspections: inspectionsByItem.get(it.id) || [] });
      itemsByReturn.set(it.return_id, list);
    }

    return {
      order_id: orderId,
      returns: returns.map(r => ({ ...r, items: itemsByReturn.get(r.id) || [] })),
    };
  }

  // Shared by list()/get() — one lookup query for the inspection history of a
  // set of return_item ids. Returns a Map keyed by return_item_id.
  //
  // P1-01 additive read-model change: joins users for inspector_name, same
  // created_by_name/received_by_name/completed_by_name convention already used
  // above — the warehouse Inspection history needs "Inspector" as a name, not
  // just inspector_id. Read-only join, no write-path change.
  async _inspectionsByItem(itemIds) {
    const map = new Map();
    if (!itemIds.length) return map;
    const placeholders = itemIds.map(() => '?').join(',');
    const [inspections] = await pool.query(
      `SELECT sri.*, ui.full_name inspector_name
       FROM sales_return_inspections sri
       LEFT JOIN users ui ON ui.id = sri.inspector_id
       WHERE sri.return_item_id IN (${placeholders}) ORDER BY sri.id ASC`, itemIds
    );
    for (const insp of inspections) {
      const list = map.get(insp.return_item_id) || [];
      list.push(insp);
      map.set(insp.return_item_id, list);
    }
    return map;
  }

  // GET /api/sales-returns — Search/Grid page (S9.3). Top-level list across all
  // orders, unlike list(orderId) above which is scoped to one bill. Read-only;
  // no inventory/financial join. CUSTOMER role scoped via customerScopeWhere,
  // identical to OrderAgent.list()'s own convention.
  async listAll(query = {}, user = {}) {
    const where = [], params = [];
    if (user.role === 'CUSTOMER') {
      const scope = await customerScopeWhere(user, 'sr.customer_id');
      where.push(scope.clause); params.push(...scope.params);
    }
    if (query.return_code) { where.push('sr.return_code LIKE ?'); params.push('%' + String(query.return_code).trim() + '%'); }
    if (query.customer_name || query.customer) { where.push('c.name LIKE ?'); params.push('%' + String(query.customer_name || query.customer).trim() + '%'); }
    if (query.status && ALL_STATUSES.includes(String(query.status).toUpperCase())) {
      where.push('sr.status = ?'); params.push(String(query.status).toUpperCase());
    }
    if (query.from_date || query.from) { where.push('DATE(sr.requested_at) >= ?'); params.push(String(query.from_date || query.from).slice(0, 10)); }
    if (query.to_date || query.to) { where.push('DATE(sr.requested_at) <= ?'); params.push(String(query.to_date || query.to).slice(0, 10)); }
    if (query.created_by) { where.push('sr.created_by = ?'); params.push(Number(query.created_by)); }

    const [rows] = await pool.query(
      `SELECT sr.*, c.name customer_name, o.order_code,
              u.full_name created_by_name,
              COALESCE((SELECT SUM(sri.quantity_requested) FROM sales_return_items sri WHERE sri.return_id = sr.id), 0) total_qty
       FROM sales_returns sr
       JOIN customers c ON c.id = sr.customer_id
       JOIN orders o ON o.id = sr.order_id
       LEFT JOIN users u ON u.id = sr.created_by
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY sr.requested_at DESC, sr.id DESC`,
      params
    );
    return rows;
  }

  // GET /api/sales-returns/:id — View/Print detail (S9.3), extended by S9.4-UI
  // (P1-01) to also surface the warehouse header actors for the detail dialog.
  // Read-only, no inventory/financial data beyond what already exists on
  // sales_return_items (frozen_unit_price is returned but the View/Print UI
  // must not render it as a financial total, per the story's "no financial
  // information" rule).
  //
  // P1-01 additive read-model change: sr.received_by/completed_by were already
  // stored (S9.4 schema) but never joined to a human-readable name — only
  // created_by_name existed. The warehouse detail view needs "Received by" /
  // "Completed by" as names, same convention as created_by_name above, so two
  // more LEFT JOINs are added here. No new column, no write-path change, no
  // endpoint contract removed — purely additive fields on an existing response.
  async get(returnId, user = {}) {
    returnId = Number(returnId);
    if (!returnId) throw badRequest('Thiếu mã yêu cầu trả hàng');

    const [[header]] = await pool.query(
      `SELECT sr.*, c.name customer_name, o.order_code, u.full_name created_by_name,
              ur.full_name received_by_name, uc.full_name completed_by_name
       FROM sales_returns sr
       JOIN customers c ON c.id = sr.customer_id
       JOIN orders o ON o.id = sr.order_id
       LEFT JOIN users u ON u.id = sr.created_by
       LEFT JOIN users ur ON ur.id = sr.received_by
       LEFT JOIN users uc ON uc.id = sr.completed_by
       WHERE sr.id = ?`,
      [returnId]
    );
    if (!header) throw notFound('Không tìm thấy yêu cầu trả hàng');
    await assertCustomerScope(user, header.customer_id);

    const [items] = await pool.query(
      `SELECT sri.*, p.name product_name
       FROM sales_return_items sri
       LEFT JOIN products p ON p.id = sri.product_id
       WHERE sri.return_id = ? ORDER BY sri.id ASC`,
      [returnId]
    );
    const inspectionsByItem = await this._inspectionsByItem(items.map(it => it.id));

    return { ...header, items: items.map(it => ({ ...it, inspections: inspectionsByItem.get(it.id) || [] })) };
  }

  // POST /api/sales-returns/:id/cancel — REQUESTED -> CANCELLED only (S9.3R,
  // locked FS state machine — APPROVED removed, Manager Review is a permission
  // gate on a future receive() action, not a status). Reason required, same
  // discipline as OrderAgent.cancel(). No inventory/debt reversal needed or
  // performed — nothing is ever posted for a return still in REQUESTED,
  // matching the locked rule that inventory/finance stay untouched until
  // COMPLETED.
  async cancel(returnId, data = {}, user = {}) {
    returnId = Number(returnId);
    if (!returnId) throw badRequest('Thiếu mã yêu cầu trả hàng');
    const reason = String(data.reason || data.cancel_reason || '').trim();
    if (!reason) throw badRequest('Vui lòng nhập lý do hủy yêu cầu trả hàng', 'CANCEL_REASON_REQUIRED');

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[row]] = await conn.query(`SELECT id, status, customer_id FROM sales_returns WHERE id=? FOR UPDATE`, [returnId]);
      if (!row) throw notFound('Không tìm thấy yêu cầu trả hàng');
      await assertCustomerScope(user, row.customer_id);

      if (row.status === STATUS_CANCELLED) throw badRequest('Yêu cầu trả hàng đã hủy', 'RETURN_ALREADY_CANCELLED');
      if (row.status !== STATUS_REQUESTED) throw badRequest('Không thể hủy yêu cầu trả hàng ở trạng thái hiện tại', 'RETURN_INVALID_STATE');

      await conn.query(`UPDATE sales_returns SET status=? WHERE id=?`, [STATUS_CANCELLED, returnId]);
      await writeAuditLog(conn, user?.id, 'SALES_RETURN_CANCELLED', returnId, reason);

      await conn.commit();
      return { message: 'Đã hủy yêu cầu trả hàng', return_id: returnId, status: STATUS_CANCELLED };
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  // POST /api/sales-returns/:id/receive — REQUESTED -> RECEIVED (S9.4 locked
  // rule #2). Records received_qty per line + received_at/received_by on the
  // header. No inventory movement, no refund, no debt change — matches the
  // rule exactly (nothing is posted anywhere else in this step).
  async receive(returnId, data = {}, user = {}) {
    returnId = Number(returnId);
    if (!returnId) throw badRequest('Thiếu mã yêu cầu trả hàng');
    const rawItems = Array.isArray(data.items) ? data.items : [];
    if (!rawItems.length) throw badRequest('Vui lòng nhập số lượng nhận hàng cho ít nhất một dòng hàng');

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[row]] = await conn.query(
        `SELECT id, status, customer_id, return_code FROM sales_returns WHERE id=? FOR UPDATE`, [returnId]
      );
      if (!row) throw notFound('Không tìm thấy yêu cầu trả hàng');
      await assertCustomerScope(user, row.customer_id);
      if (row.status !== STATUS_REQUESTED) {
        throw badRequest(`Không thể nhận hàng, yêu cầu đang ở trạng thái ${row.status}`, 'RETURN_INVALID_STATE');
      }

      for (const line of rawItems) {
        const itemId = Number(line.return_item_id);
        const receivedQty = Number(line.received_qty);
        if (!itemId) throw badRequest('Thiếu dòng hàng trả (return_item_id)');
        if (!Number.isFinite(receivedQty) || receivedQty < 0) {
          throw badRequest(`Số lượng nhận không hợp lệ cho dòng #${itemId}`);
        }

        // Read-only-then-write lock on the target line, same discipline as
        // create()'s FOR UPDATE on order_items — guards against a second
        // concurrent receive() call on this same return.
        const [[item]] = await conn.query(
          `SELECT id, return_id, quantity_requested FROM sales_return_items WHERE id=? FOR UPDATE`, [itemId]
        );
        if (!item || Number(item.return_id) !== returnId) {
          throw badRequest(`Không tìm thấy dòng hàng trả #${itemId} thuộc yêu cầu này`);
        }
        if (receivedQty > Number(item.quantity_requested) + 0.0001) {
          throw badRequest(
            `Số lượng nhận (${receivedQty}) vượt quá số lượng yêu cầu trả (${item.quantity_requested}) của dòng #${itemId}`,
            'RECEIVE_QTY_EXCEEDS_REQUESTED'
          );
        }

        await conn.query(`UPDATE sales_return_items SET quantity_received=? WHERE id=?`, [receivedQty, itemId]);
      }

      await conn.query(
        `UPDATE sales_returns SET status=?, received_at=NOW(), received_by=? WHERE id=?`,
        [STATUS_RECEIVED, user?.id || null, returnId]
      );
      await writeAuditLog(conn, user?.id, 'SALES_RETURN_RECEIVED', returnId, `Xác nhận đã nhận hàng trả ${row.return_code || ''}`.trim());

      await conn.commit();
      return { message: 'Đã xác nhận nhận hàng trả', return_id: returnId, status: STATUS_RECEIVED };
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  // POST /api/sales-returns/:id/inspect — RECEIVED -> INSPECTING, and
  // INSPECTING -> INSPECTING again on repeat calls (S9.4 locked rule #3:
  // "Inspection can be performed multiple times before completion"). Each call
  // appends a new sales_return_inspections row per line (history, matching
  // that column's evident purpose) and overwrites the line's CURRENT
  // disposition_type/return_to_stock_qty/non_sellable_qty on sales_return_items
  // — the latest call's decision is what complete() acts on. Disposition
  // (locked rule #4) applies to accepted_qty only: return_to_stock_qty = the
  // RESTOCK portion of accepted_qty, non_sellable_qty = the PROCESS/SCRAP
  // portion; rejected_qty is tracked on the inspection row only and is never
  // restocked regardless of disposition (rule #6: no financial consequence to
  // a rejected unit in this story).
  async inspect(returnId, data = {}, user = {}) {
    returnId = Number(returnId);
    if (!returnId) throw badRequest('Thiếu mã yêu cầu trả hàng');
    const rawItems = Array.isArray(data.items) ? data.items : [];
    if (!rawItems.length) throw badRequest('Vui lòng nhập kết quả kiểm tra cho ít nhất một dòng hàng');

    for (const line of rawItems) {
      if (!DISPOSITIONS.includes(line.disposition)) {
        throw badRequest(`Phương án xử lý không hợp lệ cho dòng #${line.return_item_id}`, 'RETURN_INVALID_DISPOSITION');
      }
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[row]] = await conn.query(
        `SELECT id, status, customer_id, return_code FROM sales_returns WHERE id=? FOR UPDATE`, [returnId]
      );
      if (!row) throw notFound('Không tìm thấy yêu cầu trả hàng');
      await assertCustomerScope(user, row.customer_id);
      if (row.status !== STATUS_RECEIVED && row.status !== STATUS_INSPECTING) {
        throw badRequest(`Không thể kiểm tra, yêu cầu đang ở trạng thái ${row.status}`, 'RETURN_INVALID_STATE');
      }

      for (const line of rawItems) {
        const itemId = Number(line.return_item_id);
        const acceptedQty = Number(line.accepted_qty || 0);
        const rejectedQty = Number(line.rejected_qty || 0);
        const disposition = line.disposition;
        if (!itemId) throw badRequest('Thiếu dòng hàng trả (return_item_id)');
        if (!(acceptedQty >= 0) || !(rejectedQty >= 0)) {
          throw badRequest(`Số lượng kiểm tra không hợp lệ cho dòng #${itemId}`);
        }

        const [[item]] = await conn.query(
          `SELECT id, return_id, quantity_received FROM sales_return_items WHERE id=? FOR UPDATE`, [itemId]
        );
        if (!item || Number(item.return_id) !== returnId) {
          throw badRequest(`Không tìm thấy dòng hàng trả #${itemId} thuộc yêu cầu này`);
        }
        if (acceptedQty + rejectedQty > Number(item.quantity_received) + 0.0001) {
          throw badRequest(
            `Tổng số lượng kiểm tra (${acceptedQty + rejectedQty}) vượt quá số lượng đã nhận (${item.quantity_received}) của dòng #${itemId}`,
            'INSPECT_QTY_EXCEEDS_RECEIVED'
          );
        }

        await conn.query(
          `INSERT INTO sales_return_inspections (return_item_id, accepted_qty, rejected_qty, inspector_id, inspected_at)
           VALUES (?,?,?,?,NOW())`,
          [itemId, acceptedQty, rejectedQty, user?.id || null]
        );

        const restockQty = disposition === 'RESTOCK' ? acceptedQty : 0;
        const nonSellableQty = disposition === 'RESTOCK' ? 0 : acceptedQty;
        await conn.query(
          `UPDATE sales_return_items
             SET disposition_type=?, return_to_stock_qty=?, non_sellable_qty=?, decided_by=?, decided_at=NOW(),
                 disposition_reason_note=?
           WHERE id=?`,
          [disposition, restockQty, nonSellableQty, user?.id || null, line.note || line.disposition_reason_note || null, itemId]
        );
      }

      if (row.status !== STATUS_INSPECTING) {
        await conn.query(`UPDATE sales_returns SET status=? WHERE id=?`, [STATUS_INSPECTING, returnId]);
      }
      await writeAuditLog(conn, user?.id, 'SALES_RETURN_INSPECTED', returnId, `Ghi nhận kết quả kiểm tra ${rawItems.length} dòng hàng`);

      await conn.commit();
      return { message: 'Đã ghi nhận kết quả kiểm tra', return_id: returnId, status: STATUS_INSPECTING };
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  // POST /api/sales-returns/:id/complete — INSPECTING -> COMPLETED (S9.4 locked
  // rule #5): the ONLY transition in this whole agent that ever writes to
  // stock_transactions, and only for the RESTOCK-dispositioned qty of each
  // line, via InventoryService.in() (the same shared IN-movement primitive
  // every other inventory-increasing caller in this codebase uses — reference
  // reference_type='SALES_RETURN', reference_id=returnId, mirroring how
  // reference_id already means "the header id, not the line id" for
  // reference_type='SALE' elsewhere in this file). Requires every line to have
  // a decided disposition (i.e. inspect() was called for all lines) — refuses
  // to complete a partially-inspected return.
  async complete(returnId, user = {}) {
    returnId = Number(returnId);
    if (!returnId) throw badRequest('Thiếu mã yêu cầu trả hàng');

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[row]] = await conn.query(
        `SELECT id, status, customer_id, return_code FROM sales_returns WHERE id=? FOR UPDATE`, [returnId]
      );
      if (!row) throw notFound('Không tìm thấy yêu cầu trả hàng');
      await assertCustomerScope(user, row.customer_id);
      if (row.status !== STATUS_INSPECTING) {
        throw badRequest(`Không thể hoàn tất, yêu cầu đang ở trạng thái ${row.status}`, 'RETURN_INVALID_STATE');
      }

      // Ascending id order — same lock-ordering discipline as create()'s item
      // loop and InventoryService.reverseOrderInventory().
      const [items] = await conn.query(
        `SELECT id, product_id, disposition_type, return_to_stock_qty
         FROM sales_return_items WHERE return_id=? ORDER BY id ASC FOR UPDATE`, [returnId]
      );
      if (!items.length) throw badRequest('Yêu cầu trả hàng không có dòng hàng nào');
      const undecided = items.filter(it => !DISPOSITIONS.includes(it.disposition_type));
      if (undecided.length) {
        throw badRequest(
          'Cần kiểm tra và quyết định phương án xử lý cho tất cả các dòng hàng trước khi hoàn tất',
          'RETURN_INSPECTION_INCOMPLETE'
        );
      }

      const stockResults = [];
      for (const item of items) {
        const restockQty = Number(item.return_to_stock_qty || 0);
        if (restockQty > 0) {
          const result = await InventoryService.in(
            conn, item.product_id, restockQty, new Date(), 'SALES_RETURN', returnId,
            `Nhập lại tồn kho từ trả hàng ${row.return_code || returnId}`, user?.id || null
          );
          stockResults.push({ product_id: item.product_id, qty: restockQty, ...result });
        }
      }

      // Mark the inspection row that actually decided each line's outcome as
      // final — the latest (highest id) row per return_item_id at the moment
      // of completion. Read-model convenience only (matches is_final's
      // evident purpose); complete()'s own logic above already used
      // sales_return_items.disposition_type/return_to_stock_qty as the
      // authority, not this flag.
      await conn.query(
        `UPDATE sales_return_inspections i
           JOIN (
             SELECT return_item_id, MAX(id) max_id FROM sales_return_inspections
             WHERE return_item_id IN (${items.map(() => '?').join(',')})
             GROUP BY return_item_id
           ) latest ON latest.return_item_id = i.return_item_id AND latest.max_id = i.id
           SET i.is_final = 1`,
        items.map(it => it.id)
      );

      await conn.query(
        `UPDATE sales_returns SET status=?, completed_at=NOW(), completed_by=? WHERE id=?`,
        [STATUS_COMPLETED, user?.id || null, returnId]
      );
      await writeAuditLog(conn, user?.id, 'SALES_RETURN_COMPLETED', returnId, `Hoàn tất trả hàng ${row.return_code || ''}`.trim());

      await conn.commit();
      return { message: 'Đã hoàn tất yêu cầu trả hàng', return_id: returnId, status: STATUS_COMPLETED, stock: stockResults };
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  // POST /api/sales-returns/:id/reject — INSPECTING -> REJECTED (S9.4 locked
  // rule #5/#6 combined): a terminal outcome with ZERO inventory effect,
  // regardless of what any line's disposition/accepted_qty was recorded as
  // during inspection — inventory only ever moves on the COMPLETED path. No
  // payment/refund/debt effect either (out of scope for this story). Reason
  // required, same discipline as cancel().
  async reject(returnId, data = {}, user = {}) {
    returnId = Number(returnId);
    if (!returnId) throw badRequest('Thiếu mã yêu cầu trả hàng');
    const reason = String(data.reason || '').trim();
    if (!reason) throw badRequest('Vui lòng nhập lý do từ chối', 'REJECT_REASON_REQUIRED');

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[row]] = await conn.query(
        `SELECT id, status, customer_id, return_code FROM sales_returns WHERE id=? FOR UPDATE`, [returnId]
      );
      if (!row) throw notFound('Không tìm thấy yêu cầu trả hàng');
      await assertCustomerScope(user, row.customer_id);
      if (row.status !== STATUS_INSPECTING) {
        throw badRequest(`Không thể từ chối, yêu cầu đang ở trạng thái ${row.status}`, 'RETURN_INVALID_STATE');
      }

      await conn.query(`UPDATE sales_returns SET status=?, rejected_at=NOW() WHERE id=?`, [STATUS_REJECTED, returnId]);
      await writeAuditLog(conn, user?.id, 'SALES_RETURN_REJECTED', returnId, reason);

      await conn.commit();
      return { message: 'Đã từ chối yêu cầu trả hàng', return_id: returnId, status: STATUS_REJECTED };
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }
}

module.exports = new ReturnAgent();
