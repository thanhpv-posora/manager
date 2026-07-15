const db = require('../config/db');

async function getCustomerDebt(name) {
  // S8.1: signed aggregate, matching CustomerAgent.list()'s existing CASE
  // convention — debt_transactions.amount is always stored as a positive
  // magnitude regardless of type, so a naive SUM(amount) overcounts the
  // moment any PAYMENT/ADJUSTMENT_DECREASE row exists (it was previously
  // undercounted risk only via the rare installment-topup ADJUSTMENT_INCREASE
  // path; Add Item/Edit Item now also post ADJUSTMENT_INCREASE/DECREASE rows
  // routinely, so this consumer must use the same signed convention as the
  // Customer list to stay correct).
  const [rows] = await db.query(`
    SELECT
      c.id,
      c.name,
      COALESCE(SUM(CASE
        WHEN dt.type IN ('SALE','ADJUSTMENT_INCREASE') THEN dt.amount
        WHEN dt.type IN ('PAYMENT','ADJUSTMENT_DECREASE') THEN -dt.amount
        ELSE 0 END), 0) AS debt_amount
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