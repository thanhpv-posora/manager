'use strict';
const pool = require('../config/db');
const { nextCode } = require('../utils/code');
const { assertCustomerScope, customerScopeWhere } = require('../middleware/scope');
const InventoryService = require('../services/InventoryService');

// ReturnAgent — S9.2 Sales Return Foundation (refined per S9.2A CTO review),
// extended by S9.3R (Cancel), S9.4 (Warehouse Receive & Inspection), and
// GO-LIVE F-RETURN-DEBT (Debt Reverse).
//
// Scope: Create Return Request, list, Cancel, and the full warehouse
// workflow — Receive -> Inspect (repeatable) -> Complete/Reject.
//
// Immutability, revised for GO-LIVE F-RETURN-DEBT: this agent NEVER writes to
// order_items or payments, and never rewrites an existing orders/
// debt_transactions row (compensating rows only, same append-only discipline
// OrderAgent.cancel()/recalcOrderTotals() already use). It writes to
// stock_transactions via InventoryService.in() inside complete(), only for
// lines dispositioned RESTOCK, only when transitioning INSPECTING ->
// COMPLETED (locked rule #5); and, also only inside complete(), to
// orders.debt_amount/payment_status + one compensating debt_transactions row
// — capped at the order's own current debt_amount so the customer-ledger
// reconciliation invariant (SUM(debt_transactions) per customer ==
// SUM(orders.debt_amount) across non-cancelled orders) never breaks. See
// complete()'s own comment for the full design and its known residual gap
// (already-fully-paid bills don't get an automatic refund/credit). No
// payment/refund logic exists here — still out of scope. Every read of
// orders/order_items elsewhere in this file is still SELECT-only (including
// the FOR UPDATE reads — a row lock is not a write).
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

