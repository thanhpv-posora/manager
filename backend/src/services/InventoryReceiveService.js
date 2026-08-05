'use strict';

const pool = require('../config/db');
const { nextCode } = require('../utils/code');
const InventoryService = require('./InventoryService');
const InventoryMovementService = require('./InventoryMovementService');
const WarehouseAgent = require('../agents/WarehouseAgent');
const SupplierPayableAgent = require('../agents/SupplierPayableAgent');
const { formatQty } = require('../utils/quantityFormat');

// P2-02 audit logging: reuses the existing audit_logs table (id, user_id,
// action, entity_type, entity_id, note, created_at — bootstrap.js), the same
// shape ReturnAgent.js already writes to for Sales Return cancel/reject.
// No new table, no new logging service. Never allowed to block the
// calling action if the write itself fails — same discipline ReturnAgent.js
// uses for this exact table.
async function writeAuditLog(conn, userId, action, receiveId, note) {
  try {
    await conn.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, note) VALUES (?,?,?,?,?)`,
      [userId || null, action, 'inventory_receives', receiveId, note || null]
    );
  } catch (e) {
    // best-effort — audit_logs must never fail the Cancel/Reversal itself.
  }
}

class InventoryReceiveService {

  // S4.2-A: purchase_order_items.received_stock_qty is now the authoritative
  // received-so-far accumulator (replaces the S4.1-B ledger-sum derivation —
  // see receive() for where it's incremented under a row lock). Read-only
  // summary for the frontend, keyed by purchase_order_item_id.
  async getReceivedSummary(purchaseOrderId) {
    const [rows] = await pool.query(
      `SELECT id, received_stock_qty FROM purchase_order_items WHERE purchase_order_id = ?`,
      [purchaseOrderId]
    );
    return Object.fromEntries(rows.map(r => [r.id, Number(r.received_stock_qty)]));
  }

  // S4.2-A CTO review: legacy verification only / accumulator rebuild support.
  // NOT used in normal business flow (create/receive/getReceivedSummary all
  // read the maintained received_stock_qty column). Kept as an independent,
  // ledger-derived cross-check — sums actual_stock_qty straight from
  // inventory_receive_items, bypassing the accumulator entirely — for auditing
  // received_stock_qty against the source-of-truth ledger, or recomputing it
  // from scratch if it's ever suspected to have drifted.
  async _getReceivedSoFarMap(runner, purchaseOrderId, excludeReceiveId = null) {
    const params = [purchaseOrderId];
    let excludeSql = '';
    if (excludeReceiveId) { excludeSql = 'AND ir.id <> ?'; params.push(excludeReceiveId); }
    const [rows] = await runner.query(
      `SELECT iri.purchase_order_item_id poi_id, COALESCE(SUM(iri.actual_stock_qty),0) received
       FROM inventory_receive_items iri
       JOIN inventory_receives ir ON ir.id = iri.receive_id
       WHERE ir.purchase_order_id = ? AND ir.status <> 'CANCELLED' ${excludeSql}
       GROUP BY iri.purchase_order_item_id`,
      params
    );
    return new Map(rows.map(r => [Number(r.poi_id), Number(r.received)]));
  }

  async get(id) {
    const [[header]] = await pool.query(
      `SELECT ir.*, s.name supplier_name, w.name warehouse_name,
              u1.full_name created_by_name, u2.full_name received_by_name
       FROM inventory_receives ir
       LEFT JOIN suppliers s ON s.id = ir.supplier_id
       LEFT JOIN warehouses w ON w.id = ir.warehouse_id
       LEFT JOIN users u1 ON u1.id = ir.created_by
       LEFT JOIN users u2 ON u2.id = ir.received_by
       WHERE ir.id = ?`,
      [id]
    );
    if (!header) return null;
    const [items] = await pool.query(
      `SELECT iri.*, p.name product_name, p.unit, poi.unit ordered_unit
       FROM inventory_receive_items iri
       LEFT JOIN products p ON p.id = iri.product_id
       LEFT JOIN purchase_order_items poi ON poi.id = iri.purchase_order_item_id
       WHERE iri.receive_id = ?
       ORDER BY iri.id ASC`,
      [id]
    );
    return { ...header, items };
  }

  async create(body, userId) {
    const { purchase_order_id, receive_date, note, supplier_document_no, warehouse_id, items = [] } = body;
    if (!purchase_order_id) throw Object.assign(new Error('Thiếu mã phiếu mua hàng'), { status: 400 });
    if (!receive_date) throw Object.assign(new Error('Thiếu ngày nhận hàng'), { status: 400 });
    if (!items.length) throw Object.assign(new Error('Cần ít nhất một dòng hàng'), { status: 400 });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      let resolvedWarehouseId = warehouse_id || null;
      if (!resolvedWarehouseId) {
        resolvedWarehouseId = await WarehouseAgent.getDefaultId(conn);
      }

      const [[po]] = await conn.query(
        `SELECT id, supplier_id, status FROM purchase_orders WHERE id = ? AND del_flg = 0`,
        [purchase_order_id]
      );
      if (!po) throw Object.assign(new Error('Không tìm thấy phiếu mua hàng'), { status: 404 });
      if (!['CONFIRMED', 'PARTIAL_RECEIVED'].includes(po.status)) {
        throw Object.assign(
          new Error(`Phiếu mua hàng trạng thái "${po.status}" không thể tạo phiếu nhận. Cần CONFIRMED hoặc PARTIAL_RECEIVED`),
          { status: 400 }
        );
      }

      // S4.1-B: purchase_order_item_id resolves the PO line exactly (a product can
      // appear on more than one line under different supplier_purchase_option_id).
      // expected_stock_qty is the S4.0 snapshot (ordered_qty × conversion) — the
      // remaining-quantity basis is this, never purchase_order_items.quantity.
      // S4.2-A: received-so-far now reads purchase_order_items.received_stock_qty
      // directly (authoritative accumulator) — purchase_order_items.received_quantity
      // remains purchase-unit basis and is never read here to avoid the unit-mixing bug.
      const [poItems] = await conn.query(
        `SELECT id, product_id, quantity, expected_stock_qty, received_stock_qty
         FROM purchase_order_items WHERE purchase_order_id = ?`,
        [purchase_order_id]
      );
      const poItemMap = new Map(poItems.map(i => [Number(i.id), i]));

      const lines = [];
      for (const item of items) {
        const poItem = poItemMap.get(Number(item.purchase_order_item_id));
        if (!poItem) {
          throw Object.assign(
            new Error(`Dòng hàng phiếu mua hàng ID=${item.purchase_order_item_id} không có trong phiếu mua hàng này`),
            { status: 400 }
          );
        }
        const actualStockQty = Number(item.actual_stock_qty || 0);
        if (!(actualStockQty > 0)) {
          throw Object.assign(new Error('Số lượng thực nhận (kg) phải lớn hơn 0'), { status: 400 });
        }
        const expectedStockQty = Number(poItem.expected_stock_qty);
        const remaining = expectedStockQty - Number(poItem.received_stock_qty || 0);
        if (actualStockQty > remaining + 0.001) {
          throw Object.assign(
            new Error(
              `Số lượng thực nhận (${formatQty(actualStockQty)} kg) vượt quá số lượng tồn kho dự kiến còn lại ` +
              `(${formatQty(remaining)} kg) cho sản phẩm ID=${poItem.product_id}`
            ),
            { status: 400 }
          );
        }
        lines.push({
          purchase_order_item_id: poItem.id,
          product_id: poItem.product_id,
          ordered_qty: Number(poItem.quantity),
          expected_stock_qty: expectedStockQty,
          actual_stock_qty: actualStockQty,
          purchase_price: Number(item.purchase_price || 0),
        });
      }

      // S4.1-A CEO review: RV prefix, matching Purchase Order's PO convention (was RCV).
      const receiveCode = await nextCode(conn, 'inventory_receives', 'receive_code', 'RV');
      const [rHeader] = await conn.query(
        `INSERT INTO inventory_receives
           (receive_code, purchase_order_id, receive_date, supplier_id, status, note,
            supplier_document_no, warehouse_id, created_by)
         VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)`,
        [receiveCode, purchase_order_id, receive_date, po.supplier_id, note || null,
         supplier_document_no || null, resolvedWarehouseId, userId || null]
      );
      const receiveId = rHeader.insertId;

      for (const line of lines) {
        await conn.query(
          `INSERT INTO inventory_receive_items
             (receive_id, purchase_order_item_id, product_id, ordered_qty, expected_stock_qty, actual_stock_qty, purchase_price)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [receiveId, line.purchase_order_item_id, line.product_id,
           line.ordered_qty, line.expected_stock_qty, line.actual_stock_qty, line.purchase_price]
        );
      }

      await conn.commit();
      return { id: receiveId, receive_code: receiveCode, status: 'PENDING', message: 'Đã tạo phiếu nhận hàng' };
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  async receive(receiveId, userId) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [[header]] = await conn.query(
        `SELECT * FROM inventory_receives WHERE id = ? FOR UPDATE`,
        [receiveId]
      );
      if (!header) throw Object.assign(new Error('Không tìm thấy phiếu nhận hàng'), { status: 404 });
      if (header.status !== 'PENDING') {
        throw Object.assign(
          new Error(`Phiếu nhận hàng đã ở trạng thái "${header.status}", không thể xử lý lại`),
          { status: 400 }
        );
      }

      const [[po]] = await conn.query(
        `SELECT id, status FROM purchase_orders WHERE id = ?`,
        [header.purchase_order_id]
      );
      if (!['CONFIRMED', 'PARTIAL_RECEIVED'].includes(po.status)) {
        throw Object.assign(
          new Error(`Phiếu mua hàng trạng thái "${po.status}" không thể nhận hàng`),
          { status: 400 }
        );
      }

      const [items] = await conn.query(
        `SELECT * FROM inventory_receive_items WHERE receive_id = ?`,
        [receiveId]
      );
      if (!items.length) throw Object.assign(new Error('Phiếu nhận hàng không có dòng hàng'), { status: 400 });

      // S4.1-C: every RECEIVE_VOUCHER movement must carry a warehouse_id.
      // create() resolves a default when none is given, but that fallback can
      // itself return null (no default warehouse configured) — without this
      // guard, postIn() silently skips its warehouse check for a falsy
      // warehouseId and posts the movement with warehouse_id = NULL.
      if (!header.warehouse_id) {
        throw Object.assign(new Error('Phiếu nhận hàng chưa xác định kho hàng hợp lệ, không thể nhận hàng'), { status: 400 });
      }

      // S10.1: accumulated across every line of this voucher, using each line's
      // FROZEN purchase_order_items.purchase_price (server-resolved at PO time,
      // S4.2) — never inventory_receive_items.purchase_price, which is
      // client-submitted at receive time and not re-validated. purchase_price
      // is a per-kg rate (proved by InventoryPurchaseAgent._buildItemSnapshot's
      // total_price = expected_stock_qty * price), matching actual_stock_qty's
      // kg basis, so amount = actual_stock_qty * purchase_price needs no
      // conversion-factor scaling here.
      let payableAmount = 0;

      for (const item of items) {
        const qty = Number(item.actual_stock_qty);
        if (!(qty > 0)) {
          throw Object.assign(
            new Error(`Số lượng thực nhận phải lớn hơn 0 cho sản phẩm ID=${item.product_id}`),
            { status: 400 }
          );
        }

        // S4.2-A: FOR UPDATE here — before validating remaining and before
        // posting the movement — is what makes received_stock_qty a safe,
        // concurrency-correct accumulator. A second receive() on the same PO
        // line blocks on this SELECT until the first transaction commits or
        // rolls back, so it always validates against the true post-commit
        // remaining, closing the race the S4.1-B ledger-sum derivation had.
        // Looked up by purchase_order_item_id, not product_id — a product can
        // appear on more than one PO line.
        const [[poItem]] = await conn.query(
          `SELECT id, expected_stock_qty, received_stock_qty, purchase_price FROM purchase_order_items
           WHERE id = ? AND purchase_order_id = ? LIMIT 1 FOR UPDATE`,
          [item.purchase_order_item_id, header.purchase_order_id]
        );
        if (!poItem) {
          throw Object.assign(
            new Error(`Dòng hàng phiếu mua hàng ID=${item.purchase_order_item_id} không còn trong phiếu mua hàng`),
            { status: 400 }
          );
        }
        const remaining = Number(poItem.expected_stock_qty) - Number(poItem.received_stock_qty || 0);
        if (qty > remaining + 0.001) {
          throw Object.assign(
            new Error(
              `Số lượng thực nhận (${formatQty(qty)} kg) vượt quá số lượng tồn kho dự kiến còn lại ` +
              `(${formatQty(remaining)} kg) cho sản phẩm ID=${item.product_id}`
            ),
            { status: 400 }
          );
        }

        // S4.1-C: InventoryMovementService is the only component that changes
        // stock. header.warehouse_id was already resolved (default-fallback) at
        // create() time in S4.1-A — wired through here, not re-derived.
        await InventoryService.in(
          conn,
          item.product_id,
          qty,
          header.receive_date || new Date(),
          'RECEIVE_VOUCHER',
          receiveId,
          `Nhận hàng phiếu ${header.receive_code}`,
          userId,
          header.warehouse_id
        );

        // S4.2-A: increment only after the movement posts successfully — if
        // postIn() throws (invalid product/warehouse/duplicate), this line is
        // never reached and the whole transaction rolls back, so
        // received_stock_qty and stock_quantity always stay consistent.
        await conn.query(
          `UPDATE purchase_order_items SET received_stock_qty = received_stock_qty + ? WHERE id = ?`,
          [qty, poItem.id]
        );

        payableAmount += qty * Number(poItem.purchase_price || 0);
      }

      await conn.query(
        `UPDATE inventory_receives SET status = 'RECEIVED', received_by = ?, received_at = NOW() WHERE id = ?`,
        [userId || null, receiveId]
      );

      // S10.1: one PURCHASE payable transaction per receive voucher, same
      // transaction as the movement + accumulator + status updates above — if
      // this insert fails, everything above rolls back together (no partial
      // financial/inventory state). Short Close and cancelling a PENDING
      // receive never reach this line, so they never create payable — proven
      // by construction, not a separate guard.
      await SupplierPayableAgent.postPurchasePayable(conn, {
        supplierId: header.supplier_id,
        purchaseOrderId: header.purchase_order_id,
        inventoryReceiveId: receiveId,
        transactionDate: header.receive_date || new Date(),
        amount: payableAmount,
        note: `Nhận hàng phiếu ${header.receive_code}`,
        userId,
      });

      // S4.2-B: recompute purchase_orders.status from the just-updated
      // received_stock_qty accumulator, in the same transaction as the
      // movement + accumulator update above.
      // remaining is expected_stock_qty - received_stock_qty (same basis used
      // throughout this file); the 0.001 tolerance matches the existing
      // over-receipt guard above.
      const [[poStats]] = await conn.query(
        `SELECT
           SUM(CASE WHEN expected_stock_qty - received_stock_qty > 0.001 THEN 1 ELSE 0 END) remaining_cnt,
           SUM(CASE WHEN received_stock_qty > 0 THEN 1 ELSE 0 END) received_cnt
         FROM purchase_order_items WHERE purchase_order_id = ?`,
        [header.purchase_order_id]
      );
      let newPoStatus = po.status;
      if (Number(poStats.remaining_cnt) === 0) {
        newPoStatus = 'RECEIVED';
      } else if (Number(poStats.received_cnt) > 0) {
        newPoStatus = 'PARTIAL_RECEIVED';
      }
      if (newPoStatus !== po.status) {
        await conn.query(`UPDATE purchase_orders SET status = ? WHERE id = ?`, [newPoStatus, header.purchase_order_id]);
      }

      await conn.commit();
      return {
        id: receiveId,
        receive_code: header.receive_code,
        status: 'RECEIVED',
        purchase_order_status: newPoStatus,
        message: 'Đã nhận hàng và cập nhật tồn kho',
      };
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  async list(params = {}) {
    const { purchase_order_id, status, limit = 100 } = params;
    const where = [];
    const args = [];
    if (purchase_order_id) { where.push('ir.purchase_order_id = ?'); args.push(purchase_order_id); }
    if (status) { where.push('ir.status = ?'); args.push(status); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT ir.*, s.name supplier_name, po.order_code purchase_order_code, w.name warehouse_name
       FROM inventory_receives ir
       LEFT JOIN suppliers s ON s.id = ir.supplier_id
       LEFT JOIN purchase_orders po ON po.id = ir.purchase_order_id
       LEFT JOIN warehouses w ON w.id = ir.warehouse_id
       ${whereSql}
       ORDER BY ir.id DESC LIMIT ?`,
      [...args, Number(limit)]
    );
    return rows;
  }

  // P2-02 — Inventory Receive Reversal (Production Readiness Audit H-11/H2).
  //
  // status === 'PENDING'  → unchanged fast path: no stock was ever committed,
  //                         plain CANCELLED, no movements.
  // status === 'RECEIVED' → full reversal path: compensating OUT movements
  //                         (InventoryMovementService.postReversal, the sole
  //                         writer of stock), purchase_order_items/
  //                         purchase_orders bookkeeping unwound to mirror
  //                         receive()'s own forward bookkeeping, and an
  //                         append-only supplier payable reversal if the
  //                         receive posted one. New terminal status
  //                         'CANCELLED_REVERSAL' (VARCHAR, not ENUM — no
  //                         schema change) keeps it distinguishable from a
  //                         PENDING cancel, which never touched stock.
  //
  // Original stock_transactions rows, inventory_receive_items rows, and the
  // original supplier_payable_transactions PURCHASE row are never updated or
  // deleted — every effect here is a new, append-only, traceable row.
  async cancel(receiveId, userId, reason) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Lock the receive header first — also the single idempotency guard:
      // a retried/duplicate cancel call blocks here until the first
      // transaction commits, then fails the status check below because the
      // row is no longer PENDING/RECEIVED.
      const [[header]] = await conn.query(
        `SELECT * FROM inventory_receives WHERE id = ? FOR UPDATE`,
        [receiveId]
      );
      if (!header) throw Object.assign(new Error('Không tìm thấy phiếu nhận hàng'), { status: 404 });
      if (header.status === 'CANCELLED' || header.status === 'CANCELLED_REVERSAL') {
        throw Object.assign(new Error('Phiếu nhận hàng đã bị hủy rồi'), { status: 400 });
      }
      if (!['PENDING', 'RECEIVED'].includes(header.status)) {
        throw Object.assign(
          new Error(`Phiếu nhận hàng ở trạng thái "${header.status}", không thể hủy`),
          { status: 400 }
        );
      }

      const reasonText = String(reason || '').trim();
      if (!reasonText) {
        throw Object.assign(new Error('Cần nhập lý do hủy phiếu nhận hàng'), { status: 400 });
      }

      if (header.status === 'PENDING') {
        // No stock was committed — safe cancel, no reversal movement needed.
        await conn.query(
          `UPDATE inventory_receives
           SET status = 'CANCELLED', cancelled_at = NOW(), cancelled_by = ?, cancel_reason = ?
           WHERE id = ?`,
          [userId || null, reasonText, receiveId]
        );
        await writeAuditLog(conn, userId, 'CANCEL_RECEIVE', receiveId, JSON.stringify({
          previous_status: header.status, new_status: 'CANCELLED', reason: reasonText,
        }));
        await conn.commit();
        return { id: receiveId, receive_code: header.receive_code, status: 'CANCELLED', message: 'Đã hủy phiếu nhận hàng' };
      }

      // header.status === 'RECEIVED' — full reversal path.

      // Lock related receive lines before touching anything else.
      const [items] = await conn.query(
        `SELECT * FROM inventory_receive_items WHERE receive_id = ? ORDER BY id ASC FOR UPDATE`,
        [receiveId]
      );
      if (!items.length) {
        throw Object.assign(new Error('Phiếu nhận hàng không có dòng hàng để hủy'), { status: 400 });
      }

      // Single Writer: InventoryMovementService performs every product lock
      // (ascending id), stock-sufficiency check, and compensating OUT write.
      // Throws { status:409, code:'INSUFFICIENT_STOCK_FOR_RECEIVE_REVERSAL' }
      // if any product's current stock can't absorb the reversal, which
      // rolls back this entire transaction via the catch below — no partial
      // movement is ever left behind.
      const reversedMovements = await InventoryMovementService.postReversal(conn, receiveId, userId, reasonText);
      if (!reversedMovements.length) {
        throw Object.assign(
          new Error('Không tìm thấy bút toán nhập kho gốc để đảo cho phiếu này — dữ liệu không nhất quán'),
          { status: 409 }
        );
      }

      // Decrement purchase_order_items.received_stock_qty by exactly what
      // this voucher contributed — the reverse of the increment receive()
      // does (S4.2-A). Ascending id order + per-row FOR UPDATE mirrors
      // receive()'s own lock pattern for this same table.
      const poItemIds = [...new Set(items.map(i => Number(i.purchase_order_item_id)).filter(Boolean))].sort((a, b) => a - b);
      for (const poItemId of poItemIds) {
        const line = items.find(i => Number(i.purchase_order_item_id) === poItemId);
        if (!line) continue;
        const [[poItemRow]] = await conn.query(
          `SELECT id FROM purchase_order_items WHERE id = ? FOR UPDATE`,
          [poItemId]
        );
        if (!poItemRow) continue; // PO line no longer exists — nothing to unwind
        await conn.query(
          `UPDATE purchase_order_items SET received_stock_qty = GREATEST(0, received_stock_qty - ?) WHERE id = ?`,
          [Number(line.actual_stock_qty), poItemId]
        );
      }

      // Recompute purchase_orders.status the same formula receive() uses
      // going forward (S4.2-B), applied in reverse. Only touched when the PO
      // is still RECEIVED/PARTIAL_RECEIVED — SHORT_CLOSED/CANCELLED/DRAFT are
      // deliberate terminal or pre-receiving states this task must not
      // invent new transitions for.
      const [[po]] = await conn.query(
        `SELECT id, status FROM purchase_orders WHERE id = ? FOR UPDATE`,
        [header.purchase_order_id]
      );
      if (po && ['RECEIVED', 'PARTIAL_RECEIVED'].includes(po.status)) {
        const [[poStats]] = await conn.query(
          `SELECT
             SUM(CASE WHEN expected_stock_qty - received_stock_qty > 0.001 THEN 1 ELSE 0 END) remaining_cnt,
             SUM(CASE WHEN received_stock_qty > 0 THEN 1 ELSE 0 END) received_cnt
           FROM purchase_order_items WHERE purchase_order_id = ?`,
          [header.purchase_order_id]
        );
        let newPoStatus;
        if (Number(poStats.remaining_cnt) === 0) newPoStatus = 'RECEIVED';
        else if (Number(poStats.received_cnt) > 0) newPoStatus = 'PARTIAL_RECEIVED';
        else newPoStatus = 'CONFIRMED';
        if (newPoStatus !== po.status) {
          await conn.query(`UPDATE purchase_orders SET status = ? WHERE id = ?`, [newPoStatus, header.purchase_order_id]);
        }
      }

      // Supplier payable reversal — append-only compensating
      // ADJUSTMENT_DECREASE, amount taken from the original PURCHASE row
      // itself (never recomputed from current PO/product prices, which can
      // drift) so the reversal is exact. No-op if this receive never posted
      // a payable (amount would be 0 or the row wouldn't exist).
      const [[payable]] = await conn.query(
        `SELECT amount FROM supplier_payable_transactions WHERE inventory_receive_id = ? AND type = 'PURCHASE' LIMIT 1`,
        [receiveId]
      );
      if (payable && Number(payable.amount) > 0) {
        await SupplierPayableAgent.postPurchasePayableReversal(conn, {
          supplierId: header.supplier_id,
          purchaseOrderId: header.purchase_order_id,
          inventoryReceiveId: receiveId,
          transactionDate: new Date(),
          amount: Number(payable.amount),
          note: `Đảo công nợ do hủy phiếu nhận ${header.receive_code}`,
          userId,
        });
      }

      await conn.query(
        `UPDATE inventory_receives
         SET status = 'CANCELLED_REVERSAL', cancelled_at = NOW(), cancelled_by = ?, cancel_reason = ?
         WHERE id = ?`,
        [userId || null, reasonText, receiveId]
      );

      await writeAuditLog(conn, userId, 'REVERSE_RECEIVE', receiveId, JSON.stringify({
        previous_status: header.status,
        new_status: 'CANCELLED_REVERSAL',
        reason: reasonText,
        reversed_movements: reversedMovements,
      }));

      await conn.commit();
      return {
        id: receiveId,
        receive_code: header.receive_code,
        status: 'CANCELLED_REVERSAL',
        message: 'Đã hủy phiếu nhận hàng và đảo tồn kho',
        reversed_movements: reversedMovements,
      };
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }
}

module.exports = new InventoryReceiveService();
