'use strict';
const { normalizeInventoryMode } = require('../utils/inventoryMode');

// InventoryMovementService — INV-004
//
// SOLE OWNER of all stock write primitives:
//   postIn()                → stock_quantity +qty  + stock_transactions type='IN'
//   postOut()               → stock_quantity −qty  + stock_transactions type='OUT'
//   postAdjustmentIncrease()→ stock_quantity +delta + type='ADJUSTMENT_INCREASE'
//   postAdjustmentDecrease()→ stock_quantity −delta + type='ADJUSTMENT_DECREASE'
//
// InventoryService is a thin wrapper — callers use InventoryService, not this class directly.
// All business rules live here. InventoryService preserves the call surface.
//
// Future movements (stubs below — implement in dedicated tickets):
//   postTransfer()  postReturn()  postOpening()  postReversal()

function normalizeNumber(value) {
  const v = Number(value || 0);
  return Number.isFinite(v) ? v : 0;
}

class InventoryMovementService {

  // ── IN ───────────────────────────────────────────────────────────────────────

  /**
   * Post a stock IN movement.
   *
   * TRACK_STOCK → UPDATE stock_quantity += qty, INSERT type='IN'
   * NON_STOCK / CARCASS_PART → INSERT type='IN' only (no balance update)
   *
   * @param {object} conn   — active MySQL connection (within a transaction)
   * @param {number} productId
   * @param {number} quantity
   * @param {string|Date} date
   * @param {string} refType  — ENUM('LOT','SALE','MANUAL','RECEIVE_VOUCHER')
   * @param {number|null} refId
   * @param {string|null} note
   * @param {number|null} userId
   * @param {number|null} warehouseId — S4.1-C. Optional and additive: when supplied
   *   (Receive Voucher always supplies it) it's validated to exist and recorded on
   *   the movement row. Omitted by callers that don't participate in warehouse
   *   tracking yet — behavior for them is unchanged.
   * @returns {{ stock_added: boolean, inventory_mode: string, qty_added: number }}
   */
  async postIn(conn, productId, quantity, date, refType, refId, note, userId, warehouseId = null) {
    const [rows] = await conn.query(
      `SELECT id, name, inventory_mode FROM products WHERE id = ? AND del_flg = 0`,
      [productId]
    );
    if (!rows.length) throw new Error('Không tìm thấy mặt hàng');
    const p = rows[0];
    const mode = normalizeInventoryMode(p.inventory_mode);
    const qty = normalizeNumber(quantity);
    if (qty <= 0) return { stock_added: false, inventory_mode: mode, qty_added: 0 };

    // S4.1-C hardening: idempotency guard against crash/retry duplicate posting
    // of a Receive Voucher. Scoped by product_id as well as reference_id —
    // one receive voucher posts one IN movement per product line, so the
    // natural duplicate key is (product_id, reference_type, reference_id, type).
    // InventoryReceiveService.receive() already guards this at the voucher
    // level (status must be PENDING), but InventoryMovementService is the
    // sole writer of stock_quantity and must not depend on callers getting
    // that right — this is the last line of defense before any write.
    if (refType === 'RECEIVE_VOUCHER' && refId) {
      const [dupRows] = await conn.query(
        `SELECT id FROM stock_transactions
         WHERE product_id = ? AND reference_type = 'RECEIVE_VOUCHER' AND reference_id = ? AND type = 'IN'
         LIMIT 1`,
        [productId, refId]
      );
      if (dupRows.length) {
        throw new Error('Phiếu nhận hàng này đã được ghi nhận tồn kho cho sản phẩm này, không thể ghi trùng');
      }
    }

    if (warehouseId) {
      const [wRows] = await conn.query(
        `SELECT id FROM warehouses WHERE id = ? AND is_active = 1`,
        [warehouseId]
      );
      if (!wRows.length) throw new Error('Không tìm thấy kho hàng');
    }

    const skipBalance = mode === 'NON_STOCK' || mode === 'CARCASS_PART';
    if (!skipBalance) {
      await conn.query(
        `UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ?`,
        [qty, productId]
      );
    }
    await conn.query(
      `INSERT INTO stock_transactions
         (product_id, transaction_date, type, quantity, reference_type, reference_id, note, created_by, warehouse_id)
       VALUES (?, ?, 'IN', ?, ?, ?, ?, ?, ?)`,
      [productId, date || new Date(), qty, refType || 'MANUAL', refId || null, note || null, userId || null, warehouseId || null]
    );
    return { stock_added: !skipBalance, inventory_mode: mode, qty_added: qty };
  }

  // ── OUT ──────────────────────────────────────────────────────────────────────

