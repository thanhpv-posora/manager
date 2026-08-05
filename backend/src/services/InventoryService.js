'use strict';
const InventoryMovementService = require('./InventoryMovementService');
const InventoryPolicyResolver = require('./InventoryPolicyResolver');

// InventoryService — INV-004, S6.2
//
// Thin wrapper over InventoryMovementService.
// Preserves the existing call surface so all callers need no changes.
//
// Call graph after INV-004:
//   InventoryService.in()             → InventoryMovementService.postIn()
//   InventoryService.out()            → InventoryMovementService.postOut()
//   InventoryService.adjustOrderItem()→ InventoryMovementService.postAdjustmentIncrease/Decrease()
//   InventoryService.applyOrderInventory() — S5.1-A: allow_negative_stock/TRACK_STOCK
//                                           branches now delegate their write to postOut(), making
//                                           it the single writer of OUT movements. NON_STOCK still
//                                           performs no write here (unchanged) — postOut() always
//                                           logs a row even for NON_STOCK, so delegating that branch
//                                           too would add a stock_transactions row that doesn't
//                                           exist today. Left as-is to avoid a behavior change;
//                                           revisit in a dedicated ticket if that gap should close.
//
// S6.2: the mode/allow_negative_stock decision in applyOrderInventory()
// below — previously a duplicated inline conditional, separate from (but
// equivalent to) InventoryMovementService's own — comes from the same
// InventoryPolicyResolver.resolve() used by postIn/postOut. Branch structure
// and every observable outcome are unchanged; only where the mode/
// allow_negative_stock decision is computed changed.
//
// P0-001: adjustOrderItem() no longer uses InventoryPolicyResolver at all —
// it now takes the caller-supplied, FROZEN order_items.stock_checked fact
// instead of re-deriving from the product's current settings. See that
// method's own doc comment for why.

function normalizeNumber(value) {
  const v = Number(value || 0);
  return Number.isFinite(v) ? v : 0;
}

class InventoryService {

  // ── Delegating wrappers ───────────────────────────────────────────────────────

  async in(conn, productId, quantity, date, refType, refId, note, userId, warehouseId) {
    return InventoryMovementService.postIn(conn, productId, quantity, date, refType, refId, note, userId, warehouseId);
  }

  async out(conn, productId, quantity, date, refType, refId, note, userId) {
    return InventoryMovementService.postOut(conn, productId, quantity, date, refType, refId, note, userId);
  }

  async opening(conn, productId, quantity, date, note, userId) {
    return InventoryMovementService.postOpening(conn, productId, quantity, date, note, userId);
  }

  /**
   * Adjust stock when an order item's quantity changes.
   *
   * Before INV-004: silently modified stock_quantity with no stock_transactions entry.
   * After  INV-004: emits ADJUSTMENT_INCREASE or ADJUSTMENT_DECREASE — audit trail restored.
   *
   * P0-001 root-cause fix: whether this line affects the balance at all is now
   * decided by the FROZEN order_items.stock_checked fact the caller passes in
   * (recorded at original sale/edit time by postOut()'s own return value) —
   * NEVER re-derived from the product's CURRENT inventory_mode/
   * allow_negative_stock. This is the exact same historical-fact discipline
   * reverseOrderInventory() already documents and enforces: a product's mode
   * can be reconfigured after the sale, and re-deriving from today's settings
   * would silently start/stop balance-tracking a line based on a fact that
   * was never true at sale time. Callers must pass the order_items row's own
   * stock_checked value (already read under FOR UPDATE by OrderAgent.updateItem()).
   *
   * @param {number} stockChecked — order_items.stock_checked (0 or 1), frozen at sale time.
   */
  async adjustOrderItem(conn, productId, oldQty, newQty, stockChecked) {
    if (Number(stockChecked) !== 1) return;

    const delta = normalizeNumber(Math.abs(newQty - oldQty));
    if (delta < 0.001) return; // no meaningful change

    const note = `Điều chỉnh dòng đơn hàng (trước: ${oldQty}, sau: ${newQty})`;

    if (newQty > oldQty) {
      // More quantity sold → more stock consumed → balance decreases.
      // P0-001: lock + sufficiency pre-check here so the order-editing path
      // surfaces its own stable code/message; postAdjustmentDecrease() below
      // still holds its own internal FOR UPDATE + backstop check (same
      // pre-check-in-caller / guard-in-primitive split applyOrderInventory()
      // → postOut() already uses), so a race between this read and the
      // actual write can never let a negative balance through even if this
      // read goes stale.
      const [[p]] = await conn.query(
        `SELECT id, name, stock_quantity FROM products WHERE id = ? AND del_flg = 0 FOR UPDATE`,
        [productId]
      );
      if (!p) throw new Error('Không tìm thấy mặt hàng');
      if (Number(p.stock_quantity) < delta) {
        throw Object.assign(
          new Error('Không đủ tồn kho để tăng số lượng mặt hàng trong bill.'),
          { status: 400, code: 'INSUFFICIENT_STOCK' }
        );
      }
      await InventoryMovementService.postAdjustmentDecrease(conn, productId, delta, new Date(), 'MANUAL', null, note, null);
    } else {
      // Less quantity sold → stock returned → balance increases. Can never
      // drive stock negative — unchanged.
      await InventoryMovementService.postAdjustmentIncrease(conn, productId, delta, new Date(), 'MANUAL', null, note, null);
    }
  }

