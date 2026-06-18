const pool = require('../config/db');

class ReportAgent {
  async dashboard(user) {
    const today=new Date().toISOString().slice(0,10);
    const params=[]; const cw=user.role==='CUSTOMER'?'AND o.customer_id=?':'';
    if (user.role==='CUSTOMER') params.push(user.customer_id);
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
    const [topCustomers]=user.role==='CUSTOMER'?[[]]:await pool.query(
      `SELECT c.name,SUM(o.total_amount) revenue FROM orders o JOIN customers c ON c.id=o.customer_id
       WHERE o.status<>'CANCELLED' GROUP BY c.id ORDER BY revenue DESC LIMIT 10`
    );
    return {summary:summary[0], daily:daily.reverse(), topProducts, topCustomers};
  }

  async revenue(query, user) {
    const {from,to,group_by}=query;
    const where=[`o.status<>'CANCELLED'`], params=[];
    if (user.role==='CUSTOMER') { where.push('o.customer_id=?'); params.push(user.customer_id); }
    if (from) { where.push('o.order_date>=?'); params.push(from); }
    if (to) { where.push('o.order_date<=?'); params.push(to); }
    const groupExpr=group_by==='month'?`DATE_FORMAT(o.order_date,'%Y-%m')`:`o.order_date`;
    const [rows]=await pool.query(
      `SELECT ${groupExpr} period,SUM(o.total_amount) revenue,SUM(o.paid_amount) paid,SUM(o.debt_amount) debt,COUNT(*) orders
       FROM orders o WHERE ${where.join(' AND ')} GROUP BY ${groupExpr} ORDER BY period`, params
    );
    return rows;
  }

  async profit(query, user) {
    const { from, to, group_by } = query || {};
    const groupBy = group_by === 'year' ? 'year' : (group_by === 'month' ? 'month' : 'day');
    const where = [`o.status<>'CANCELLED'`];
    const params = [];
    if (user.role === 'CUSTOMER') { where.push('o.customer_id=?'); params.push(user.customer_id); }
    if (from) { where.push('o.order_date>=?'); params.push(String(from).slice(0,10)); }
    if (to) { where.push('o.order_date<=?'); params.push(String(to).slice(0,10)); }

    const periodExpr = groupBy === 'year'
      ? `DATE_FORMAT(o.order_date,'%Y')`
      : (groupBy === 'month' ? `DATE_FORMAT(o.order_date,'%Y-%m')` : `DATE(o.order_date)`);

    const [salesRows] = await pool.query(
      `SELECT ${periodExpr} period,
              DATE(o.order_date) order_date,
              o.id order_id,o.order_code,o.customer_id,c.name customer_name,
              oi.id order_item_id,oi.product_id,oi.product_name,oi.quantity,oi.sale_price,oi.total_price,
              COALESCE(p.inventory_mode,'NON_STOCK') inventory_mode,
              COALESCE(p.default_purchase_price,0) default_purchase_price
       FROM orders o
       JOIN order_items oi ON oi.order_id=o.id
       LEFT JOIN products p ON p.id=oi.product_id
       LEFT JOIN customers c ON c.id=o.customer_id
       WHERE ${where.join(' AND ')}
       ORDER BY o.order_date ASC,o.id ASC,oi.id ASC`,
      params
    );

    const dateWhere = [];
    const dateParams = [];
    if (from) { dateWhere.push('purchase_date>=?'); dateParams.push(String(from).slice(0,10)); }
    if (to) { dateWhere.push('purchase_date<=?'); dateParams.push(String(to).slice(0,10)); }
    const lotWhere = [`del_flg=0`, ...dateWhere];
    const [lotRows] = await pool.query(
      `SELECT DATE(purchase_date) purchase_date, COALESCE(SUM(total_cost),0) total_cost
       FROM purchase_lots
       WHERE ${lotWhere.join(' AND ')}
       GROUP BY DATE(purchase_date)`,
      dateParams
    );
    const lotCostByDate = new Map(lotRows.map(r => [String(r.purchase_date).slice(0,10), Number(r.total_cost||0)]));

    const [noStockRevenueRows] = await pool.query(
      `SELECT DATE(o.order_date) order_date, COALESCE(SUM(oi.total_price),0) revenue
       FROM orders o
       JOIN order_items oi ON oi.order_id=o.id
       LEFT JOIN products p ON p.id=oi.product_id
       WHERE ${where.join(' AND ')}
         AND COALESCE(p.inventory_mode,'NON_STOCK') IN ('NON_STOCK','NO_STOCK','CARCASS_PART')
       GROUP BY DATE(o.order_date)`,
      params
    );
    const noStockRevenueByDate = new Map(noStockRevenueRows.map(r => [String(r.order_date).slice(0,10), Number(r.revenue||0)]));

    // FIFO allocations already persisted by stock/FIFO engine are the source of truth for TRACK_STOCK/STOCK_FIFO items.
    // If allocation table is not migrated yet, gracefully fallback to default_purchase_price so the report still runs.
    let fifoCostByOrderItem = new Map();
    try {
      const orderItemIds = salesRows.map(r=>Number(r.order_item_id)).filter(Boolean);
      if (orderItemIds.length) {
        const placeholders = orderItemIds.map(()=>'?').join(',');
        const [costRows] = await pool.query(
          `SELECT order_item_id, COALESCE(SUM(total_cost),0) total_cost
           FROM order_item_fifo_allocations
           WHERE order_item_id IN (${placeholders})
           GROUP BY order_item_id`,
          orderItemIds
        );
        fifoCostByOrderItem = new Map(costRows.map(r=>[Number(r.order_item_id), Number(r.total_cost||0)]));
      }
    } catch(e) {
      if (!(e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146))) throw e;
    }

