'use strict';
const InventoryMovementService = require('./InventoryMovementService');
const { normalizeInventoryMode } = require('../utils/inventoryMode');

// InventoryService — INV-004
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
    const mode = normalizeInventoryMode(rows[0]?.inventory_mode);
    if (mode === 'NON_STOCK' || mode === 'CARCASS_PART' || Number(rows[0]?.allow_negative_stock) === 1) return;

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
      const mode = normalizeInventoryMode(p.inventory_mode);
      const qty = normalizeNumber(item.quantity);
      const beforeQty = normalizeNumber(p.stock_quantity);
      const allowNeg = Number(p.allow_negative_stock || 0);

      if (mode === 'NON_STOCK') {
        results.push({ product_id: p.id, product_name: p.name, inventory_mode: mode, action: 'NO_STOCK_SKIP' });
        continue;
      }

      // CARCASS_PART or allow_negative_stock: log movement, skip balance update.
      if (mode === 'CARCASS_PART' || allowNeg === 1) {
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
