'use strict';
const pool = require('../config/db');
const { nextCode } = require('../utils/code');
const InventoryMovementService = require('../services/InventoryMovementService');
const InventoryPolicyResolver = require('../services/InventoryPolicyResolver');
const { formatQty } = require('../utils/quantityFormat');

// InventoryAdjustmentAgent — S6.6
//
// Standalone Inventory Adjustment (Increase/Decrease + reason + remark),
// independent of Order Edit. Before this, ADJUSTMENT_INCREASE/DECREASE ledger
// rows only ever existed as a side effect of InventoryService.adjustOrderItem
// (editing a bill line's quantity) — there was no way to record a warehouse
// event (broken/lost/expired/found/recount) on its own.
//
// Does NOT introduce a new stock writer: the actual balance change still goes
// through InventoryMovementService.postAdjustmentIncrease/postAdjustmentDecrease
// (untouched, S6.1/S6.2's single writer). This agent only adds the business
// context a bare 'MANUAL' reference could never carry — an adjustment_code, a
// reason, and a remark — via a new header table (inventory_adjustments) and a
// dedicated reference_type='ADJUSTMENT'.
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

class InventoryAdjustmentAgent {
  constructor() {
    this.version = '1.0.0';
    this.responsibility = 'S6.6 — standalone Inventory Adjustment (Increase/Decrease with reason + remark), independent of Order Edit.';
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

      // FOR UPDATE: same row-lock discipline as postOut — holds the lock for the
      // whole read-check-write sequence below, so a concurrent sale or a second
      // concurrent adjustment on the same product can't race past the
      // sufficiency check.
      const [[product]] = await conn.query(
        `SELECT id, name, stock_quantity, inventory_mode, allow_negative_stock
         FROM products WHERE id = ? AND del_flg = 0 FOR UPDATE`,
        [productId]
      );
      if (!product) throw Object.assign(new Error('Không tìm thấy mặt hàng'), { status: 404 });

      // Policy check, reused verbatim from InventoryPolicyResolver — a product
      // that never affects the balance (NON_STOCK/CARCASS_PART — the Bò Xô
      // direct-sale case) has nothing here to adjust.
      const policy = InventoryPolicyResolver.resolve(product);
      if (!policy.affectBalance) {
        throw Object.assign(
          new Error(`Mặt hàng "${product.name}" không quản lý tồn kho (chế độ ${policy.mode}), không thể điều chỉnh tồn kho.`),
          { status: 400 }
        );
      }

      // Decrease below zero is blocked unless the product explicitly allows it —
      // same rule as a normal sale (postOut), applied here since
      // postAdjustmentDecrease itself performs no sufficiency check (by design,
      // it trusts the caller — see its own doc comment).
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

      await conn.commit();

      const [[after]] = await pool.query(`SELECT stock_quantity FROM products WHERE id = ?`, [productId]);
      return {
        message: 'Đã tạo phiếu điều chỉnh tồn kho',
        adjustment_id: adjustmentId,
        adjustment_code: adjustmentCode,
        product_id: productId,
        direction,
        quantity,
        reason,
        remark,
        balance_after: Number(after.stock_quantity),
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