// P1-01A (CTO review correction) — shared decimal tolerance for every
// quantity-equality/quantity-cap check in this file, replacing the ad-hoc
// 0.0001 literals that were already used inconsistently at several call
// sites below. Same order of magnitude as the rest of the codebase's own
// convention (InventoryReceiveService.js uses 0.001).
const QTY_TOLERANCE = 0.0001;

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
  // — the latest call's decision is what complete()/reject() act on.
  // Inspection drafts may remain partial while status stays INSPECTING (only
  // Complete/Reject require every line fully classified — see
  // _resolveFinalization()).
  //
  // P1-01A FIX4 (CTO review correction): disposition applies to accepted_qty
  // only, and is required ONLY when accepted_qty > 0 — a line with nothing
  // accepted has no RESTOCK/PROCESS/SCRAP decision to make. The previous
  // version forced a disposition on every submitted line unconditionally,
  // which pushed the UI to silently default to RESTOCK just to pass
  // validation on a 0-accepted line; that default is removed here at the
  // source instead. rejected_qty is tracked on the inspection row only and is
  // never restocked regardless of disposition (rule #6: no financial
  // consequence to a rejected unit in this story).
  async inspect(returnId, data = {}, user = {}) {
    returnId = Number(returnId);
    if (!returnId) throw badRequest('Thiếu mã yêu cầu trả hàng');
    const rawItems = Array.isArray(data.items) ? data.items : [];
    if (!rawItems.length) throw badRequest('Vui lòng nhập kết quả kiểm tra cho ít nhất một dòng hàng');

    for (const line of rawItems) {
      const acceptedQty = Number(line.accepted_qty || 0);
      if (acceptedQty > 0 && !DISPOSITIONS.includes(line.disposition)) {
        throw badRequest(`Phương án xử lý không hợp lệ hoặc còn thiếu cho dòng #${line.return_item_id}`, 'RETURN_INVALID_DISPOSITION');
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
        if (acceptedQty + rejectedQty > Number(item.quantity_received) + QTY_TOLERANCE) {
          throw badRequest(
            `Tổng số lượng kiểm tra (${acceptedQty + rejectedQty}) vượt quá số lượng đã nhận (${item.quantity_received}) của dòng #${itemId}`,
            'INSPECT_QTY_EXCEEDS_RECEIVED'
          );
        }

        // P1-01A FIX5 (CTO review correction): inspection_note (this
        // inspection event's own remark, e.g. "found 2kg spoiled on arrival")
        // and disposition_reason_note (why THIS disposition was chosen for
        // the line, e.g. "PROCESS because still edible but off-grade") are
        // different business meanings and are no longer conflated into one
        // column the way the original S9.4 version did (it wrote the same
        // `note` value into disposition_reason_note only, and
        // sales_return_inspections.inspection_note was never written at all
        // despite existing in the schema since S9.2 FINAL).
        //
        // Backward-compatible precedence: an explicit `inspection_note` field
        // wins; the legacy single `note` field is accepted as a fallback ONLY
        // for inspection_note (matching what callers actually meant by `note`
        // before this fix — a remark about the inspection itself). Legacy
        // `note` never populates disposition_reason_note — that field is
        // explicit-only (`disposition_reason_note` in the request body) and
        // defaults to null when omitted, so one note value is never silently
        // duplicated into two different-meaning columns.
        const inspectionNote = line.inspection_note != null
          ? (String(line.inspection_note).trim() || null)
          : (line.note != null ? (String(line.note).trim() || null) : null);
        const dispositionReasonNote = line.disposition_reason_note != null
          ? (String(line.disposition_reason_note).trim() || null)
          : null;

        await conn.query(
          `INSERT INTO sales_return_inspections (return_item_id, accepted_qty, rejected_qty, inspection_note, inspector_id, inspected_at)
           VALUES (?,?,?,?,?,NOW())`,
          [itemId, acceptedQty, rejectedQty, inspectionNote, user?.id || null]
        );

        // P1-01A FIX4: nothing accepted -> no disposition decision was made;
        // persist the disposition state as null/zero rather than
        // forcing/defaulting a value merely to satisfy a NOT NULL-style
        // expectation (the column itself is nullable — see bootstrap.js).
        const disposition = acceptedQty > 0 ? line.disposition : null;
        const restockQty = disposition === 'RESTOCK' ? acceptedQty : 0;
        const nonSellableQty = (disposition && disposition !== 'RESTOCK') ? acceptedQty : 0;
        await conn.query(
          `UPDATE sales_return_items
             SET disposition_type=?, return_to_stock_qty=?, non_sellable_qty=?, decided_by=?, decided_at=NOW(),
                 disposition_reason_note=?
           WHERE id=?`,
          [disposition, restockQty, nonSellableQty, user?.id || null, dispositionReasonNote, itemId]
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

  // P1-01A (CTO review correction) — shared finalization-state resolver for
  // complete()/reject(), the single source of the "is every line fully
  // classified" / "total accepted quantity" formulas (do not duplicate them
  // per-caller). Called AFTER the caller's own header FOR UPDATE + status
  // check, and itself:
  //   1. Locks every return line (ascending id — same lock-ordering
  //      discipline as create()'s item loop and
  //      InventoryService.reverseOrderInventory()) — FIX1 step 1 / FIX2
  //      step 2.
  //   2. Resolves each line's LATEST inspection result. accepted_qty/
  //      rejected_qty are never persisted on sales_return_items itself (only
  //      the derived return_to_stock_qty/non_sellable_qty split is) — the
  //      append-only sales_return_inspections table is the only place
  //      rejected_qty lives at all, so this MUST read from there, not from
  //      sales_return_items — FIX1 step 2.
  //   3. Rejects (RETURN_INSPECTION_INCOMPLETE) unless accepted_qty +
  //      rejected_qty equals quantity_received for every line, within
  //      QTY_TOLERANCE. A line that was never received (quantity_received=0)
  //      and never inspected trivially satisfies this (0+0=0) — inspection
  //      drafts may stay partial while INSPECTING; only terminal actions
  //      require full classification — FIX1 step 3 / FIX3.
  //   4. Returns the locked items (for complete()'s stock-posting loop) and
  //      totalAccepted, the document-level sum used by both callers'
  //      opposite-direction guards — FIX1 step 4 / FIX2 step 4.
  async _resolveFinalization(conn, returnId) {
    const [items] = await conn.query(
      `SELECT id, product_id, quantity_received, disposition_type, return_to_stock_qty, non_sellable_qty, frozen_unit_price
       FROM sales_return_items WHERE return_id=? ORDER BY id ASC FOR UPDATE`,
      [returnId]
    );
    if (!items.length) throw badRequest('Yêu cầu trả hàng không có dòng hàng nào');

    const itemIds = items.map(it => it.id);
    const placeholders = itemIds.map(() => '?').join(',');
    // Same MAX(id)-per-group "latest inspection" join complete() already used
    // for its is_final update — reused here as the read, before that write.
    const [latestRows] = await conn.query(
      `SELECT i.* FROM sales_return_inspections i
       JOIN (
         SELECT return_item_id, MAX(id) max_id FROM sales_return_inspections
         WHERE return_item_id IN (${placeholders})
         GROUP BY return_item_id
       ) latest ON latest.return_item_id = i.return_item_id AND latest.max_id = i.id`,
      itemIds
    );
    const latestByItem = new Map(latestRows.map(r => [Number(r.return_item_id), r]));

    let totalAccepted = 0;
    for (const item of items) {
      const received = Number(item.quantity_received || 0);
      const latest = latestByItem.get(item.id);
      const accepted = latest ? Number(latest.accepted_qty || 0) : 0;
      const rejected = latest ? Number(latest.rejected_qty || 0) : 0;
      if (Math.abs((accepted + rejected) - received) > QTY_TOLERANCE) {
        throw badRequest(
          'Cần phân loại đầy đủ số lượng đã nhận của tất cả mặt hàng.',
          'RETURN_INSPECTION_INCOMPLETE'
        );
      }
      totalAccepted += accepted;
    }

    return { items, latestByItem, totalAccepted };
  }

  // POST /api/sales-returns/:id/complete — INSPECTING -> COMPLETED (S9.4 locked
  // rule #5): the ONLY transition in this whole agent that ever writes to
  // stock_transactions, and only for the RESTOCK-dispositioned qty of each
  // line, via InventoryService.in() (the same shared IN-movement primitive
  // every other inventory-increasing caller in this codebase uses — reference
  // reference_type='SALES_RETURN', reference_id=returnId, mirroring how
  // reference_id already means "the header id, not the line id" for
  // reference_type='SALE' elsewhere in this file).
  //
  // P1-01A (CTO review correction, locked document outcome rule): Complete
  // now additionally requires total accepted_qty > 0 across the whole
  // document (RETURN_NOTHING_ACCEPTED otherwise) — a return where nothing was
  // accepted belongs on the Reject path. Full-classification is enforced by
  // _resolveFinalization() before any stock movement below.
  //
  // Idempotency audit (CTO review ask): retrying complete() on an
  // already-COMPLETED return is already blocked by the status !==
  // STATUS_INSPECTING check immediately below, evaluated under the SAME
  // FOR UPDATE row lock acquired at the top of this method's transaction —
  // by the time a retry's SELECT ... FOR UPDATE returns, the first call's
  // commit (which flipped status to COMPLETED) has either already landed
  // (retry sees COMPLETED, throws RETURN_INVALID_STATE, never reaches
  // InventoryService.in()) or is still in-flight (retry blocks on the lock
  // until it commits, then sees COMPLETED). No separate idempotency key is
  // needed on top of this — the status transition IS the single-use gate,
  // same pattern as receive()'s PENDING->RECEIVED guard in
  // InventoryReceiveService.js. No code change required for this; documented
  // here as the audit's conclusion.
  async complete(returnId, user = {}) {
    returnId = Number(returnId);
    if (!returnId) throw badRequest('Thiếu mã yêu cầu trả hàng');

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[row]] = await conn.query(
        `SELECT id, status, customer_id, return_code, order_id FROM sales_returns WHERE id=? FOR UPDATE`, [returnId]
      );
      if (!row) throw notFound('Không tìm thấy yêu cầu trả hàng');
      await assertCustomerScope(user, row.customer_id);
      if (row.status !== STATUS_INSPECTING) {
        throw badRequest(`Không thể hoàn tất, yêu cầu đang ở trạng thái ${row.status}`, 'RETURN_INVALID_STATE');
      }

      // Locks items, resolves latest inspection per line, refuses
      // (RETURN_INSPECTION_INCOMPLETE) unless fully classified — before any
      // stock movement.
      const { items, totalAccepted } = await this._resolveFinalization(conn, returnId);

      if (totalAccepted <= QTY_TOLERANCE) {
        throw badRequest(
          'Không có số lượng nào được chấp nhận; hãy từ chối phiếu trả hàng thay vì hoàn tất.',
          'RETURN_NOTHING_ACCEPTED'
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

      // GO-LIVE F-RETURN-DEBT: reverse the customer's debt for whatever
      // quantity the shop actually took back into custody on this return
      // (RESTOCK + PROCESS + SCRAP dispositions — return_to_stock_qty +
      // non_sellable_qty on each line; rejected_qty is excluded on purpose,
      // the customer kept those units and still owes for them). Price basis
      // is sales_return_items.frozen_unit_price — the ORIGINAL sale price
      // frozen at return-request time, never re-resolved (BR-BILL-004/
      // BR-PRICE-002: historical price is immutable).
      //
      // Orders row is locked LAST, after the return-items/product locks
      // already taken above, matching OrderAgent.updateItem()'s existing
      // lock order (order_items -> products -> orders) so this never becomes
      // a new deadlock class against that path.
      //
      // Capped at the order's CURRENT debt_amount, not the full computed
      // amount: this codebase's own reconciliation invariant (verified by
      // verify-order-cancel-reversal.js S13 — SUM(debt_transactions) per
      // customer must equal SUM(orders.debt_amount) across non-cancelled
      // orders) would break if a debt_transactions row exceeded what the
      // order's own debt_amount can absorb. A return completed against an
      // ALREADY fully-paid bill therefore does not auto-create a refund/
      // credit — reversal_computed vs reversal_applied in the response
      // surfaces that shortfall instead of silently dropping it; refund/
      // credit-note handling is a separate, not-yet-built feature (no
      // credit-note mechanism exists anywhere in this codebase yet).
      let reversalComputed = 0;
      for (const item of items) {
        const acceptedForDebt = Number(item.return_to_stock_qty || 0) + Number(item.non_sellable_qty || 0);
        if (acceptedForDebt > 0) reversalComputed += acceptedForDebt * Number(item.frozen_unit_price || 0);
      }
      const debtReversal = { reversal_computed: reversalComputed, reversal_applied: 0, order_id: row.order_id || null };
      if (reversalComputed > QTY_TOLERANCE && row.order_id) {
        const [[orderRow]] = await conn.query(
          `SELECT id, customer_id, debt_amount, paid_amount FROM orders WHERE id=? FOR UPDATE`,
          [row.order_id]
        );
        if (orderRow) {
          const currentDebt = Number(orderRow.debt_amount || 0);
          const actualReversal = Math.min(reversalComputed, currentDebt);
          if (actualReversal > 0.001) {
            const newDebtAmount = Math.max(0, currentDebt - actualReversal);
            const newPaymentStatus = newDebtAmount <= 0.001
              ? (Number(orderRow.paid_amount || 0) > 0 ? 'PAID' : 'UNPAID')
              : 'PARTIAL';
            await conn.query(
              `UPDATE orders SET debt_amount=?, payment_status=? WHERE id=?`,
              [newDebtAmount, newPaymentStatus, row.order_id]
            );
            await conn.query(
              `INSERT INTO debt_transactions(customer_id,order_id,transaction_date,type,amount,note,created_by)
               VALUES(?,?,?,'ADJUSTMENT_DECREASE',?,?,?)`,
              [orderRow.customer_id, row.order_id, new Date().toISOString().slice(0, 10), actualReversal,
               `Đảo công nợ do trả hàng ${row.return_code || returnId} cho bill #${row.order_id}`, user?.id || null]
            );
            debtReversal.reversal_applied = actualReversal;
          }
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
      await writeAuditLog(conn, user?.id, 'SALES_RETURN_COMPLETED', returnId,
        `Hoàn tất trả hàng ${row.return_code || ''}`.trim() +
        (debtReversal.reversal_computed > QTY_TOLERANCE
          ? ` | Đảo công nợ: ${debtReversal.reversal_applied}/${debtReversal.reversal_computed}`
          : ''));

      await conn.commit();
      return {
        message: 'Đã hoàn tất yêu cầu trả hàng', return_id: returnId, status: STATUS_COMPLETED,
        stock: stockResults, debt_reversal: debtReversal,
      };
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  // POST /api/sales-returns/:id/reject — INSPECTING -> REJECTED (S9.4 locked
  // rule #5/#6 combined): a terminal outcome with ZERO inventory effect
  // always — inventory only ever moves on the COMPLETED path via
  // InventoryService.in() in complete(); nothing in this method touches
  // stock_transactions. No payment/refund/debt effect either (out of scope
  // for this story). Reason required, same discipline as cancel().
  //
  // P1-01A (CTO review correction, locked document outcome rule): Reject is
  // now valid ONLY when total accepted_qty across the whole document equals
  // zero (RETURN_HAS_ACCEPTED_QUANTITY otherwise) — the mirror image of
  // complete()'s RETURN_NOTHING_ACCEPTED guard. A return with any accepted
  // quantity must go through Complete instead. Full-classification is
  // enforced by _resolveFinalization() before this status change, same as
  // complete().
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

      // Same completeness guard as complete(); no stock movement on this path
      // regardless of the outcome.
      const { totalAccepted } = await this._resolveFinalization(conn, returnId);
      if (totalAccepted > QTY_TOLERANCE) {
        throw badRequest(
          'Phiếu có hàng đã được chấp nhận; phải hoàn tất phiếu thay vì từ chối.',
          'RETURN_HAS_ACCEPTED_QUANTITY'
        );
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
