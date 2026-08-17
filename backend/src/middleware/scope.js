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

/**
 * AUTH-SCOPE-001 (Phase 1 authorization foundation): supplier-side mirror of
 * the customer-scope helpers above. Not wired into any route/agent yet — see
 * SupplierAgent.js/routes/lots.js, which stay ADMIN/STAFF-only through this
 * phase. Built now so Phase 2 (Nhập Xô supplier scope) only has to wire
 * these in, not design them.
 *
 * Derivation: users.customer_id -> supplier_partner_map.partner_id ->
 * supplier_id. supplier_partner_map.partner_id carries a UNIQUE key
 * (uq_spm_partner, added alongside these helpers) so this lookup can never
 * return more than one row.
 */

/**
 * Resolves the single supplier_id a CUSTOMER-role user is authorized to act
 * as, or null if there is no mapping. Never falls back to "all suppliers" —
 * an unmapped CUSTOMER simply has no supplier identity.
 * ADMIN/STAFF have no single supplier identity to resolve — callers should
 * branch on role first (assertSupplierScope/supplierScopeWhere below already
 * do this, so most callers never need to call this directly).
 */
async function resolveSupplierScope(user) {
  if (!user || user.role !== 'CUSTOMER') return null;
  const customerId = Number(user.customer_id || 0);
  if (!customerId) return null;
  const [rows] = await pool.query(
    `SELECT supplier_id FROM supplier_partner_map WHERE partner_id = ?`,
    [customerId]
  );
  return rows.length ? Number(rows[0].supplier_id) : null;
}

/**
 * Throws 403 if a CUSTOMER user cannot act as targetSupplierId.
 * ADMIN and STAFF always pass — no query is executed for them.
 * A CUSTOMER with no supplier_partner_map mapping is always denied — never
 * falls back to unrestricted/global access.
 */
async function assertSupplierScope(user, targetSupplierId) {
  if (!user || user.role !== 'CUSTOMER') return;
  const supplierId = await resolveSupplierScope(user);
  if (!supplierId || supplierId !== Number(targetSupplierId)) {
    const err = new Error('Không có quyền truy cập nhà cung cấp này');
    err.status = 403; err.statusCode = 403;
    throw err;
  }
}

/**
 * Returns { clause, params } for filtering a SQL column by the user's mapped
 * supplier identity.
 * ADMIN / STAFF: returns empty clause — no restriction applied.
 * CUSTOMER: returns an equality clause for their mapped supplier_id, or an
 * always-false clause if unmapped (mirrors customerScopeWhere's empty-tree
 * behavior — never an unrestricted fallback).
 */
async function supplierScopeWhere(user, column) {
  if (!user || user.role !== 'CUSTOMER') return { clause: '', params: [] };
  const supplierId = await resolveSupplierScope(user);
  if (!supplierId) return { clause: `${column} = -1`, params: [] };
  return { clause: `${column} = ?`, params: [supplierId] };
}

module.exports = {
  getCustomerTree, assertCustomerScope, customerScopeWhere,
  resolveSupplierScope, assertSupplierScope, supplierScopeWhere,
};
