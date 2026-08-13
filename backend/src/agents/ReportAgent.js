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
    // P0-004: retail_daily_summary is a company-wide aggregate — it has no
    // customer_id at all, so it can never be scoped to one customer the way
    // `cw`/`params` scope the orders queries above. CUSTOMER must never see
    // it merged in; their summary stays exactly their own order-scoped
    // totals (already correct as computed above).
    if (user.role !== 'CUSTOMER') {
      try {
        const [[rt]] = await pool.query(`SELECT COALESCE(SUM(amount),0) v FROM retail_daily_summary WHERE business_date=?`, [today]);
        const [[ra]] = await pool.query(`SELECT COALESCE(SUM(amount),0) v FROM retail_daily_summary`);
        result.summary.today_revenue = Number(result.summary.today_revenue) + Number(rt.v);
        result.summary.total_revenue = Number(result.summary.total_revenue) + Number(ra.v);
      } catch(e) { if (e.code !== 'ER_NO_SUCH_TABLE') throw e; }
    }
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
    // P0-004: retail_daily_summary is a company-wide aggregate with no
    // customer_id concept — CUSTOMER must never receive it merged into their
    // own scoped revenue. Their response stays exactly this order-scoped
    // posRows shape, same as the existing ER_NO_SUCH_TABLE fallback below
    // already returns when the table doesn't exist at all — no fabricated
    // pos_revenue/retail_amount fields, no zero standing in for a real figure.
    if (user.role === 'CUSTOMER') return posRows;
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

    // P0-004: retail_daily_summary is a company-wide aggregate with no
    // customer_id concept — CUSTOMER must never have it merged into their
    // own scoped revenue/profit. Skip the merge entirely for that role, and
    // (below) never attach a retail_revenue field to their rows at all —
    // not even a 0, which would misleadingly look like "this customer's own
    // retail contribution" when retail isn't a per-customer concept.
    if (user.role !== 'CUSTOMER') {
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
    }

    const rows = Array.from(summary.values()).sort((a,b)=>String(a.period).localeCompare(String(b.period))).map(r=>{
      const hasWaiting = r.waiting_cost_items > 0;
      const row = {
        period: r.period,
        revenue: Math.round(r.revenue),
        cost: hasWaiting ? null : Math.round(r.cost),
        profit: hasWaiting ? null : Math.round(r.profit),
        gross_margin: hasWaiting ? null : (r.revenue > 0 ? Number(((r.profit / r.revenue) * 100).toFixed(2)) : 0),
        orders: r.orders.size,
        items: r.items,
        waiting_cost_items: r.waiting_cost_items
      };
      if (user.role !== 'CUSTOMER') row.retail_revenue = Math.round(r.retail_revenue || 0);
      return row;
    });
    return { rows, details };
  }

  // ── Product Quantity Report ──────────────────────────────────────────────
  // Sales-quantity-only report ("Báo cáo sản lượng"): how many kg/units of
  // each product actually shipped, never a cash figure. Reuses the exact
  // where/params guard pattern already established by revenue()/profit()
  // above (o.status<>'CANCELLED', o.order_date range, CUSTOMER row-scoping)
  // rather than a parallel filter system.
  //
  // Date authority: o.order_date — this is "Ngày xuất hàng" everywhere else
  // in the app (see PrintService.js's billDate/order.order_date usage). The
  // schema has no column literally named bill_date; order_date is that field.
  //
  // sales_flow authority: COALESCE(oi.sales_flow, o.sales_flow) — both are
  // already-frozen historical facts (order_items.sales_flow is written by
  // OrderAgent.create()'s INSERT, order_items.sales_flow per line, order
  // header sales_flow derived from the distinct per-line values — see
  // OrderAgent.js recalcOrderSalesFlow/create()). Deliberately never joins
  // products.sales_flow — that is current, mutable product configuration,
  // not what was true at sale time. A handful of legacy rows predating this
  // column (verified: ~3% of historical order_items) have both NULL; those
  // lines simply don't match a specific Bò Xô/Kho filter and only appear
  // under "Tất cả" — honest behavior, not backfilled or guessed.
  _productQuantityFilters(query, user) {
    const isoDateRe = /^\d{4}-\d{2}-\d{2}$/;
    const from = String(query?.from_date || '').slice(0, 10);
    const to = String(query?.to_date || '').slice(0, 10);
    if (!isoDateRe.test(from) || !isoDateRe.test(to))
      throw Object.assign(new Error('from_date/to_date phải là ngày hợp lệ (YYYY-MM-DD)'), { status: 400 });
    if (from > to)
      throw Object.assign(new Error('from_date phải nhỏ hơn hoặc bằng to_date'), { status: 400 });

    const allowedFlows = ['ALL', 'CARCASS_POS', 'INVENTORY_SALE'];
    const flow = String(query?.sales_flow || 'ALL').toUpperCase();
    if (!allowedFlows.includes(flow))
      throw Object.assign(new Error('sales_flow không hợp lệ (ALL, CARCASS_POS, INVENTORY_SALE)'), { status: 400 });

    const where = [`o.status<>'CANCELLED'`, `o.order_date>=?`, `o.order_date<=?`];
    const params = [from, to];
    if (flow !== 'ALL') { where.push(`COALESCE(oi.sales_flow,o.sales_flow)=?`); params.push(flow); }

    // BR-SCOPE-006/007: a CUSTOMER can never widen scope via query params —
    // their own customer_id always wins, ignoring whatever they sent.
    let customerId = null;
    if (user.role === 'CUSTOMER') customerId = user.customer_id;
    else if (query?.customer_id) customerId = Number(query.customer_id) || null;
    if (customerId) { where.push('o.customer_id=?'); params.push(customerId); }

    return { from, to, flow, customerId, where: where.join(' AND '), params };
  }

  async productQuantity(query, user) {
    const f = this._productQuantityFilters(query, user);

    // Grouped by (product_id, unit) — not product_id alone — so a product
    // whose recorded unit genuinely differs across historical lines (unit
    // changed, or a data entry inconsistency) surfaces as separate rows
    // instead of silently summing incompatible units into one number.
    const [rows] = await pool.query(
      `SELECT oi.product_id product_id, oi.unit unit,
              COALESCE(MAX(p.product_code),'') product_code,
              COALESCE(MAX(p.name),MAX(oi.product_name)) product_name,
              SUM(oi.quantity) quantity,
              COUNT(DISTINCT o.id) order_count
       FROM order_items oi
       JOIN orders o ON o.id=oi.order_id
       LEFT JOIN products p ON p.id=oi.product_id
       WHERE ${f.where}
       GROUP BY oi.product_id, oi.unit
       ORDER BY quantity DESC`,
      f.params
    );

    const [[billCountRow]] = await pool.query(
      `SELECT COUNT(DISTINCT o.id) cnt
       FROM order_items oi JOIN orders o ON o.id=oi.order_id
       WHERE ${f.where}`,
      f.params
    );

    // Unit-safety (rule 6): never add kg + cái + thùng into one fake total.
    // One grand total is shown only when every row shares the same unit;
    // otherwise totals are reported per unit.
    const totalsByUnit = new Map();
    for (const r of rows) totalsByUnit.set(r.unit, (totalsByUnit.get(r.unit) || 0) + Number(r.quantity || 0));
    const units = Array.from(totalsByUnit.keys());
    const singleUnit = units.length === 1 ? units[0] : null;
    const totalQuantity = singleUnit ? totalsByUnit.get(singleUnit) : null;

    const items = rows.map(r => ({
      product_id: r.product_id,
      product_code: r.product_code,
      product_name: r.product_name,
      unit: r.unit,
      quantity: Number(r.quantity || 0),
      order_count: r.order_count,
      // Percentage only meaningful within its own unit group — computed
      // against that unit's own total, never a cross-unit fake total.
      percentage: (totalsByUnit.get(r.unit) || 0) > 0
        ? Number((Number(r.quantity || 0) / totalsByUnit.get(r.unit) * 100).toFixed(2))
        : 0,
    }));

    return {
      from: f.from, to: f.to, sales_flow: f.flow, customer_id: f.customerId,
      total_bills: Number(billCountRow?.cnt || 0),
      product_count: items.length,
      top_product: items[0] || null,
      single_unit: singleUnit,
      total_quantity: totalQuantity,
      totals_by_unit: units.map(u => ({ unit: u, quantity: totalsByUnit.get(u) })),
      items,
    };
  }

  async productQuantityDetails(productId, query, user) {
    const pid = Number(productId);
    if (!pid) throw Object.assign(new Error('product_id không hợp lệ'), { status: 400 });
    const f = this._productQuantityFilters(query, user);

    // Identical WHERE (date range, sales_flow, CANCELLED exclusion, customer
    // scope) plus one extra product_id predicate — by construction, summing
    // this result's quantity always equals the parent summary row exactly.
    const [rows] = await pool.query(
      `SELECT o.order_date, o.order_code, o.id order_id, c.name customer_name,
              o.payment_status, oi.quantity, oi.sale_price, oi.total_price, oi.unit
       FROM order_items oi
       JOIN orders o ON o.id=oi.order_id
       LEFT JOIN customers c ON c.id=o.customer_id
       WHERE ${f.where} AND oi.product_id=?
       ORDER BY o.order_date ASC, o.id ASC`,
      [...f.params, pid]
    );
    return {
      product_id: pid,
      quantity: rows.reduce((s, r) => s + Number(r.quantity || 0), 0),
      rows,
    };
  }

}
module.exports = new ReportAgent();
