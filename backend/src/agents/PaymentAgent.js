const pool = require('../config/db');
const { nextCode } = require('../utils/code');

class PaymentAgent {
  async list(user) {
    const where=[], params=[];
    if (user.role==='CUSTOMER') { where.push('p.customer_id=?'); params.push(user.customer_id); }
    const [rows]=await pool.query(
      `SELECT p.*,c.name customer_name,o.order_code FROM payments p JOIN customers c ON c.id=p.customer_id
       LEFT JOIN orders o ON o.id=p.order_id ${where.length?'WHERE '+where.join(' AND '):''}
       ORDER BY p.payment_date DESC,p.id DESC`, params);
    return rows;
  }

  async summary(customerId, user) {
    if (user.role==='CUSTOMER' && Number(user.customer_id)!==Number(customerId)) throw new Error('Không có quyền');
    const [customers]=await pool.query(`SELECT id,name,phone,address FROM customers WHERE id=?`, [customerId]);
    if (!customers.length) throw new Error('Không tìm thấy khách');
    const [debtRows]=await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN type IN ('SALE','ADJUSTMENT_INCREASE') THEN amount WHEN type IN ('PAYMENT','ADJUSTMENT_DECREASE') THEN -amount ELSE 0 END),0) current_debt
       FROM debt_transactions WHERE customer_id=?`, [customerId]);
    const [unpaid]=await pool.query(
      `SELECT id,order_code,order_date,total_amount,paid_amount,debt_amount,payment_status FROM orders
       WHERE customer_id=? AND status<>'CANCELLED' AND debt_amount>0 ORDER BY order_date ASC,id ASC`, [customerId]);
    const [split]=await pool.query(`SELECT payment_method,COALESCE(SUM(amount),0) total FROM payments WHERE customer_id=? GROUP BY payment_method`, [customerId]);
    const [recent]=await pool.query(`SELECT p.*,o.order_code FROM payments p LEFT JOIN orders o ON o.id=p.order_id WHERE p.customer_id=? ORDER BY p.payment_date DESC,p.id DESC LIMIT 20`, [customerId]);
    return {customer:customers[0], current_debt:debtRows[0].current_debt, unpaid_orders:unpaid, payment_split:split, recent_payments:recent};
  }

  async applyPaymentToOrder(conn, orderId, amount) {
    const [orders]=await conn.query(`SELECT total_amount,paid_amount,debt_amount FROM orders WHERE id=? FOR UPDATE`, [orderId]);
    if (!orders.length) return 0;
    const order=orders[0];
    const pay=Math.min(Number(amount||0), Number(order.debt_amount||0));
    const newPaid=Number(order.paid_amount||0)+pay;
    const total=Number(order.total_amount||0);
    const debt=Math.max(0,total-newPaid);
    const status=debt<=0?'PAID':newPaid>0?'PARTIAL':'UNPAID';
    await conn.query(`UPDATE orders SET paid_amount=?,debt_amount=?,payment_status=? WHERE id=?`, [Math.min(newPaid,total),debt,status,orderId]);
    return pay;
  }

  async allocate(conn, customerId, amount) {
    let remaining=Number(amount||0);
    const allocations=[];
    const [orders]=await conn.query(
      `SELECT id,order_code,debt_amount FROM orders WHERE customer_id=? AND status<>'CANCELLED' AND debt_amount>0 ORDER BY order_date ASC,id ASC FOR UPDATE`,
      [customerId]
    );
    for (const o of orders) {
      if (remaining<=0) break;
      const pay=Math.min(remaining, Number(o.debt_amount||0));
      const applied=await this.applyPaymentToOrder(conn,o.id,pay);
      if (applied>0) { remaining-=applied; allocations.push(`${o.order_code}:${applied}`); }
    }
    return allocations.join(', ');
  }

  async create(data, user) {
    const amount=Number(data.amount||0);
    if (!data.customer_id || amount<=0) throw new Error('Thiếu khách hoặc số tiền thu không hợp lệ');
    const conn=await pool.getConnection();
    try {
      await conn.beginTransaction();
      const code=await nextCode(conn,'payments','payment_code','PAY');
      let note=data.note||'';
      if (data.order_id) await this.applyPaymentToOrder(conn,data.order_id,amount);
      else note = note || await this.allocate(conn,data.customer_id,amount);
      const [r]=await conn.query(
        `INSERT INTO payments(payment_code,customer_id,order_id,payment_date,amount,payment_method,note,created_by)
         VALUES(?,?,?,?,?,?,?,?)`,
        [code,data.customer_id,data.order_id||null,data.payment_date,amount,data.payment_method||'CASH',note,user.id]
      );
      await conn.query(
        `INSERT INTO debt_transactions(customer_id,order_id,payment_id,transaction_date,type,amount,note,created_by)
         VALUES(?,?,?,?, 'PAYMENT', ?, ?, ?)`,
        [data.customer_id,data.order_id||null,r.insertId,data.payment_date,amount,note||`Thu tiền ${code}`,user.id]
      );
      await conn.commit();
      return {message:'Đã thu tiền và cập nhật công nợ bill', payment_code:code, allocation_note:note};
    } catch(e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }
}
module.exports = new PaymentAgent();
