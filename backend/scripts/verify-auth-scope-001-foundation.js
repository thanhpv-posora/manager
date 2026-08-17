'use strict';
// AUTH-SCOPE-001 — Phase 1 authorization foundation smoke test.
//
// Verifies, without wiring anything into production routes yet:
//   A. ADMIN — customer scope, supplier scope, and menu-permission checks all
//      stay unrestricted (existing behavior preserved).
//   B. STAFF — same, unrestricted.
//   C. CUSTOMER — existing recursive customer-tree scope (getCustomerTree /
//      assertCustomerScope / customerScopeWhere, UNCHANGED code) still works
//      correctly after this patch's edits to the rest of scope.js.
//   D. NEW supplier-scope primitives (resolveSupplierScope / assertSupplierScope
//      / supplierScopeWhere) — allow own supplier, deny another supplier, deny
//      when unmapped (never falls back to global).
//   E. NEW requireMenuPermission() middleware — granted menu allows,
//      not-granted menu denies (403), ADMIN passes regardless.
//   F. Account deactivation — a token issued while active is accepted by
//      auth(); the SAME token is rejected (401) immediately after the account
//      is deactivated, with no new login/token needed.
//   G. auth.adminOnly()/auth.staffOrAdmin() convenience wrappers behave like
//      auth(['ADMIN'])/auth(['ADMIN','STAFF']) — additive only.
//
// Self-cleaning: one throwaway STAFF user row (F/G) and a throwaway 3-level
// customer tree (C), both removed in `finally`. D reads REAL existing
// supplier_partner_map rows (read-only, no mutation). No route is called —
// these are direct calls against the middleware/agent functions, matching
// this repo's existing backend/scripts/verify-*.js convention (no test
// framework is installed in backend/package.json).

const pool = require('../src/config/db');
const jwt = require('jsonwebtoken');
const { auth } = require('../src/middleware/auth');
const {
  getCustomerTree, assertCustomerScope, customerScopeWhere,
  resolveSupplierScope, assertSupplierScope, supplierScopeWhere,
} = require('../src/middleware/scope');
const { requireMenuPermission } = require('../src/middleware/menuPermission');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}
async function throws403(fn) {
  try { await fn(); return { threw: false }; }
  catch (e) { return { threw: true, status: e.status || e.statusCode }; }
}

