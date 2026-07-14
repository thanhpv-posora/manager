'use strict';
const InventoryPolicyResolver = require('./InventoryPolicyResolver');
const { formatQty } = require('../utils/quantityFormat');

// InventoryMovementService — INV-004, S6.1
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
// S6.1: the inline mode/allow_negative_stock branching that used to decide
// skipBalance (postIn) / skipStockCheck (postOut) now comes from
// InventoryPolicyResolver.resolve() — same decision, extracted to a named,
// independently-testable object. This file still owns every read/write; the
// resolver only answers the policy question.
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
    const policy = InventoryPolicyResolver.resolve(p);
    const mode = policy.mode;
    const qty = normalizeNumber(quantity);
    if (qty <= 0) return { stock_added: false, inventory_mode: mode, qty_added: 0 };

    if (warehouseId) {
      const [wRows] = await conn.query(
        `SELECT id FROM warehouses WHERE id = ? AND is_active = 1`,
        [warehouseId]
      );
      if (!wRows.length) throw new Error('Không tìm thấy kho hàng');
    }

    // S5.2-C: affect_stock is decided here, at write time, and stored on the
    // row — StockLedgerAgent reads it back verbatim rather than re-deriving
    // it later from whatever the product looks like today.
    const skipBalance = !policy.affectBalance;

    // S5.1-C hardening: insert-first instead of check-then-act. The prior
    // SELECT-then-INSERT guard left a race window where two concurrent
    // postIn() calls for the same (product_id, reference_id) could both pass
    // the SELECT before either INSERT committed, doubling stock. Duplicate
    // detection now relies on stock_transactions.receive_dedup_key — a
    // generated column (bootstrap.js) that is non-NULL only for
    // RECEIVE_VOUCHER+IN rows and is enforced UNIQUE at the DB level, so
    // MySQL rejects the second concurrent INSERT atomically. Balance update
    // happens only after the INSERT succeeds, so a rejected duplicate never
    // touches stock_quantity.
    try {
      await conn.query(
        `INSERT INTO stock_transactions
           (product_id, transaction_date, type, quantity, reference_type, reference_id, note, created_by, warehouse_id, affect_stock)
         VALUES (?, ?, 'IN', ?, ?, ?, ?, ?, ?, ?)`,
        [productId, date || new Date(), qty, refType || 'MANUAL', refId || null, note || null, userId || null, warehouseId || null, skipBalance ? 0 : 1]
      );
    } catch (e) {
      const isDupReceiveKey = e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062) &&
        /receive_dedup/i.test(e.sqlMessage || e.message || '');
      if (isDupReceiveKey) {
        throw new Error('Phiếu nhận hàng này đã được ghi nhận tồn kho cho sản phẩm này, không thể ghi trùng');
      }
      throw e;
    }

    if (!skipBalance) {
      await conn.query(
        `UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ?`,
        [qty, productId]
      );
    }
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
    // S5.1-B: FOR UPDATE closes the check-then-act race where two concurrent
    // sales of the same product both read stock as sufficient before either
    // commits. Safe because every caller already runs this inside a
    // transaction on a dedicated connection; the lock releases at commit/rollback.
    const [rows] = await conn.query(
      `SELECT id, name, inventory_mode, stock_quantity, allow_negative_stock
       FROM products WHERE id = ? AND del_flg = 0
       FOR UPDATE`,
      [productId]
    );
    if (!rows.length) throw new Error('Không tìm thấy mặt hàng');
    const p = rows[0];
    const policy = InventoryPolicyResolver.resolve(p);
    const mode = policy.mode;
    const qty = Number(quantity || 0);

    // S5.2-C: affect_stock is decided here, at write time, and stored on the
    // row — StockLedgerAgent reads it back verbatim rather than re-deriving
    // it later from whatever the product looks like today.
    const skipStockCheck = !policy.needStockCheck;
    if (skipStockCheck) {
      await conn.query(
        `INSERT INTO stock_transactions
           (product_id, transaction_date, type, quantity, reference_type, reference_id, note, created_by, affect_stock)
         VALUES (?, ?, 'OUT', ?, ?, ?, ?, ?, 0)`,
        [productId, date, qty, refType, refId, `${note} / SKIP_STOCK_CHECK / ${mode}`, userId]
      );
      return { stock_checked: false, inventory_mode: mode };
    }

    if (Number(p.stock_quantity) < qty) {
      throw new Error(
        `Không đủ tồn kho cho "${p.name}". Tồn hiện tại: ${formatQty(p.stock_quantity)}, cần xuất: ${formatQty(qty)}.` +
        ` Nếu đây là hàng bò xô/pha lóc, vào Mặt hàng / sửa giá đổi mode sang CARCASS_PART hoặc bật Cho phép không kiểm tồn.`
      );
    }

    await conn.query(`UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?`, [qty, productId]);
    await conn.query(
      `INSERT INTO stock_transactions
         (product_id, transaction_date, type, quantity, reference_type, reference_id, note, created_by, affect_stock)
       VALUES (?, ?, 'OUT', ?, ?, ?, ?, ?, 1)`,
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
         (product_id, transaction_date, type, quantity, reference_type, reference_id, note, created_by, affect_stock)
       VALUES (?, ?, 'ADJUSTMENT_INCREASE', ?, ?, ?, ?, ?, 1)`,
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
         (product_id, transaction_date, type, quantity, reference_type, reference_id, note, created_by, affect_stock)
       VALUES (?, ?, 'ADJUSTMENT_DECREASE', ?, ?, ?, ?, ?, 1)`,
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
         (product_id, transaction_date, type, quantity, reference_type, reference_id, note, created_by, affect_stock)
       VALUES (?, ?, 'IN', ?, 'OPENING_BALANCE', NULL, ?, ?, 1)`,
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
