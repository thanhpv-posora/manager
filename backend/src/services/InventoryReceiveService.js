'use strict';

const pool = require('../config/db');
const { nextCode } = require('../utils/code');
const InventoryService = require('./InventoryService');

class InventoryReceiveService {

  async get(id) {
    const [[header]] = await pool.query(
      `SELECT ir.*, s.name supplier_name
       FROM inventory_receives ir
       LEFT JOIN suppliers s ON s.id = ir.supplier_id
       WHERE ir.id = ?`,
      [id]
    );
    if (!header) return null;
    const [items] = await pool.query(
      `SELECT iri.*, p.name product_name, p.unit
       FROM inventory_receive_items iri
       LEFT JOIN products p ON p.id = iri.product_id
       WHERE iri.receive_id = ?
       ORDER BY iri.id ASC`,
      [id]
    );
    return { ...header, items };
  }

  async create(body, userId) {
    const { purchase_order_id, receive_date, note, items = [] } = body;
    if (!purchase_order_id) throw Object.assign(new Error('Thiếu mã phiếu mua hàng'), { status: 400 });
    if (!receive_date) throw Object.assign(new Error('Thiếu ngày nhận hàng'), { status: 400 });
    if (!items.length) throw Object.assign(new Error('Cần ít nhất một dòng hàng'), { status: 400 });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [[po]] = await conn.query(
        `SELECT id, supplier_id, status FROM purchase_orders WHERE id = ? AND del_flg = 0`,
        [purchase_order_id]
      );
      if (!po) throw Object.assign(new Error('Không tìm thấy phiếu mua hàng'), { status: 404 });
      if (!['APPROVED', 'PARTIAL_RECEIVED'].includes(po.status)) {
        throw Object.assign(
          new Error(`Phiếu mua hàng trạng thái "${po.status}" không thể tạo phiếu nhận. Cần APPROVED hoặc PARTIAL_RECEIVED`),
          { status: 400 }
        );
      }

      const [poItems] = await conn.query(
        `SELECT id, product_id, quantity, received_quantity FROM purchase_order_items WHERE purchase_order_id = ?`,
        [purchase_order_id]
      );
      const poItemMap = new Map(poItems.map(i => [Number(i.product_id), i]));

      for (const item of items) {
        const qty = Number(item.received_quantity || 0);
        if (!(qty > 0)) throw Object.assign(new Error('Số lượng nhận phải lớn hơn 0'), { status: 400 });
        const poItem = poItemMap.get(Number(item.product_id));
        if (!poItem) {
          throw Object.assign(
            new Error(`Sản phẩm ID=${item.product_id} không có trong phiếu mua hàng`),
            { status: 400 }
          );
        }
        const remaining = Number(poItem.quantity) - Number(poItem.received_quantity);
        if (qty > remaining + 0.001) {
          throw Object.assign(
            new Error(`Số lượng nhận (${qty}) vượt quá số lượng còn lại (${remaining.toFixed(3)}) cho sản phẩm ID=${item.product_id}`),
            { status: 400 }
          );
        }
      }

      const receiveCode = await nextCode(conn, 'inventory_receives', 'receive_code', 'RCV');
      const [rHeader] = await conn.query(
        `INSERT INTO inventory_receives (receive_code, purchase_order_id, receive_date, supplier_id, status, note, created_by)
         VALUES (?, ?, ?, ?, 'PENDING', ?, ?)`,
        [receiveCode, purchase_order_id, receive_date, po.supplier_id, note || null, userId || null]
      );
      const receiveId = rHeader.insertId;

      for (const item of items) {
        await conn.query(
          `INSERT INTO inventory_receive_items (receive_id, product_id, received_quantity, purchase_price)
           VALUES (?, ?, ?, ?)`,
          [receiveId, item.product_id, Number(item.received_quantity), Number(item.purchase_price || 0)]
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
      if (!['APPROVED', 'PARTIAL_RECEIVED'].includes(po.status)) {
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

      for (const item of items) {
        const qty = Number(item.received_quantity);
        if (!(qty > 0)) {
          throw Object.assign(
            new Error(`Số lượng nhận phải lớn hơn 0 cho sản phẩm ID=${item.product_id}`),
            { status: 400 }
          );
        }

        const [[poItem]] = await conn.query(
          `SELECT id, quantity, received_quantity FROM purchase_order_items
           WHERE purchase_order_id = ? AND product_id = ? LIMIT 1 FOR UPDATE`,
          [header.purchase_order_id, item.product_id]
        );
        if (!poItem) {
          throw Object.assign(
            new Error(`Sản phẩm ID=${item.product_id} không còn trong phiếu mua hàng`),
            { status: 400 }
          );
        }
        const remaining = Number(poItem.quantity) - Number(poItem.received_quantity);
        if (qty > remaining + 0.001) {
          throw Object.assign(
            new Error(`Số lượng nhận (${qty}) vượt quá số lượng còn lại (${remaining.toFixed(3)}) cho sản phẩm ID=${item.product_id}`),
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

        await conn.query(
          `UPDATE purchase_order_items SET received_quantity = received_quantity + ? WHERE id = ?`,
          [qty, poItem.id]
        );
      }

      await conn.query(
        `UPDATE inventory_receives SET status = 'RECEIVED' WHERE id = ?`,
        [receiveId]
      );

      const [[{ pending }]] = await conn.query(
        `SELECT SUM(quantity - received_quantity) pending
         FROM purchase_order_items WHERE purchase_order_id = ?`,
        [header.purchase_order_id]
      );
      const newPoStatus = Number(pending || 0) < 0.001 ? 'RECEIVED' : 'PARTIAL_RECEIVED';
      await conn.query(
        `UPDATE purchase_orders SET status = ? WHERE id = ?`,
        [newPoStatus, header.purchase_order_id]
      );

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
