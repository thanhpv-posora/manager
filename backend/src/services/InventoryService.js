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
//   InventoryService.applyOrderInventory() — S5.1-A: CARCASS_PART/allow_negative_stock/TRACK_STOCK
//                                           branches now delegate their write to postOut(), making
//                                           it the single writer of OUT movements. NON_STOCK still
//                                           performs no write here (unchanged) — postOut() always
//                                           logs a row even for NON_STOCK, so delegating that branch
//                                           too would add a stock_transactions row that doesn't
//                                           exist today. Left as-is to avoid a behavior change;
//                                           revisit in a dedicated ticket if that gap should close.
//
// S6.2: the mode/allow_negative_stock decisions in adjustOrderItem() and
// applyOrderInventory() below — previously duplicated inline conditionals,
// separate from (but equivalent to) InventoryMovementService's own — now come
// from the same InventoryPolicyResolver.resolve() used by postIn/postOut.
// Branch structure and every observable outcome are unchanged; only where the
// mode/allow_negative_stock decision is computed changed.

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
   * Only applies to TRACK_STOCK products.
   * NON_STOCK / CARCASS_PART / allow_negative_stock → no-op (unchanged).
   */
  async adjustOrderItem(conn, productId, oldQty, newQty) {
    const [rows] = await conn.query(
      `SELECT inventory_mode, allow_negative_stock FROM products WHERE id = ?`,
      [productId]
    );
    // S6.2: identical shape to postOut's skip gate — a product skips real balance
    // tracking here for exactly the same reasons it skips the stock-sufficiency
    // check in postOut (NON_STOCK/CARCASS_PART mode, or allow_negative_stock).
    // resolve({}) when the product row is missing normalizes to NON_STOCK, so a
    // missing productId silently no-ops here — unchanged from the original
    // `rows[0]?.inventory_mode` optional-chaining behavior.
    const policy = InventoryPolicyResolver.resolve(rows[0] || {});
    if (!policy.needStockCheck) return;

    const delta = normalizeNumber(Math.abs(newQty - oldQty));
    if (delta < 0.001) return; // no meaningful change

    const note = `Điều chỉnh dòng đơn hàng (trước: ${oldQty}, sau: ${newQty})`;

    if (newQty > oldQty) {
      // More quantity sold → more stock consumed → balance decreases
      await InventoryMovementService.postAdjustmentDecrease(conn, productId, delta, new Date(), 'MANUAL', null, note, null);
    } else {
      // Less quantity sold → stock returned → balance increases
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
   * stock_checked=0 means it never did (CARCASS_PART / NON_STOCK / allow_negative_stock
   * at the time of sale), matching the Bò Xô rule: never add stock back for a line
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
  // CARCASS_PART / allow_negative_stock / TRACK_STOCK: the actual stock_quantity
  // UPDATE and stock_transactions INSERT now happen inside postOut(), the single
  // writer of OUT movements shared with Manual POS (InventoryService.out()).

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

      // CARCASS_PART or allow_negative_stock: log movement, skip balance update.
      // (mode is guaranteed not NON_STOCK here, so !needStockCheck can only mean
      // CARCASS_PART or allow_negative_stock — same set postOut's skip gate covers.)
      if (!policy.needStockCheck) {
        await InventoryMovementService.postOut(
          conn, p.id, qty, orderDate || new Date(), 'SALE', orderId,
          mode === 'CARCASS_PART' ? 'AI sale from carcass part' : 'AI sale stock deduct',
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
