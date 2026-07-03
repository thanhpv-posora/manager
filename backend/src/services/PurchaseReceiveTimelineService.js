'use strict';

const pool = require('../config/db');

class PurchaseReceiveTimelineService {

  // S4.3: Receive History Timeline — read-only aggregation of what already
  // happened to a Purchase Order (receive vouchers + short close event), plus
  // a lifecycle summary. Never writes; never touches inventory, receive
  // voucher, or purchase_orders.status.
  async getTimeline(purchaseOrderId, { page = 1, pageSize = 20 } = {}) {
    const [[po]] = await pool.query(
      `SELECT po.id, po.status, po.short_close_reason, po.short_closed_by, po.short_closed_at,
              u.full_name short_closed_by_name
       FROM purchase_orders po
       LEFT JOIN users u ON u.id = po.short_closed_by
       WHERE po.id = ? AND po.del_flg = 0`,
      [purchaseOrderId]
    );
    if (!po) throw Object.assign(new Error('Không tìm thấy phiếu nhập'), { status: 404 });

    const [[itemStats]] = await pool.query(
      `SELECT COALESCE(SUM(expected_stock_qty),0) expected_qty,
              COALESCE(SUM(received_stock_qty),0) received_qty
       FROM purchase_order_items WHERE purchase_order_id = ?`,
      [purchaseOrderId]
    );
    const [[receiveCountRow]] = await pool.query(
      `SELECT COUNT(*) receive_count FROM inventory_receives
       WHERE purchase_order_id = ? AND status <> 'CANCELLED'`,
      [purchaseOrderId]
    );

    const expectedQty = Number(itemStats.expected_qty);
    const receivedQty = Number(itemStats.received_qty);
    const summary = {
      expected_qty: expectedQty,
      received_qty: receivedQty,
      remaining_qty: expectedQty - receivedQty,
      receive_count: Number(receiveCountRow.receive_count),
      completion_percent: expectedQty === 0 ? 0 : (receivedQty / expectedQty) * 100,
      status: po.status,
    };

    // One row per receive voucher; actual_stock_qty summed across its lines.
    // Not filtered by receive status — the timeline shows every receive event
    // that happened against this PO, including PENDING/CANCELLED, exactly as
    // it occurred.
    const [receives] = await pool.query(
      `SELECT ir.id receive_id, ir.receive_code, ir.receive_date, ir.status,
              ir.warehouse_id, w.name warehouse_name,
              ir.received_by, ru.full_name received_by_name,
              ir.received_at, ir.created_at,
              COALESCE(SUM(iri.actual_stock_qty), 0) total_qty
       FROM inventory_receives ir
       LEFT JOIN inventory_receive_items iri ON iri.receive_id = ir.id
       LEFT JOIN warehouses w ON w.id = ir.warehouse_id
       LEFT JOIN users ru ON ru.id = ir.received_by
       WHERE ir.purchase_order_id = ?
       GROUP BY ir.id`,
      [purchaseOrderId]
    );

    const events = receives.map(r => ({
      type: 'RECEIVE',
      receive_id: r.receive_id,
      receive_code: r.receive_code,
      receive_date: r.receive_date,
      warehouse_id: r.warehouse_id,
      warehouse_name: r.warehouse_name,
      received_by: r.received_by,
      received_by_name: r.received_by_name,
      total_qty: Number(r.total_qty),
      status: r.status,
      event_time: r.received_at || r.created_at,
    }));

    if (po.status === 'SHORT_CLOSED') {
      events.push({
        type: 'SHORT_CLOSE',
        short_closed_at: po.short_closed_at,
        short_closed_by: po.short_closed_by,
        short_closed_by_name: po.short_closed_by_name,
        reason: po.short_close_reason,
        event_time: po.short_closed_at,
      });
    }

    events.sort((a, b) => new Date(a.event_time) - new Date(b.event_time));

    const total = events.length;
    const safePage = Math.max(1, Number(page) || 1);
    const safePageSize = Math.max(1, Number(pageSize) || 20);
    const start = (safePage - 1) * safePageSize;
    const items = events.slice(start, start + safePageSize);

    return { summary, items, page: safePage, pageSize: safePageSize, total };
  }
}

module.exports = new PurchaseReceiveTimelineService();
