'use strict';
const InventoryMovementService = require('./InventoryMovementService');

// InventoryService — INV-004
//
// Thin wrapper over InventoryMovementService.
// Preserves the existing call surface so all callers need no changes.
//
// Call graph after INV-004:
//   InventoryService.in()             → InventoryMovementService.postIn()
//   InventoryService.out()            → InventoryMovementService.postOut()
//   InventoryService.adjustOrderItem()→ InventoryMovementService.postAdjustmentIncrease/Decrease()
//   InventoryService.applyOrderInventory() — kept here; NON_STOCK skip behavior
//                                           differs from postOut(); refactor in future ticket.

function normalizeInventoryMode(value) {
  const mode = String(value || 'NON_STOCK').toUpperCase();
  if (mode === 'TRACK_STOCK' || mode === 'STOCK') return 'TRACK_STOCK';
  if (mode === 'CARCASS_PART') return 'CARCASS_PART';
  return 'NON_STOCK';
}

function normalizeNumber(value) {
  const v = Number(value || 0);
  return Number.isFinite(v) ? v : 0;
}

class InventoryService {

  // ── Delegating wrappers ───────────────────────────────────────────────────────

  async in(conn, productId, quantity, date, refType, refId, note, userId) {
    return InventoryMovementService.postIn(conn, productId, quantity, date, refType, refId, note, userId);
  }

  async out(conn, productId, quantity, date, refType, refId, note, userId) {
    return InventoryMovementService.postOut(conn, productId, quantity, date, refType, refId, note, userId);
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

  // ── applyOrderInventory — kept here; not delegated to postOut() yet ───────────
  //
  // Reason: NON_STOCK items are skipped entirely in this method (no log), whereas
  // postOut() logs them with SKIP_STOCK_CHECK. Delegating would silently change
  // behavior for NON_STOCK items. Deferred to a dedicated ticket.

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
        await conn.query(
          `INSERT INTO stock_transactions
             (product_id, transaction_date, type, quantity, reference_type, reference_id, note, created_by)
           VALUES (?, ?, 'OUT', ?, 'SALE', ?, ?, ?)`,
          [p.id, orderDate || new Date(), qty, orderId,
           mode === 'CARCASS_PART' ? 'AI sale from carcass part' : 'AI sale stock deduct',
           userId]
        );
        results.push({
          product_id: p.id, product_name: p.name, inventory_mode: mode,
          action: 'SKIP_STOCK_CHECK',
          qty_before: beforeQty, qty_change: qty, qty_after: beforeQty - qty
        });
        continue;
      }

      // TRACK_STOCK: validate then atomically deduct.
      if (beforeQty < qty) {
        throw new Error(`Không đủ tồn kho ${p.name}. Tồn hiện tại: ${beforeQty}, cần bán: ${qty}`);
      }

      await conn.query(
        `UPDATE products SET stock_quantity = stock_quantity - ?, updated_at = NOW() WHERE id = ?`,
        [qty, p.id]
      );
      await conn.query(
        `INSERT INTO stock_transactions
           (product_id, transaction_date, type, quantity, reference_type, reference_id, note, created_by)
         VALUES (?, ?, 'OUT', ?, 'SALE', ?, ?, ?)`,
        [p.id, orderDate || new Date(), qty, orderId, 'AI sale stock deduct', userId]
      );

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
