'use strict';

const pool = require('../config/db');
const { nextCode } = require('../utils/code');
const InventoryService = require('./InventoryService');
const WarehouseAgent = require('../agents/WarehouseAgent');

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
              `Số lượng thực nhận (${actualStockQty} kg) vượt quá số lượng tồn kho dự kiến còn lại ` +
              `(${remaining.toFixed(3)} kg) cho sản phẩm ID=${poItem.product_id}`
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
          `SELECT id, expected_stock_qty, received_stock_qty FROM purchase_order_items
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
              `Số lượng thực nhận (${qty} kg) vượt quá số lượng tồn kho dự kiến còn lại ` +
              `(${remaining.toFixed(3)} kg) cho sản phẩm ID=${item.product_id}`
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
      }

      await conn.query(
        `UPDATE inventory_receives SET status = 'RECEIVED', received_by = ?, received_at = NOW() WHERE id = ?`,
        [userId || null, receiveId]
      );

      // S4.2-A scope: received_stock_qty (above) is now maintained, but
      // purchase_orders.status is NOT recalculated here — it stays exactly what
      // it was before this receive. Status transitions (PARTIAL_RECEIVED/RECEIVED)
      // are S4.2-B. po.status was already fetched above only to gate whether
      // receiving is allowed at all.
      await conn.commit();
      return {
        id: receiveId,
        receive_code: header.receive_code,
        status: 'RECEIVED',
        purchase_order_status: po.status,
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

  async cancel(receiveId, userId) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [[header]] = await conn.query(
        `SELECT * FROM inventory_receives WHERE id = ? FOR UPDATE`,
        [receiveId]
      );
      if (!header) throw Object.assign(new Error('Không tìm thấy phiếu nhận hàng'), { status: 404 });
      if (header.status === 'CANCELLED') {
        throw Object.assign(new Error('Phiếu nhận hàng đã bị hủy rồi'), { status: 400 });
      }
      if (header.status === 'RECEIVED') {
        throw Object.assign(
          new Error('Phiếu nhận đã nhập kho. Chưa hỗ trợ hủy phiếu đã nhập kho; cần chức năng reversal movement.'),
          { status: 422 }
        );
      }

      // status === 'PENDING': safe to cancel — no stock was committed
      await conn.query(
        `UPDATE inventory_receives SET status = 'CANCELLED' WHERE id = ?`,
        [receiveId]
      );

      await conn.commit();
      return { id: receiveId, receive_code: header.receive_code, status: 'CANCELLED', message: 'Đã hủy phiếu nhận hàng' };
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }
}

module.exports = new InventoryReceiveService();
