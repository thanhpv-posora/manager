/**
 * Verifies GET /api/logs/* is ADMIN-only.
 *
 * These endpoints previously had no authentication: /tail returned raw log
 * contents (customer phone numbers, order and debt amounts, request payloads,
 * client IPs, error stacks) to any unauthenticated caller, and /where disclosed
 * the server's filesystem path.
 *
 * Requires the API running on PORT (default 4000).
 *
 * Run: node scripts/verify-logs-route-auth.js
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');

const BASE = 'http://127.0.0.1:' + (process.env.PORT || 4000);
const tok = (role) =>
  jwt.sign({ id: 1, username: 'logauth-' + role, role }, process.env.JWT_SECRET, { expiresIn: '10m' });

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log('  [PASS] ' + msg); }
  else { fail++; console.log('  [FAIL] ' + msg + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
};

async function call(path, role) {
  const headers = {};
  if (role) headers.Authorization = 'Bearer ' + tok(role);
  const res = await fetch(BASE + path, { headers });
  let body = '';
  try { body = await res.text(); } catch { /* ignore */ }
  return { status: res.status, body };
}

const ROUTES = ['/api/logs/tail?category=errors&lines=3', '/api/logs/where'];

async function main() {
  console.log('=== GET /api/logs/* authorization ===\n');

  console.log('-- unauthenticated -> 401 --');
  for (const p of ROUTES) {
    const r = await call(p, null);
    ok(r.status === 401, `${p.split('?')[0]}: no token -> 401`, r.status);
    ok(!r.body.includes('"lines"') && !r.body.includes('log_dir'),
      `${p.split('?')[0]}: no log content returned to an anonymous caller`);
  }

  console.log('\n-- CUSTOMER -> 403 --');
  for (const p of ROUTES) {
    const r = await call(p, 'CUSTOMER');
    ok(r.status === 403, `${p.split('?')[0]}: CUSTOMER -> 403`, r.status);
  }

  console.log('\n-- STAFF -> 403 (log tail is cross-customer diagnostic data) --');
  for (const p of ROUTES) {
    const r = await call(p, 'STAFF');
    ok(r.status === 403, `${p.split('?')[0]}: STAFF -> 403`, r.status);
  }

  console.log('\n-- ADMIN -> 200, still works --');
  for (const p of ROUTES) {
    const r = await call(p, 'ADMIN');
    ok(r.status === 200, `${p.split('?')[0]}: ADMIN -> 200`, r.status);
  }
  {
    const r = await call(ROUTES[0], 'ADMIN');
    ok(r.body.includes('"success":true'), '/tail still returns its normal payload for ADMIN');
  }

  console.log('\n-- category is sanitised (no path traversal) --');
  {
    const r = await call('/api/logs/tail?category=../../../../etc&lines=1', 'ADMIN');
    ok(r.status === 200 && !r.body.includes('..'),
      'traversal attempt in ?category is neutralised, not reflected', r.status);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
