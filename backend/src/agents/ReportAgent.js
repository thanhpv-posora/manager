const pool = require('../config/db');

class ReportAgent {
  async dashboard(user) {
    const today=new Date().toISOString().slice(0,10);
    const params=[];
    const mustCustomerScope = user && user.customer_id && user.role !== 'ADMIN';
    const cw = mustCustomerScope ? 'AND o.customer_id=?' : '';
    if (mustCustomerScope) params.push(user.customer_id);
    const [summary]=await pool.query(
      `SELECT COALESCE(SUM(total_amount),0) total_revenue,COALESCE(SUM(paid_amount),0) total_paid,COALESCE(SUM(debt_amount),0) total_debt,COUNT(*) total_orders,
       COALESCE(SUM(CASE WHEN order_date=? THEN total_amount ELSE 0 END),0) today_revenue
       FROM orders o WHERE o.status<>'CANCELLED' ${cw}`,
      [today,...params]
    );
    const [daily]=await pool.query(
      `SELECT order_date,SUM(total_amount) revenue,SUM(paid_amount) paid,SUM(debt_amount) debt,COUNT(*) orders
       FROM orders o WHERE o.status<>'CANCELLED' ${cw} GROUP BY order_date ORDER BY order_date DESC LIMIT 30`,
      params
    );
    const [topProducts]=await pool.query(
      `SELECT oi.product_name,SUM(oi.quantity) qty,SUM(oi.total_price) revenue FROM order_items oi JOIN orders o ON o.id=oi.order_id
       WHERE o.status<>'CANCELLED' ${cw} GROUP BY oi.product_name ORDER BY revenue DESC LIMIT 10`, params
    );
    const [topCustomers]=mustCustomerScope?[[]]:await pool.query(
      `SELECT c.name,SUM(o.total_amount) revenue FROM orders o JOIN customers c ON c.id=o.customer_id
       WHERE o.status<>'CANCELLED' GROUP BY c.id ORDER BY revenue DESC LIMIT 10`
    );
    return {summary:summary[0], daily:daily.reverse(), topProducts, topCustomers};
  }

  async revenue(query, user) {
    const {from,to,group_by}=query;
    const where=[`o.status<>'CANCELLED'`], params=[];
    if (user && user.customer_id && user.role !== 'ADMIN') { where.push('o.customer_id=?'); params.push(user.customer_id); }
    if (from) { where.push('o.order_date>=?'); params.push(from); }
    if (to) { where.push('o.order_date<=?'); params.push(to); }
    const groupExpr=group_by==='month'?`DATE_FORMAT(o.order_date,'%Y-%m')`:`o.order_date`;
    const [rows]=await pool.query(
      `SELECT ${groupExpr} period,SUM(o.total_amount) revenue,SUM(o.paid_amount) paid,SUM(o.debt_amount) debt,COUNT(*) orders
       FROM orders o WHERE ${where.join(' AND ')} GROUP BY ${groupExpr} ORDER BY period`, params
    );
    return rows;
  }
}
module.exports = new ReportAgent();
