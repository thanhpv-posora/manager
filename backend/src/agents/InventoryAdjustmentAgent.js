'use strict';
const pool = require('../config/db');
const { nextCode } = require('../utils/code');
const InventoryMovementService = require('../services/InventoryMovementService');
const InventoryPolicyResolver = require('../services/InventoryPolicyResolver');
const { formatQty } = require('../utils/quantityFormat');

// InventoryAdjustmentAgent — S6.6 / S7.2
//
// Standalone Inventory Adjustment (Increase/Decrease + reason + remark),
// independent of Order Edit. Before S6.6, ADJUSTMENT_INCREASE/DECREASE ledger
// rows only ever existed as a side effect of InventoryService.adjustOrderItem
// (editing a bill line's quantity) — there was no way to record a warehouse
// event (broken/lost/expired/found/recount) on its own.
//
// Does NOT introduce a new stock writer: the actual balance change still goes
// through InventoryMovementService.postAdjustmentIncrease/postAdjustmentDecrease
// (untouched, S6.1/S6.2's single writer). This agent only adds the business
// context a bare 'MANUAL' reference could never carry — an adjustment_code, a
// reason, and a remark — via a header table (inventory_adjustments) and a
// dedicated reference_type='ADJUSTMENT'.
//
// S7.2: createBatch() is an Excel-style bulk save — ONE HTTP request, ONE DB
// transaction, looping the SAME per-item validate+write logic create() already
// uses (_applyOneAdjustment) once per changed row. Deliberately NOT a new
// document model: no batch header table, no grouping id. Each row still lands
// in the existing inventory_adjustments table exactly like a standalone
// create() would — the only difference is many rows commit together instead
// of one HTTP round trip each. If a future "Inventory Count Document" feature
// is ever wanted, that's a separate, deliberate addition — not implied here.
//
// No warehouse, no reversal, no multi-warehouse — matches Bò Xô's single
// implicit balance per product, same as every other write path in this domain.

const VALID_REASONS = ['BROKEN', 'LOST', 'EXPIRED', 'FOUND', 'STOCK_COUNT', 'OTHER'];
const REASON_LABEL = {
  BROKEN: 'Hỏng/Vỡ',
  LOST: 'Mất hàng',
  EXPIRED: 'Hết hạn',
  FOUND: 'Tìm thấy thừa',
  STOCK_COUNT: 'Kiểm kê',
  OTHER: 'Khác',
};
const ZERO_TOLERANCE = 0.001; // matches the existing inline convention used elsewhere (S6.3/InventoryReceiveService)

class InventoryAdjustmentAgent {
  constructor() {
    this.version = '1.1.0';
    this.responsibility = 'S6.6/S7.2 — standalone Inventory Adjustment (single or bulk Excel-style stock count), independent of Order Edit.';
  }

