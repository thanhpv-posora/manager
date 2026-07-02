'use strict';

const pool = require('../config/db');
const { nextCode } = require('../utils/code');
const InventoryService = require('./InventoryService');
const WarehouseAgent = require('../agents/WarehouseAgent');

class InventoryReceiveService {

  // S4.1-B CEO review: "received so far" per PO line must NOT be read from or
  // written to purchase_order_items this sprint (that accumulator + the
  // purchase_orders.status transition are Sprint S4.1-D's job). Instead it is
  // derived live from the receive ledger itself — every non-cancelled voucher's
  // actual_stock_qty for that PO line, summed on read. Pure read, no PO-side writes.
  //
  // excludeReceiveId: when re-validating inside receive(), the voucher being
  // posted already has its own (still-PENDING) lines sitting in the ledger —
  // without excluding it, it would count its own actual_stock_qty against its
  // own remaining and always self-block. create() has no such row yet, so it
  // never needs this.
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

  // Read-only summary for the frontend — same derivation, exposed per PO item id.
  async getReceivedSummary(purchaseOrderId) {
    const map = await this._getReceivedSoFarMap(pool, purchaseOrderId);
    return Object.fromEntries(map);
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
      // received-so-far is derived from the receive ledger (see _getReceivedSoFarMap)
      // — purchase_order_items.received_quantity is purchase-unit basis and is
      // never read here to avoid re-introducing the unit-mixing bug.
      const [poItems] = await conn.query(
        `SELECT id, product_id, quantity, expected_stock_qty
         FROM purchase_order_items WHERE purchase_order_id = ?`,
        [purchase_order_id]
      );
      const poItemMap = new Map(poItems.map(i => [Number(i.id), i]));
      const receivedSoFarMap = await this._getReceivedSoFarMap(conn, purchase_order_id);

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
        const remaining = expectedStockQty - (receivedSoFarMap.get(poItem.id) || 0);
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

      // S4.1-B CEO review: no purchase_order_items / purchase_orders reads-for-write
      // or writes happen in this sprint — received-so-far is derived from the
      // ledger, same as create(). Known limitation: unlike a locked PO-item row,
      // this derived read isn't safe against two concurrent RECEIVE posts racing
      // on the same PO line — accepted for S4.1-B; S4.1-D's maintained, lockable
      // accumulator (received_stock_qty) is the intended fix for that gap.
      const receivedSoFarMap = await this._getReceivedSoFarMap(conn, header.purchase_order_id, receiveId);

      for (const item of items) {
        const qty = Number(item.actual_stock_qty);
        if (!(qty > 0)) {
          throw Object.assign(
            new Error(`Số lượng thực nhận phải lớn hơn 0 cho sản phẩm ID=${item.product_id}`),
            { status: 400 }
          );
        }

        // Looked up by purchase_order_item_id, not product_id — a product can
        // appear on more than one PO line. Read-only: expected_stock_qty is the
        // S4.0 snapshot; this row is never written by S4.1-B.
        const [[poItem]] = await conn.query(
          `SELECT id, expected_stock_qty FROM purchase_order_items
           WHERE id = ? AND purchase_order_id = ? LIMIT 1`,
          [item.purchase_order_item_id, header.purchase_order_id]
        );
        if (!poItem) {
          throw Object.assign(
            new Error(`Dòng hàng phiếu mua hàng ID=${item.purchase_order_item_id} không còn trong phiếu mua hàng`),
            { status: 400 }
          );
        }
        const remaining = Number(poItem.expected_stock_qty) - (receivedSoFarMap.get(poItem.id) || 0);
        if (qty > remaining + 0.001) {
          throw Object.assign(
            new Error(
              `Số lượng thực nhận (${qty} kg) vượt quá số lượng tồn kho dự kiến còn lại ` +
              `(${remaining.toFixed(3)} kg) cho sản phẩm ID=${item.product_id}`
            ),
            { status: 400 }
          );
        }

        await InventoryService.in(
          conn,
          item.product_id,
          qty,
          header.receive_date || new Date(),
          'RECEIVE_VOUCHER',
          receiveId,
          `Nhận hàng phiếu ${header.receive_code}`,
          userId
        );
      }

      await conn.query(
        `UPDATE inventory_receives SET status = 'RECEIVED', received_by = ?, received_at = NOW() WHERE id = ?`,
        [userId || null, receiveId]
      );

      // S4.1-B CEO review: Purchase Order aggregate/status is NOT touched this
      // sprint — no accumulation, no status recalculation. purchase_orders.status
      // stays exactly what it was before this receive; Sprint S4.1-D owns updating
      // it. po.status was already fetched above only to gate whether receiving
      // is allowed at all.
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
