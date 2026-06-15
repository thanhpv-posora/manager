const db = require('../config/db');

async function dailyReport() {
  const [rows] = await db.query(`
    SELECT
      COUNT(*) AS total_orders,
      COALESCE(SUM(total_amount),0) AS revenue
    FROM orders
    WHERE del_flg = 0
      AND DATE(created_at) = CURDATE()
  `);

  return rows[0];
}

module.exports = {
  dailyReport
};