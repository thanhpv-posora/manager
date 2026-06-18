const pool = require('../config/db');

/**
 * Returns every customer ID in the subtree rooted at rootCustomerId,
 * including the root itself. Unlimited depth via recursive CTE (MySQL 8+).
 */
async function getCustomerTree(rootCustomerId) {
  const [rows] = await pool.query(
    `WITH RECURSIVE tree AS (
       SELECT id FROM customers WHERE id = ? AND del_flg = 0
       UNION ALL
       SELECT c.id FROM customers c
       INNER JOIN tree t ON c.parent_customer_id = t.id
       WHERE c.del_flg = 0
     )
     SELECT id FROM tree`,
    [rootCustomerId]
  );
  return rows.map(r => Number(r.id));
}

/**
 * Throws 403 if a CUSTOMER user cannot access targetCustomerId.
 * ADMIN and STAFF always pass — no query is executed for them.
 */
async function assertCustomerScope(user, targetCustomerId) {
  if (!user || user.role !== 'CUSTOMER') return;
  const root = Number(user.customer_id || 0);
  if (!root) {
    const err = new Error('Không có quyền');
    err.status = 403; err.statusCode = 403;
    throw err;
  }
  const tree = await getCustomerTree(root);
  if (!tree.includes(Number(targetCustomerId))) {
    const err = new Error('Không có quyền truy cập khách hàng này');
    err.status = 403; err.statusCode = 403;
    throw err;
  }
}

/**
 * Returns { clause, params } for filtering a SQL column by the user's customer tree.
 * ADMIN / STAFF: returns empty clause — no restriction applied.
 * CUSTOMER: returns IN clause covering all tree IDs.
 */
async function customerScopeWhere(user, column) {
  if (!user || user.role !== 'CUSTOMER') return { clause: '', params: [] };
  const root = Number(user.customer_id || 0);
  if (!root) return { clause: `${column} = -1`, params: [] };
  const tree = await getCustomerTree(root);
  if (!tree.length) return { clause: `${column} = -1`, params: [] };
  const ph = tree.map(() => '?').join(',');
  return { clause: `${column} IN (${ph})`, params: tree };
}

module.exports = { getCustomerTree, assertCustomerScope, customerScopeWhere };
