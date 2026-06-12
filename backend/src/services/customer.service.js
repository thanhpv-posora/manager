const db = require('../config/db');

async function searchCustomer(keyword) {
  const [rows] = await db.query(`
    SELECT id, name, phone
    FROM customers
    WHERE del_flg = 0
      AND name LIKE ?
    LIMIT 10
  `, [`%${keyword}%`]);

  return rows;
}

module.exports = {
  searchCustomer
};