  /**
   * Post a stock OUT movement.
   *
   * NON_STOCK / CARCASS_PART / allow_negative_stock → INSERT type='OUT', no balance check
   * TRACK_STOCK → validate stock >= qty, UPDATE stock_quantity −= qty, INSERT type='OUT'
   *
   * @param {object} conn
   * @param {number} productId
   * @param {number} quantity
   * @param {string|Date} date
   * @param {string} refType
   * @param {number|null} refId
   * @param {string|null} note
   * @param {number|null} userId
   * @returns {{ stock_checked: boolean, inventory_mode: string }}
   */
  async postOut(conn, productId, quantity, date, refType, refId, note, userId) {
    const [rows] = await conn.query(
      `SELECT id, name, inventory_mode, stock_quantity, allow_negative_stock
       FROM products WHERE id = ? AND del_flg = 0`,
      [productId]
    );
    if (!rows.length) throw new Error('Không tìm thấy mặt hàng');
    const p = rows[0];
    const mode = p.inventory_mode || 'STOCK';
    const qty = Number(quantity || 0);

    const skipStockCheck = mode === 'NON_STOCK' || mode === 'CARCASS_PART' || Number(p.allow_negative_stock) === 1;
    if (skipStockCheck) {
      await conn.query(
        `INSERT INTO stock_transactions
           (product_id, transaction_date, type, quantity, reference_type, reference_id, note, created_by)
         VALUES (?, ?, 'OUT', ?, ?, ?, ?, ?)`,
        [productId, date, qty, refType, refId, `${note} / SKIP_STOCK_CHECK / ${mode}`, userId]
      );
      return { stock_checked: false, inventory_mode: mode };
    }

    if (Number(p.stock_quantity) < qty) {
      throw new Error(
        `Không đủ tồn kho cho "${p.name}". Tồn hiện tại: ${p.stock_quantity}, cần xuất: ${qty}.` +
        ` Nếu đây là hàng bò xô/pha lóc, vào Mặt hàng / sửa giá đổi mode sang CARCASS_PART hoặc bật Cho phép không kiểm tồn.`
      );
    }

    await conn.query(`UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?`, [qty, productId]);
    await conn.query(
      `INSERT INTO stock_transactions
         (product_id, transaction_date, type, quantity, reference_type, reference_id, note, created_by)
       VALUES (?, ?, 'OUT', ?, ?, ?, ?, ?)`,
      [productId, date, qty, refType, refId, note, userId]
    );
    return { stock_checked: true, inventory_mode: mode };
  }

  // ── ADJUSTMENT ───────────────────────────────────────────────────────────────

  /**
   * Post an ADJUSTMENT_INCREASE movement.
   *
   * Use when the running balance must increase for correction reasons
   * (e.g., order item quantity was reduced — stock is returned).
   *
   * Caller is responsible for product mode check.
   * Only call this for TRACK_STOCK products.
   *
   * @param {object} conn
   * @param {number} productId
   * @param {number} delta   — positive amount to add
   * @param {string|Date} date
   * @param {string} refType
   * @param {number|null} refId
   * @param {string|null} note
   * @param {number|null} userId
   */
  async postAdjustmentIncrease(conn, productId, delta, date, refType, refId, note, userId) {
    const d = normalizeNumber(delta);
    if (d <= 0) return;
    await conn.query(`UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ?`, [d, productId]);
    await conn.query(
      `INSERT INTO stock_transactions
         (product_id, transaction_date, type, quantity, reference_type, reference_id, note, created_by)
       VALUES (?, ?, 'ADJUSTMENT_INCREASE', ?, ?, ?, ?, ?)`,
      [productId, date || new Date(), d, refType || 'MANUAL', refId || null, note || null, userId || null]
    );
  }

  /**
   * Post an ADJUSTMENT_DECREASE movement.
   *
   * Use when the running balance must decrease for correction reasons
   * (e.g., order item quantity was increased — more stock is consumed).
   *
   * Caller is responsible for product mode check.
   * Only call this for TRACK_STOCK products.
   *
   * @param {object} conn
   * @param {number} productId
   * @param {number} delta   — positive amount to subtract
   * @param {string|Date} date
   * @param {string} refType
   * @param {number|null} refId
   * @param {string|null} note
   * @param {number|null} userId
   */
  async postAdjustmentDecrease(conn, productId, delta, date, refType, refId, note, userId) {
    const d = normalizeNumber(delta);
    if (d <= 0) return;
    await conn.query(`UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?`, [d, productId]);
    await conn.query(
      `INSERT INTO stock_transactions
         (product_id, transaction_date, type, quantity, reference_type, reference_id, note, created_by)
       VALUES (?, ?, 'ADJUSTMENT_DECREASE', ?, ?, ?, ?, ?)`,
      [productId, date || new Date(), d, refType || 'MANUAL', refId || null, note || null, userId || null]
    );
  }

  // ── Future movements (stubs) ──────────────────────────────────────────────────

  async postTransfer(conn, fromProductId, toProductId, qty, date, refType, refId, note, userId) {
    // TODO INV-TRANSFER: subtract from source location, add to target location,
    //   emit ADJUSTMENT_DECREASE + ADJUSTMENT_INCREASE (or a dedicated TRANSFER type).
    throw new Error('postTransfer not implemented — pending INV-TRANSFER ticket');
  }

  async postReturn(conn, productId, qty, date, refType, refId, note, userId) {
    // TODO INV-RETURN: handles customer return or supplier return.
    //   Customer return → IN with refType='RETURN'.
    //   Supplier return → OUT with refType='RETURN' (reverse receive).
    //   Requires RETURN to be added to stock_transactions.reference_type ENUM.
    throw new Error('postReturn not implemented — pending INV-RETURN ticket');
  }

  async postOpening(conn, productId, qty, date, note, userId) {
    const q = normalizeNumber(qty);
    if (q <= 0) throw new Error('Số lượng tồn ban đầu phải lớn hơn 0');
    await conn.query(
      `UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ?`,
      [q, productId]
    );
    await conn.query(
      `INSERT INTO stock_transactions
         (product_id, transaction_date, type, quantity, reference_type, reference_id, note, created_by)
       VALUES (?, ?, 'IN', ?, 'OPENING_BALANCE', NULL, ?, ?)`,
      [productId, date || new Date(), q, note || 'Tồn kho ban đầu', userId || null]
    );
  }

  async postReversal(conn, receiveVoucherId, userId) {
    // TODO INV-REVERSAL: reverse a RECEIVED inventory_receives voucher.
    //   Must: re-open receive voucher → CANCELLED_REVERSAL status,
    //   emit ADJUSTMENT_DECREASE for each item (reverse the IN),
    //   decrement purchase_order_items.received_quantity,
    //   recalculate purchase_orders.status.
    throw new Error('postReversal not implemented — pending INV-REVERSAL ticket');
  }
}

module.exports = new InventoryMovementService();
