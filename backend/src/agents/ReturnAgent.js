'use strict';
const pool = require('../config/db');
const { nextCode } = require('../utils/code');
const { assertCustomerScope } = require('../middleware/scope');

// ReturnAgent — S9.2 Sales Return Foundation (refined per S9.2A CTO review).
//
// Scope: Create Return Request + list only. No inventory, no debt, no payment,
// no inspection/disposition business logic — those are later stories (S9.4
// Warehouse Receive/Inspection, S9.5 Disposition/Complete/Reject).
//
// Immutability: this agent NEVER writes to orders, order_items,
// stock_transactions, debt_transactions, or payments. It only INSERTs into
// sales_returns / sales_return_items. Every read of orders/order_items below is
// SELECT-only (including the FOR UPDATE reads — a row lock is not a write).
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

        // Remaining-quantity check: live SUM over sales_return_items, not a cache
        // column (order_items.returned_quantity was deliberately not added — CTO
        // directive). Runs inside the same transaction, under the FOR UPDATE lock
        // above, so it also sees this request's own earlier inserts if the same
        // order_item_id appears more than once in one payload.
        const [[alreadyRow]] = await conn.query(
          `SELECT COALESCE(SUM(quantity_requested),0) already
           FROM sales_return_items WHERE order_item_id=?`, [orderItemId]
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

  // GET /api/orders/:id/returns — header + lines. No inventory, no financial
  // data — read-only, sales-return tables only. `inspections` on each item is a
  // static empty array (S9.2A Decision #5: sales_return_inspections table was
  // removed — nothing in S9.2 ever wrote to it, so it was future-story schema,
  // not S9.2's). The field name is kept in the response shape so S9.4 can start
  // populating it without an API contract change.
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

    const itemsByReturn = new Map();
    for (const it of items) {
      const list = itemsByReturn.get(it.return_id) || [];
      list.push({ ...it, inspections: [] });
      itemsByReturn.set(it.return_id, list);
    }

    return {
      order_id: orderId,
      returns: returns.map(r => ({ ...r, items: itemsByReturn.get(r.id) || [] })),
    };
  }
}

module.exports = new ReturnAgent();
