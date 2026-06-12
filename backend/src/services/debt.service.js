const db = require('../config/db');

async function getCustomerDebt(name) {
  const [rows] = await db.query(`
    SELECT
      c.id,
      c.name,
      COALESCE(SUM(dt.amount), 0) AS debt_amount
    FROM customers c
    LEFT JOIN debt_transactions dt
      ON dt.customer_id = c.id
    WHERE c.del_flg = 0
      AND c.name LIKE ?
    GROUP BY c.id, c.name
    LIMIT 10
  `, [`%${name}%`]);

  return rows;
}

module.exports = {
  getCustomerDebt
};