  // Shared per-item validate + write, used by both create() (single) and
  // createBatch() (bulk — looped, same checks, same table, no grouping id).
  // Caller owns the transaction and the FOR UPDATE row lock ordering.
  async _applyOneAdjustment(conn, { productId, direction, quantity, reason, remark, user }) {
    const [[product]] = await conn.query(
      `SELECT id, name, stock_quantity, inventory_mode, allow_negative_stock
       FROM products WHERE id = ? AND del_flg = 0 FOR UPDATE`,
      [productId]
    );
    if (!product) throw Object.assign(new Error(`Không tìm thấy mặt hàng ID=${productId}`), { status: 404 });

    const policy = InventoryPolicyResolver.resolve(product);
    if (!policy.affectBalance) {
      throw Object.assign(
        new Error(`Mặt hàng "${product.name}" không quản lý tồn kho (chế độ ${policy.mode}), không thể điều chỉnh tồn kho.`),
        { status: 400 }
      );
    }

    if (direction === 'DECREASE' && !policy.allowNegative) {
      const current = Number(product.stock_quantity || 0);
      if (current < quantity) {
        throw Object.assign(
          new Error(`Không đủ tồn kho "${product.name}" để giảm. Tồn hiện tại: ${formatQty(current)}, cần giảm: ${formatQty(quantity)}.`),
          { status: 400 }
        );
      }
    }

    const adjustmentCode = await nextCode(conn, 'inventory_adjustments', 'adjustment_code', 'ADJ');
    const [header] = await conn.query(
      `INSERT INTO inventory_adjustments(adjustment_code, product_id, direction, quantity, reason, remark, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [adjustmentCode, productId, direction, quantity, reason, remark, user?.id || null]
    );
    const adjustmentId = header.insertId;

    const note = `Điều chỉnh ${direction === 'INCREASE' ? 'tăng' : 'giảm'} tồn kho — ${REASON_LABEL[reason]}${remark ? ': ' + remark : ''} (Phiếu ${adjustmentCode})`;
    if (direction === 'INCREASE') {
      await InventoryMovementService.postAdjustmentIncrease(conn, productId, quantity, new Date(), 'ADJUSTMENT', adjustmentId, note, user?.id || null);
    } else {
      await InventoryMovementService.postAdjustmentDecrease(conn, productId, quantity, new Date(), 'ADJUSTMENT', adjustmentId, note, user?.id || null);
    }

    return { adjustment_id: adjustmentId, adjustment_code: adjustmentCode, product_id: productId, product_name: product.name, direction, quantity, reason, remark };
  }

  async create(data, user) {
    const productId = Number(data.product_id);
    if (!productId) throw Object.assign(new Error('Thiếu mặt hàng'), { status: 400 });

    const direction = String(data.direction || '').toUpperCase();
    if (direction !== 'INCREASE' && direction !== 'DECREASE') {
      throw Object.assign(new Error('Loại điều chỉnh phải là Tăng hoặc Giảm'), { status: 400 });
    }

    const quantity = Number(data.quantity || 0);
    if (!(quantity > 0)) throw Object.assign(new Error('Số lượng điều chỉnh phải lớn hơn 0'), { status: 400 });

    const reason = String(data.reason || '').toUpperCase();
    if (!VALID_REASONS.includes(reason)) {
      throw Object.assign(new Error('Lý do điều chỉnh không hợp lệ'), { status: 400 });
    }

    const remark = data.remark ? String(data.remark).trim().slice(0, 500) : null;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      // FOR UPDATE inside _applyOneAdjustment holds the lock for the whole
      // read-check-write sequence, so a concurrent sale or a second concurrent
      // adjustment on the same product can't race past the sufficiency check.
      const result = await this._applyOneAdjustment(conn, { productId, direction, quantity, reason, remark, user });
      await conn.commit();

      const [[after]] = await pool.query(`SELECT stock_quantity FROM products WHERE id = ?`, [productId]);
      return { message: 'Đã tạo phiếu điều chỉnh tồn kho', ...result, balance_after: Number(after.stock_quantity) };
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  // S7.2 — bulk "Excel-style stock count" save. ONE transaction: loops the
  // exact same _applyOneAdjustment() used by create(), once per product whose
  // actual_quantity differs from its current stock_quantity. Rows with no
  // difference are silently skipped — they never reach the database, never
  // touch the ledger. Any single item failing a check (wrong mode,
  // insufficient stock) rolls back the ENTIRE request — so the error names
  // the specific product that failed, letting the user fix just that cell and
  // resubmit the whole grid. No new table, no grouping id — every row lands
  // in inventory_adjustments exactly like a standalone create() would.
  //
  // items: [{ product_id, actual_quantity, reason, remark }]
  // current stock_quantity is always re-read server-side, never trusted from
  // the client (same principle as order pricing elsewhere in this codebase).
  async createBatch(data, user) {
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) throw Object.assign(new Error('Không có dòng nào để lưu'), { status: 400 });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const applied = [];
      let skippedNoChange = 0;

      for (const it of items) {
        const productId = Number(it.product_id);
        if (!productId) throw Object.assign(new Error('Thiếu mặt hàng trong một dòng'), { status: 400 });
        const actualQuantity = Number(it.actual_quantity);
        if (!Number.isFinite(actualQuantity) || actualQuantity < 0) {
          throw Object.assign(new Error(`Số lượng thực tế không hợp lệ cho mặt hàng ID=${productId}`), { status: 400 });
        }

        // Re-read current balance now; the authoritative check (and FOR UPDATE
        // lock) happens inside _applyOneAdjustment right below.
        const [[current]] = await conn.query(`SELECT stock_quantity FROM products WHERE id = ? AND del_flg = 0`, [productId]);
        if (!current) throw Object.assign(new Error(`Không tìm thấy mặt hàng ID=${productId}`), { status: 404 });

        const difference = actualQuantity - Number(current.stock_quantity || 0);
        if (Math.abs(difference) <= ZERO_TOLERANCE) {
          skippedNoChange++;
          continue; // Difference = 0 → no adjustment row, no ledger row.
        }

        const reason = String(it.reason || '').toUpperCase();
        if (!VALID_REASONS.includes(reason)) {
          throw Object.assign(new Error(`Lý do điều chỉnh không hợp lệ cho mặt hàng ID=${productId}`), { status: 400 });
        }
        const remark = it.remark ? String(it.remark).trim().slice(0, 500) : null;
        const direction = difference > 0 ? 'INCREASE' : 'DECREASE';
        const quantity = Math.abs(difference);

        const result = await this._applyOneAdjustment(conn, { productId, direction, quantity, reason, remark, user });
        applied.push(result);
      }

      await conn.commit();
      return {
        message: 'Đã lưu điều chỉnh tồn kho',
        items_adjusted: applied.length,
        items_skipped_no_change: skippedNoChange,
        items: applied,
      };
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  // Read-only history for this feature specifically (adjustment_code/reason/
  // remark aren't visible from the generic Stock Ledger view without this join).
  async list(query = {}) {
    const { product_id, reason, direction, limit = 100 } = query;
    const conds = [];
    const params = [];
    if (product_id) { conds.push('a.product_id = ?'); params.push(product_id); }
    if (reason && VALID_REASONS.includes(String(reason).toUpperCase())) { conds.push('a.reason = ?'); params.push(String(reason).toUpperCase()); }
    if (direction === 'INCREASE' || direction === 'DECREASE') { conds.push('a.direction = ?'); params.push(direction); }
    const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT a.id, a.adjustment_code, a.product_id, p.name product_name, p.product_code,
              a.direction, a.quantity, a.reason, a.remark, a.created_by, u.full_name created_by_name, a.created_at
       FROM inventory_adjustments a
       LEFT JOIN products p ON p.id = a.product_id
       LEFT JOIN users u ON u.id = a.created_by
       ${whereSql}
       ORDER BY a.id DESC
       LIMIT ?`,
      [...params, Number(limit) || 100]
    );
    return rows;
  }
}

module.exports = new InventoryAdjustmentAgent();
