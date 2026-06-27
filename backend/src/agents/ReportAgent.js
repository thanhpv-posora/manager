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
    const result = {summary:summary[0], daily:daily.reverse(), topProducts, topCustomers};
    try {
      const [[rt]] = await pool.query(`SELECT COALESCE(SUM(amount),0) v FROM retail_daily_summary WHERE business_date=?`, [today]);
      const [[ra]] = await pool.query(`SELECT COALESCE(SUM(amount),0) v FROM retail_daily_summary`);
      result.summary.today_revenue = Number(result.summary.today_revenue) + Number(rt.v);
      result.summary.total_revenue = Number(result.summary.total_revenue) + Number(ra.v);
    } catch(e) { if (e.code !== 'ER_NO_SUCH_TABLE') throw e; }
    return result;
  }

  async revenue(query, user) {
    const {from,to,group_by}=query;
    const where=[`o.status<>'CANCELLED'`], params=[];
    if (user.role==='CUSTOMER') { where.push('o.customer_id=?'); params.push(user.customer_id); }
    if (from) { where.push('o.order_date>=?'); params.push(from); }
    if (to) { where.push('o.order_date<=?'); params.push(to); }
    const groupExpr=group_by==='month'?`DATE_FORMAT(o.order_date,'%Y-%m')`:`o.order_date`;
    const [posRows]=await pool.query(
      `SELECT ${groupExpr} period,SUM(o.total_amount) revenue,SUM(o.paid_amount) paid,SUM(o.debt_amount) debt,COUNT(*) orders
       FROM orders o WHERE ${where.join(' AND ')} GROUP BY ${groupExpr} ORDER BY period`, params
    );
    try {
      const retailWhere = [], retailParams = [];
      if (from) { retailWhere.push('business_date>=?'); retailParams.push(from); }
      if (to)   { retailWhere.push('business_date<=?'); retailParams.push(to); }
      const [retailRows] = await pool.query(
        `SELECT business_date, COALESCE(SUM(amount),0) retail_amount FROM retail_daily_summary
         ${retailWhere.length ? 'WHERE ' + retailWhere.join(' AND ') : ''} GROUP BY business_date`,
        retailParams
      );
      const retailByPeriod = new Map();
      for (const r of retailRows) {
        const d = String(r.business_date).slice(0,10);
        const p = group_by === 'month' ? d.slice(0,7) : d;
        retailByPeriod.set(p, (retailByPeriod.get(p) || 0) + Number(r.retail_amount));
      }
      const periodSet = new Set(posRows.map(r => String(r.period)));
      const merged = posRows.map(r => {
        const period = String(r.period);
        const retail = retailByPeriod.get(period) || 0;
        return { ...r, pos_revenue: Number(r.revenue), retail_amount: retail, revenue: Number(r.revenue) + retail };
      });
      for (const [period, retail] of retailByPeriod) {
        if (!periodSet.has(period)) merged.push({ period, pos_revenue: 0, retail_amount: retail, revenue: retail, paid: 0, debt: 0, orders: 0 });
      }
      merged.sort((a,b) => String(a.period).localeCompare(String(b.period)));
      return merged;
    } catch(e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
      return posRows;
    }
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
              COALESCE(p.inventory_mode,'NON_STOCK') inventory_mode
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

    // FIFO allocations are the source of truth for TRACK_STOCK items when the Cost Layer is implemented.
    // If the allocation table does not exist yet, cost is reported as 0 (UNCALCULATED) — never as default_purchase_price.
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
      let cost = null;
      let costMode = 'WAITING_COST';

      if (isNoStock(r.inventory_mode)) {
        const dayCost = lotCostByDate.get(orderDate) || 0;
        const dayNoStockRevenue = noStockRevenueByDate.get(orderDate) || 0;
        cost = dayNoStockRevenue > 0 ? (dayCost * revenue / dayNoStockRevenue) : 0;
        costMode = 'NO_STOCK_DAY_COST';
      } else {
        if (fifoCostByOrderItem.has(Number(r.order_item_id))) {
          cost = fifoCostByOrderItem.get(Number(r.order_item_id));
          costMode = 'STOCK_FIFO';
        }
        // else: cost remains null, costMode remains WAITING_COST.
        // products.default_purchase_price must never be used — it is mutable and rewrites historical profit.
      }

      const costKnown = cost !== null;
      const profit = costKnown ? revenue - cost : null;

      if (!summary.has(period)) {
        summary.set(period, {period, revenue:0, cost:0, profit:0, orders:new Set(), items:0, waiting_cost_items:0});
      }
      const s = summary.get(period);
      s.revenue += revenue;
      s.items += 1;
      s.orders.add(Number(r.order_id));
      if (costKnown) {
        s.cost += cost;
        s.profit += profit;
      } else {
        s.waiting_cost_items += 1;
      }

      details.push({
        period, order_date: orderDate, order_id:r.order_id, order_code:r.order_code,
        customer_name:r.customer_name, product_name:r.product_name, quantity:Number(r.quantity||0),
        sale_price:Number(r.sale_price||0), revenue,
        cost: costKnown ? cost : null,
        profit,
        inventory_mode:r.inventory_mode,
        cost_mode: costMode
      });
    }

    try {
      const retailDateWhere = [], retailDateParams = [];
      if (from) { retailDateWhere.push('business_date>=?'); retailDateParams.push(String(from).slice(0,10)); }
      if (to)   { retailDateWhere.push('business_date<=?'); retailDateParams.push(String(to).slice(0,10)); }
      const [retailProfitRows] = await pool.query(
        `SELECT business_date, COALESCE(SUM(amount),0) retail_amount FROM retail_daily_summary
         ${retailDateWhere.length ? 'WHERE ' + retailDateWhere.join(' AND ') : ''} GROUP BY business_date`,
        retailDateParams
      );
      for (const rr of retailProfitRows) {
        const d = String(rr.business_date).slice(0,10);
        const period = groupBy === 'year' ? d.slice(0,4) : (groupBy === 'month' ? d.slice(0,7) : d);
        if (!summary.has(period)) summary.set(period, {period,revenue:0,cost:0,profit:0,orders:new Set(),items:0,waiting_cost_items:0,retail_revenue:0});
        const s = summary.get(period);
        const amt = Number(rr.retail_amount || 0);
        s.revenue += amt;
        s.profit  += amt;
        s.retail_revenue = (s.retail_revenue || 0) + amt;
      }
    } catch(e) { if (e.code !== 'ER_NO_SUCH_TABLE') throw e; }

    const rows = Array.from(summary.values()).sort((a,b)=>String(a.period).localeCompare(String(b.period))).map(r=>{
      const hasWaiting = r.waiting_cost_items > 0;
      return {
        period: r.period,
        revenue: Math.round(r.revenue),
        retail_revenue: Math.round(r.retail_revenue || 0),
        cost: hasWaiting ? null : Math.round(r.cost),
        profit: hasWaiting ? null : Math.round(r.profit),
        gross_margin: hasWaiting ? null : (r.revenue > 0 ? Number(((r.profit / r.revenue) * 100).toFixed(2)) : 0),
        orders: r.orders.size,
        items: r.items,
        waiting_cost_items: r.waiting_cost_items
      };
    });
    return { rows, details };
  }

}
module.exports = new ReportAgent();
