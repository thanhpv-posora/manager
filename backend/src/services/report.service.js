const db = require('../config/db');

// fix(report): goods-only revenue — see ReportAgent.js's GOODS_REVENUE_EXPR
// for the full rationale. Same expression, unaliased (this query has no
// table alias).
const GOODS_REVENUE_EXPR = `COALESCE(NULLIF(current_bill_amount,0), GREATEST(COALESCE(total_amount,0)-COALESCE(installment_amount,0),0))`;

async function dailyReport() {
  const [rows] = await db.query(`
    SELECT
      COUNT(*) AS total_orders,
      COALESCE(SUM(${GOODS_REVENUE_EXPR}),0) AS revenue
    FROM orders
    WHERE del_flg = 0
      AND DATE(created_at) = CURDATE()
  `);

  return rows[0];
}

module.exports = {
  dailyReport
};
