'use strict';
const pool = require('../config/db');

// S10.1 — Supplier Payable ledger for the PO/Receive engine only.
//
// Domain-separated from the legacy lot-based `supplier_payments` table
// (Bò Xô / Purchase Lot) — never read, written, or migrated by this agent.
//
// Append-only, same signed-ledger convention as debt_transactions
// (customers) and stock_transactions (inventory): `amount` is always a
// positive magnitude; signed meaning comes from `type`. supplier_payable_
// transactions itself has no UPDATE/DELETE path anywhere in this file —
// corrections are compensating ADJUSTMENT_INCREASE/ADJUSTMENT_DECREASE rows
// (postPurchasePayableReversal for receive reversal, cancelPayment below for
// payment cancel). The only UPDATE in this file targets the header tables
// (supplier_purchase_payments.status/cancelled_*), never the ledger rows.
class SupplierPayableAgent {
  constructor() {
    this.version = '1.0.0';
    this.responsibility = 'S10.1 — append-only supplier payable ledger for Purchase Order / Receive (not the legacy lot-based supplier_payments table)';
  }

  // Called by InventoryReceiveService.receive() inside its OWN transaction,
  // right before commit — conn is shared, never a fresh connection. Idempotent
  // via uq_supplier_payable_receive_purchase(inventory_receive_id, type):
  // insert-first, catch the duplicate-key error, return the existing row
  // instead of throwing. Never rolls back — a dup key here must not abort the
  // Receive transaction it's participating in; it means this exact voucher's
  // payable was already posted (safe no-op), same insert-first idiom already
  // proven for stock_transactions.receive_dedup_key and orders.idempotency_key.
  async postPurchasePayable(conn, { supplierId, purchaseOrderId, inventoryReceiveId, transactionDate, amount, note, userId }) {
    const amt = Number(amount || 0);
    if (!(amt > 0)) return null; // nothing to record for a zero-value receive line set
    try {
      const [r] = await conn.query(
        `INSERT INTO supplier_payable_transactions
           (supplier_id, purchase_order_id, inventory_receive_id, transaction_date, type, amount, note, created_by)
         VALUES (?, ?, ?, ?, 'PURCHASE', ?, ?, ?)`,
        [supplierId, purchaseOrderId || null, inventoryReceiveId || null, transactionDate, amt, note || null, userId || null]
      );
      return { id: r.insertId, amount: amt };
    } catch (e) {
      const isDup = e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062);
      if (isDup && inventoryReceiveId) {
        const [[existing]] = await conn.query(
          `SELECT id, amount FROM supplier_payable_transactions WHERE inventory_receive_id=? AND type='PURCHASE' LIMIT 1`,
          [inventoryReceiveId]
        );
        if (existing) return existing;
      }
      throw e;
    }
  }

  // P2-02 — compensating payable reversal for a reversed inventory receive.
  // Same append-only, insert-first idiom as postPurchasePayable() above —
  // never updates/deletes the original PURCHASE row. Idempotent via the same
  // uq_supplier_payable_receive_purchase(inventory_receive_id, type) unique
  // key: 'ADJUSTMENT_DECREASE' is a different type value than 'PURCHASE', so
  // one receive can carry exactly one of each; a genuine duplicate reversal
  // attempt is rejected atomically and the existing row is returned instead
  // of throwing, matching postPurchasePayable()'s own dup handling.
  async postPurchasePayableReversal(conn, { supplierId, purchaseOrderId, inventoryReceiveId, transactionDate, amount, note, userId }) {
    const amt = Number(amount || 0);
    if (!(amt > 0)) return null; // nothing to reverse for a zero-value payable
    try {
      const [r] = await conn.query(
        `INSERT INTO supplier_payable_transactions
           (supplier_id, purchase_order_id, inventory_receive_id, transaction_date, type, amount, note, created_by)
         VALUES (?, ?, ?, ?, 'ADJUSTMENT_DECREASE', ?, ?, ?)`,
        [supplierId, purchaseOrderId || null, inventoryReceiveId || null, transactionDate, amt, note || null, userId || null]
      );
      return { id: r.insertId, amount: amt };
    } catch (e) {
      const isDup = e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062);
      if (isDup && inventoryReceiveId) {
        const [[existing]] = await conn.query(
          `SELECT id, amount FROM supplier_payable_transactions WHERE inventory_receive_id=? AND type='ADJUSTMENT_DECREASE' LIMIT 1`,
          [inventoryReceiveId]
        );
        if (existing) return existing;
      }
      throw e;
    }
  }

  async summary(supplierId) {
    if (!supplierId) throw Object.assign(new Error('Thiếu nhà cung cấp'), { status: 400 });
    const [[row]] = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN type IN ('PURCHASE','ADJUSTMENT_INCREASE') THEN amount ELSE 0 END),0) total_purchase,
         COALESCE(SUM(CASE WHEN type IN ('PAYMENT','ADJUSTMENT_DECREASE') THEN amount ELSE 0 END),0) total_paid
       FROM supplier_payable_transactions WHERE supplier_id=?`,
      [supplierId]
    );
    const totalPurchase = Number(row.total_purchase || 0);
    const totalPaid = Number(row.total_paid || 0);
    return {
      supplier_id: Number(supplierId),
      total_purchase: totalPurchase,
      total_paid: totalPaid,
      outstanding: Math.max(0, totalPurchase - totalPaid),
    };
  }

  async history(supplierId, query = {}) {
    if (!supplierId) throw Object.assign(new Error('Thiếu nhà cung cấp'), { status: 400 });
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(200, Number(query.limit) || 50);
    const offset = (page - 1) * limit;
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) total FROM supplier_payable_transactions WHERE supplier_id=?`, [supplierId]
    );
    const [rows] = await pool.query(
      `SELECT t.id, t.transaction_date, t.type, t.amount, t.note,
              t.supplier_payment_id,
              po.order_code purchase_order_code,
              ir.receive_code inventory_receive_code,
              sp.status payment_status
       FROM supplier_payable_transactions t
       LEFT JOIN purchase_orders po ON po.id = t.purchase_order_id
       LEFT JOIN inventory_receives ir ON ir.id = t.inventory_receive_id
       LEFT JOIN supplier_purchase_payments sp ON sp.id = t.supplier_payment_id
       WHERE t.supplier_id=?
       ORDER BY t.transaction_date DESC, t.id DESC
       LIMIT ? OFFSET ?`,
      [supplierId, limit, offset]
    );
    return { items: rows, total: Number(total), page, limit };
  }

  // ADMIN-only at the route layer. Idempotent via idempotency_key insert-first
  // + UNIQUE constraint (mirrors orders.idempotency_key). Rejects overpayment
  // before any ledger write, computed from a fresh signed SUM under
  // SELECT ... FOR UPDATE on this supplier's existing rows — best-effort
  // serialization (V1 has no lockable balance snapshot by design; see report).
  async createPayment(data, user) {
    const supplierId = Number(data.supplier_id || 0);
    if (!supplierId) throw Object.assign(new Error('Thiếu nhà cung cấp'), { status: 400 });
    const amount = Number(data.amount || 0);
    if (!(amount > 0)) throw Object.assign(new Error('Số tiền thanh toán phải lớn hơn 0'), { status: 400 });
    const paymentDate = String(data.payment_date || new Date().toISOString().slice(0, 10)).slice(0, 10);
    const idempotencyKey = String(data.idempotency_key || '').trim() || null;

    if (idempotencyKey) {
      const [[existing]] = await pool.query(
        `SELECT id FROM supplier_purchase_payments WHERE idempotency_key=? LIMIT 1`, [idempotencyKey]
      );
      if (existing) return { message: 'Đã thanh toán NCC', payment_id: existing.id };
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [[sup]] = await conn.query(`SELECT id FROM suppliers WHERE id=? AND del_flg=0`, [supplierId]);
      if (!sup) throw Object.assign(new Error('Không tìm thấy nhà cung cấp'), { status: 404 });

      const [[row]] = await conn.query(
        `SELECT COALESCE(SUM(CASE
            WHEN type IN ('PURCHASE','ADJUSTMENT_INCREASE') THEN amount
            WHEN type IN ('PAYMENT','ADJUSTMENT_DECREASE') THEN -amount
            ELSE 0 END), 0) outstanding
         FROM supplier_payable_transactions WHERE supplier_id=? FOR UPDATE`,
        [supplierId]
      );
      const outstanding = Number(row.outstanding || 0);
      if (amount > outstanding + 0.01) {
        throw Object.assign(
          new Error(`Số tiền thanh toán (${amount.toLocaleString('en-US')}) vượt quá công nợ còn phải trả (${outstanding.toLocaleString('en-US')})`),
          { status: 400 }
        );
      }

      let paymentId;
      try {
        const [r] = await conn.query(
          `INSERT INTO supplier_purchase_payments(supplier_id, payment_date, amount, payment_method, note, idempotency_key, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [supplierId, paymentDate, amount, data.payment_method || 'CASH', data.note || null, idempotencyKey, user?.id || null]
        );
        paymentId = r.insertId;
      } catch (e) {
        const isDup = e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062);
        if (isDup && idempotencyKey) {
          await conn.rollback();
          const [[existing]] = await pool.query(`SELECT id FROM supplier_purchase_payments WHERE idempotency_key=? LIMIT 1`, [idempotencyKey]);
          if (existing) return { message: 'Đã thanh toán NCC', payment_id: existing.id };
        }
        throw e;
      }

      await conn.query(
        `INSERT INTO supplier_payable_transactions(supplier_id, supplier_payment_id, transaction_date, type, amount, note, created_by)
         VALUES (?, ?, ?, 'PAYMENT', ?, ?, ?)`,
        [supplierId, paymentId, paymentDate, amount, data.note || 'Thanh toán NCC', user?.id || null]
      );

      await conn.commit();
      return { message: 'Đã thanh toán NCC', payment_id: paymentId, amount, outstanding_after: Math.max(0, outstanding - amount) };
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  // GO-LIVE F6 — Supplier Payment cancel/reversal. Was entirely missing:
  // createPayment() had no undo path at all, leaving the final stage of the
  // Purchase flow (PO → Receive → Payable → Payment → Cancel/Reverse)
  // incomplete. Same append-only compensating-row design already proven by
  // postPurchasePayableReversal() (P2-02) — the original PAYMENT row is
  // never updated or deleted, a new ADJUSTMENT_INCREASE row nets it back out.
  // ADMIN-only at the route layer, matching createPayment().
  async cancelPayment(paymentId, data = {}, user = {}) {
    const reason = String(data.reason || data.note || '').trim();
    if (!reason) throw Object.assign(new Error('Vui lòng nhập lý do hủy thanh toán NCC'), { status: 400 });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [[payment]] = await conn.query(
        `SELECT * FROM supplier_purchase_payments WHERE id=? FOR UPDATE`, [paymentId]
      );
      if (!payment) throw Object.assign(new Error('Không tìm thấy phiếu thanh toán NCC'), { status: 404 });
      if (String(payment.status || 'ACTIVE').toUpperCase() === 'CANCELLED') {
        throw Object.assign(new Error('Phiếu thanh toán NCC đã bị hủy rồi'), { status: 400 });
      }

      // Reversal amount comes from the actual posted ledger effect (the
      // PAYMENT row createPayment() inserted), not re-derived from
      // supplier_purchase_payments.amount alone — same "reverse the real
      // movement, not a recomputation" discipline as postPurchasePayableReversal().
      const [[ledgerRow]] = await conn.query(
        `SELECT amount FROM supplier_payable_transactions WHERE supplier_payment_id=? AND type='PAYMENT' FOR UPDATE`,
        [paymentId]
      );
      const reversalAmount = ledgerRow ? Number(ledgerRow.amount) : Number(payment.amount || 0);

      if (reversalAmount > 0) {
        try {
          await conn.query(
            `INSERT INTO supplier_payable_transactions
               (supplier_id, purchase_order_id, inventory_receive_id, supplier_payment_id, transaction_date, type, amount, note, created_by)
             VALUES (?, NULL, NULL, ?, ?, 'ADJUSTMENT_INCREASE', ?, ?, ?)`,
            [payment.supplier_id, paymentId, new Date().toISOString().slice(0, 10), reversalAmount,
             `Đảo thanh toán NCC do hủy phiếu #${paymentId}: ${reason}`, user?.id || null]
          );
        } catch (e) {
          const isDup = e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062);
          if (isDup) throw Object.assign(new Error('Phiếu thanh toán này đã được đảo, không thể hủy trùng'), { status: 409 });
          throw e;
        }
      }

      try {
        await conn.query(
          `UPDATE supplier_purchase_payments SET status='CANCELLED', cancelled_at=NOW(), cancelled_by=?, cancel_reason=? WHERE id=?`,
          [user?.id || null, reason, paymentId]
        );
      } catch (e) {
        if (e && (e.code === 'ER_BAD_FIELD_ERROR' || e.errno === 1054)) {
          throw new Error('Chưa chạy migration hủy thanh toán NCC — vào Production Check để chạy SchemaMigrationAgent');
        }
        throw e;
      }

      await conn.commit();
      return { message: 'Đã hủy thanh toán NCC và đảo công nợ', payment_id: Number(paymentId), reversed_amount: reversalAmount };
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }
}

module.exports = new SupplierPayableAgent();