// Minimal Express req/res/next mock — enough to exercise middleware directly.
function mockReqRes(user, token) {
  const req = { user, headers: token ? { authorization: `Bearer ${token}` } : {} };
  const res = {
    statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  const state = { nextCalled: false, nextErr: undefined };
  const next = (err) => { state.nextCalled = true; state.nextErr = err; };
  return { req, res, next, state };
}
function signToken(u) {
  return jwt.sign({ id: u.id, username: u.username, full_name: u.full_name, role: u.role, customer_id: u.customer_id }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

const ADMIN = { id: -1, role: 'ADMIN', customer_id: null };
const STAFF = { id: -2, role: 'STAFF', customer_id: null };

async function main() {
  const customerIds = [];
  let throwawayUserId = null;

  try {
    // ══════════════════ A/B: ADMIN & STAFF stay unrestricted ══════════════════
    for (const [label, user] of [['ADMIN', ADMIN], ['STAFF', STAFF]]) {
      const cw = await customerScopeWhere(user, 'o.customer_id');
      check(`${label}: customerScopeWhere() unrestricted (empty clause)`, cw.clause === '' && cw.params.length === 0, cw);

      const acsResult = await throws403(() => assertCustomerScope(user, 999999));
      check(`${label}: assertCustomerScope() never throws (any target id)`, !acsResult.threw, acsResult);

      const sw = await supplierScopeWhere(user, 'l.supplier_id');
      check(`${label}: supplierScopeWhere() unrestricted (empty clause)`, sw.clause === '' && sw.params.length === 0, sw);

      const assResult = await throws403(() => assertSupplierScope(user, 999999));
      check(`${label}: assertSupplierScope() never throws (any target id)`, !assResult.threw, assResult);

      const { req, res, next, state } = mockReqRes(user);
      await requireMenuPermission('lots')(req, res, next);
      check(`${label}: requireMenuPermission('lots') allows (existing ADMIN/STAFF semantics preserved)`, state.nextCalled && res.statusCode === null, { statusCode: res.statusCode });
    }

    // ══════════════════ C: existing recursive customer scope — unchanged ══════════════════
    const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const mk = async (name, parentId) => {
      const [ins] = await pool.query(
        `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type,partner_type,parent_customer_id)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
        [`ASC001-${name}-${uniq}`, `AUTH-SCOPE-001 ${name}`, '0', 'test', 'COMMON_PRICE', 0, 0, 'SOLAR', 2, parentId]
      );
      customerIds.push(ins.insertId);
      return ins.insertId;
    };
    const rootId = await mk('ROOT', null);
    const childId = await mk('CHILD', rootId);
    const grandchildId = await mk('GRANDCHILD', childId);

    const tree = await getCustomerTree(rootId);
    check('C: getCustomerTree() recursion still reaches 2 levels down', [rootId, childId, grandchildId].every(id => tree.includes(id)) && tree.length === 3, tree);

    const rootUser = { role: 'CUSTOMER', customer_id: rootId };
    const childUser = { role: 'CUSTOMER', customer_id: childId };
    const rootToGrandchild = await throws403(() => assertCustomerScope(rootUser, grandchildId));
    check('C: root user may access grandchild (descendant)', !rootToGrandchild.threw, rootToGrandchild);
    const childToRoot = await throws403(() => assertCustomerScope(childUser, rootId));
    check('C: child user is DENIED access to root (ancestor, not descendant)', childToRoot.threw && childToRoot.status === 403, childToRoot);

    const cw2 = await customerScopeWhere(rootUser, 'c.id');
    check('C: customerScopeWhere() for root user covers exactly its 3-node subtree', cw2.params.length === 3 && [rootId, childId, grandchildId].every(id => cw2.params.includes(id)), cw2);

    // ══════════════════ D: NEW supplier-scope primitives ══════════════════
    const [mapRows] = await pool.query(`SELECT supplier_id, partner_id FROM supplier_partner_map ORDER BY id LIMIT 2`);
    check('D: precondition — at least 2 real supplier_partner_map rows exist to test against', mapRows.length === 2, mapRows);
    if (mapRows.length === 2) {
      const [rowA, rowB] = mapRows;
      const userA = { role: 'CUSTOMER', customer_id: rowA.partner_id };

      const resolved = await resolveSupplierScope(userA);
      check('D: resolveSupplierScope() derives the correct mapped supplier_id', resolved === Number(rowA.supplier_id), { resolved, expected: rowA.supplier_id });

      const ownResult = await throws403(() => assertSupplierScope(userA, rowA.supplier_id));
      check('D: assertSupplierScope() ALLOWS own mapped supplier', !ownResult.threw, ownResult);

      const otherResult = await throws403(() => assertSupplierScope(userA, rowB.supplier_id));
      check('D: assertSupplierScope() DENIES a different supplier (cross-supplier IDOR)', otherResult.threw && otherResult.status === 403, otherResult);

      const swMapped = await supplierScopeWhere(userA, 'l.supplier_id');
      check('D: supplierScopeWhere() for mapped user scopes to exactly their supplier_id', swMapped.clause === 'l.supplier_id = ?' && swMapped.params.length === 1 && Number(swMapped.params[0]) === Number(rowA.supplier_id), swMapped);
    }

    const unmappedUser = { role: 'CUSTOMER', customer_id: 999999999 };
    const unmappedResolve = await resolveSupplierScope(unmappedUser);
    check('D: resolveSupplierScope() returns null for an unmapped customer (no fallback)', unmappedResolve === null, unmappedResolve);
    const unmappedAssert = await throws403(() => assertSupplierScope(unmappedUser, 1));
    check('D: assertSupplierScope() DENIES an unmapped customer — never falls back to global', unmappedAssert.threw && unmappedAssert.status === 403, unmappedAssert);
    const unmappedWhere = await supplierScopeWhere(unmappedUser, 'l.supplier_id');
    check('D: supplierScopeWhere() for an unmapped customer is always-false, not unrestricted', unmappedWhere.clause === 'l.supplier_id = -1', unmappedWhere);

    // ══════════════════ E: menu permission middleware ══════════════════
    {
      const custWithOrders = { id: -3, role: 'CUSTOMER', customer_id: rootId };
      const { req, res, next, state } = mockReqRes(custWithOrders);
      await requireMenuPermission('orders')(req, res, next);
      check(`E: CUSTOMER granted 'orders' by default role_menu_permissions → allowed`, state.nextCalled && res.statusCode === null, { statusCode: res.statusCode, body: res.body });
    }
    {
      const custWithOrders = { id: -3, role: 'CUSTOMER', customer_id: rootId };
      const { req, res, next, state } = mockReqRes(custWithOrders);
      await requireMenuPermission('lots')(req, res, next);
      check(`E: CUSTOMER never granted 'lots' by default role_menu_permissions → 403, next() not called`, !state.nextCalled && res.statusCode === 403, { statusCode: res.statusCode, body: res.body });
    }
    {
      const { req, res, next, state } = mockReqRes(null);
      await requireMenuPermission('orders')(req, res, next);
      check('E: no req.user at all → 401, next() not called', !state.nextCalled && res.statusCode === 401, { statusCode: res.statusCode });
    }

    // ══════════════════ F/G: deactivation + adminOnly/staffOrAdmin wrappers ══════════════════
    const [ins] = await pool.query(
      `INSERT INTO users(username,full_name,phone,email,password_hash,role,customer_id,is_active) VALUES(?,?,?,?,?,?,?,1)`,
      [`asc001-${uniq}`, 'AUTH-SCOPE-001 Throwaway', '', '', 'x', 'STAFF', null]
    );
    throwawayUserId = ins.insertId;
    const staffToken = signToken({ id: throwawayUserId, username: `asc001-${uniq}`, full_name: 'AUTH-SCOPE-001 Throwaway', role: 'STAFF', customer_id: null });

    {
      const { req, res, next, state } = mockReqRes(null, staffToken);
      await auth(['STAFF'])(req, res, next);
      check('F: valid token + active account → auth() calls next(), sets req.user', state.nextCalled && req.user && req.user.id === throwawayUserId, { statusCode: res.statusCode });
    }

    // G: adminOnly()/staffOrAdmin() role-array behavior, using the SAME active
    // throwaway row (auth()'s is_active check only cares about the DB row —
    // role-array enforcement is purely from the JWT's own role claim, so
    // re-signing the token with a different role claim against the same row
    // is a valid, minimal way to exercise both without a second fixture).
    {
      const { req, res, next, state } = mockReqRes(null, staffToken);
      await auth.adminOnly()(req, res, next);
      check('G: auth.adminOnly() denies a STAFF-role token (403), matches auth([\'ADMIN\'])', !state.nextCalled && res.statusCode === 403, { statusCode: res.statusCode });
    }
    {
      const { req, res, next, state } = mockReqRes(null, staffToken);
      await auth.staffOrAdmin()(req, res, next);
      check('G: auth.staffOrAdmin() allows a STAFF-role token, matches auth([\'ADMIN\',\'STAFF\'])', state.nextCalled && res.statusCode === null, { statusCode: res.statusCode });
    }
    {
      const adminClaimToken = signToken({ id: throwawayUserId, username: `asc001-${uniq}`, full_name: 'AUTH-SCOPE-001 Throwaway', role: 'ADMIN', customer_id: null });
      const { req, res, next, state } = mockReqRes(null, adminClaimToken);
      await auth.staffOrAdmin()(req, res, next);
      check('G: auth.staffOrAdmin() allows an ADMIN-role token too', state.nextCalled && res.statusCode === null, { statusCode: res.statusCode });
    }

    // Now deactivate the SAME row and reuse the SAME already-issued token.
    await pool.query(`UPDATE users SET is_active=0 WHERE id=?`, [throwawayUserId]);
    {
      const { req, res, next, state } = mockReqRes(null, staffToken);
      await auth(['STAFF'])(req, res, next);
      check('F: SAME token, account now deactivated → auth() DENIES (401), next() not called, no new login involved', !state.nextCalled && res.statusCode === 401, { statusCode: res.statusCode, body: res.body });
    }

    // Deleting the user row entirely (not just deactivating) must also deny —
    // covers "account no longer exists" alongside "account inactive".
    await pool.query(`DELETE FROM users WHERE id=?`, [throwawayUserId]);
    throwawayUserId = null;
    {
      const { req, res, next, state } = mockReqRes(null, staffToken);
      await auth(['STAFF'])(req, res, next);
      check('F: SAME token, account row deleted → auth() DENIES (401)', !state.nextCalled && res.statusCode === 401, { statusCode: res.statusCode });
    }

  } finally {
    if (throwawayUserId) await pool.query(`DELETE FROM users WHERE id=?`, [throwawayUserId]).catch(() => {});
    // Children before parents — no FK from customers.parent_customer_id in
    // this schema, but delete in leaf-first order anyway for hygiene.
    for (const cid of customerIds.slice().reverse()) {
      await pool.query(`DELETE FROM customers WHERE id=?`, [cid]).catch(() => {});
    }
    console.log('Cleanup done.');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