  /**
   * S8.2 — Reverse the inventory effect of every line on a cancelled order.
   *
   * Historical-fact only: the decision to reverse a line comes from
   * order_items.stock_checked (frozen at write time by postOut's return value),
   * NEVER from the product's current inventory_mode/allow_negative_stock — those
   * may have been reconfigured after the sale. stock_checked=1 is the only
   * reliable record that a line's OUT actually decremented products.stock_quantity;
   * stock_checked=0 means it never did (NON_STOCK / allow_negative_stock
   * at the time of sale, or a legacy CARCASS_PART-classified line — same
   * semantics as NON_STOCK), matching the Bò Xô rule: never add stock back for a line
   * that never took stock away, regardless of what the product looks like today.
   *
   * Reuses the same primitive adjustOrderItem() already uses for "quantity
   * decreased, stock returned" (postAdjustmentIncrease) — cancelling is exactly
   * that case carried to its conclusion (effective quantity -> 0). No new
   * stock_transactions.type/reference_type value is introduced: reference_type
   * stays 'SALE' (schema-safe, already valid) and reference_id=orderId so the
   * reversal is clearly traceable to the cancelled order; type='ADJUSTMENT_INCREASE'
   * is the existing "balance corrected upward" semantic, distinguished from the
   * original OUT row by its type + note text, not a dedicated enum value.
   *
   * Lines are processed in ascending product_id order (deterministic) to avoid
   * lock-ordering deadlocks against any other transaction touching the same
   * products, matching postOut()'s FOR UPDATE convention.
   *
   * @returns {Array<{product_id:number, action:'REVERSED'|'NO_REVERSAL', qty?:number, reason?:string}>}
   */
  async reverseOrderInventory(conn, orderId, userId, reasonNote) {
    const [items] = await conn.query(
      `SELECT product_id, quantity, inventory_mode, stock_checked
       FROM order_items WHERE order_id=? ORDER BY product_id ASC`,
      [orderId]
    );
    const results = [];
    for (const item of items) {
      const qty = normalizeNumber(item.quantity);
      if (qty <= 0) continue;
      if (Number(item.stock_checked) !== 1) {
        results.push({
          product_id: item.product_id, action: 'NO_REVERSAL',
          reason: `stock_checked=0 at sale time (inventory_mode was ${item.inventory_mode || 'unknown'}) — balance was never affected, so nothing to reverse`
        });
        continue;
      }
      await InventoryMovementService.postAdjustmentIncrease(
        conn, item.product_id, qty, new Date(), 'SALE', orderId,
        reasonNote || `Hoàn tồn kho do hủy bill #${orderId}`, userId
      );
      results.push({ product_id: item.product_id, action: 'REVERSED', qty });
    }
    return results;
  }

  // ── applyOrderInventory — mode branching stays here; writes delegate to postOut() ──
  //
  // NON_STOCK: no write (unchanged — see call-graph note above).
  // allow_negative_stock / TRACK_STOCK: the actual stock_quantity UPDATE and
  // stock_transactions INSERT now happen inside postOut(), the single writer
  // of OUT movements shared with Manual POS (InventoryService.out()).

  async applyOrderInventory(conn, orderId, items = [], options = {}) {
    const userId = options.user_id || null;
    const orderDate = options.order_date || null;
    const results = [];

    for (const item of items) {
      const [rows] = await conn.query(
        `SELECT id, name, stock_quantity, inventory_mode, allow_negative_stock
         FROM products WHERE id = ? AND del_flg = 0 LIMIT 1`,
        [item.product_id]
      );
      if (!rows.length) throw new Error(`Không tìm thấy sản phẩm ID=${item.product_id}`);

      const p = rows[0];
      const policy = InventoryPolicyResolver.resolve(p);
      const mode = policy.mode;
      const qty = normalizeNumber(item.quantity);
      const beforeQty = normalizeNumber(p.stock_quantity);

      if (mode === 'NON_STOCK') {
        results.push({ product_id: p.id, product_name: p.name, inventory_mode: mode, action: 'NO_STOCK_SKIP' });
        continue;
      }

      // allow_negative_stock: log movement, skip balance update. (mode is
      // guaranteed TRACK_STOCK here — NON_STOCK already returned above — so
      // !needStockCheck can only mean allow_negative_stock=1, the same case
      // postOut's skip gate covers.)
      if (!policy.needStockCheck) {
        await InventoryMovementService.postOut(
          conn, p.id, qty, orderDate || new Date(), 'SALE', orderId,
          'AI sale stock deduct',
          userId
        );
        results.push({
          product_id: p.id, product_name: p.name, inventory_mode: mode,
          action: 'SKIP_STOCK_CHECK',
          qty_before: beforeQty, qty_change: qty, qty_after: beforeQty - qty
        });
        continue;
      }

      // TRACK_STOCK: validate then atomically deduct via the single writer.
      // Pre-check here (same condition postOut() re-checks internally) so the
      // insufficient-stock error message stays byte-for-byte what callers already
      // expect from applyOrderInventory() — postOut()'s own message text differs.
      if (beforeQty < qty) {
        throw new Error(`Không đủ tồn kho ${p.name}. Tồn hiện tại: ${beforeQty}, cần bán: ${qty}`);
      }

      await InventoryMovementService.postOut(conn, p.id, qty, orderDate || new Date(), 'SALE', orderId, 'AI sale stock deduct', userId);

      results.push({
        product_id: p.id, product_name: p.name, inventory_mode: mode,
        action: 'OUT',
        qty_before: beforeQty, qty_change: qty, qty_after: beforeQty - qty
      });
    }

    return results;
  }
}

module.exports = new InventoryService();