    const summary = new Map();
    const details = [];
    const isNoStock = mode => ['NON_STOCK','NO_STOCK','CARCASS_PART'].includes(String(mode||'').toUpperCase());

    for (const r of salesRows) {
      const period = String(r.period).slice(0, groupBy === 'year' ? 4 : (groupBy === 'month' ? 7 : 10));
      const orderDate = String(r.order_date).slice(0,10);
      const revenue = Number(r.total_price || 0);
      let cost = 0;
      let costMode = 'FIFO';

      if (isNoStock(r.inventory_mode)) {
        const dayCost = lotCostByDate.get(orderDate) || 0;
        const dayNoStockRevenue = noStockRevenueByDate.get(orderDate) || 0;
        cost = dayNoStockRevenue > 0 ? (dayCost * revenue / dayNoStockRevenue) : 0;
        costMode = 'NO_STOCK_DAY_COST';
      } else {
        if (fifoCostByOrderItem.has(Number(r.order_item_id))) {
          cost = fifoCostByOrderItem.get(Number(r.order_item_id));
          costMode = 'STOCK_FIFO';
        } else {
          cost = Number(r.quantity || 0) * Number(r.default_purchase_price || 0);
          costMode = 'DEFAULT_COST_FALLBACK';
        }
      }

      const profit = revenue - cost;
      if (!summary.has(period)) summary.set(period, {period, revenue:0, cost:0, profit:0, gross_margin:0, orders:new Set(), items:0});
      const s = summary.get(period);
      s.revenue += revenue; s.cost += cost; s.profit += profit; s.items += 1; s.orders.add(Number(r.order_id));
      details.push({
        period, order_date: orderDate, order_id:r.order_id, order_code:r.order_code,
        customer_name:r.customer_name, product_name:r.product_name, quantity:Number(r.quantity||0),
        sale_price:Number(r.sale_price||0), revenue, cost, profit, inventory_mode:r.inventory_mode,
        cost_mode: costMode
      });
    }

    const rows = Array.from(summary.values()).sort((a,b)=>String(a.period).localeCompare(String(b.period))).map(r=>({
      period:r.period,
      revenue:Math.round(r.revenue),
      cost:Math.round(r.cost),
      profit:Math.round(r.profit),
      gross_margin:r.revenue>0 ? Number(((r.profit/r.revenue)*100).toFixed(2)) : 0,
      orders:r.orders.size,
      items:r.items
    }));
    return { rows, details };
  }

}
module.exports = new ReportAgent();
