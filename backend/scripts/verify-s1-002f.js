'use strict';
// S1-002F Integration Verification
// Mocks the DB pool — no live database required.
// Tests scope logic, SQL shape, method existence, and runtime blocking.

process.env.NODE_ENV = 'test';
const assert = require('assert');
const path = require('path');
const fs = require('fs');

// ─── Mock pool injected before any module loads it ───────────────────────────
let mockQueryImpl = async () => [[]];
const mockPool = {
  query: async (...args) => mockQueryImpl(...args),
  getConnection: async () => { throw new Error('getConnection must not be called during scope checks'); },
};
const dbPath = require.resolve('../src/config/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockPool };

// ─── Test runner ─────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed++; }
  catch(e) { console.error(`  FAIL  ${name}`); console.error(`        ${e.message}`); failed++; }
}

// ─── Load modules after mock ──────────────────────────────────────────────────
const { assertCustomerScope, customerScopeWhere } = require('../src/middleware/scope');

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — scope.js core logic
// ─────────────────────────────────────────────────────────────────────────────
async function section1() {
  console.log('\n[S1] scope.js core logic');

  await t('ADMIN skips DB query entirely', async () => {
    mockQueryImpl = async () => { throw new Error('DB must not be queried for ADMIN'); };
    await assertCustomerScope({ role: 'ADMIN', id: 1 }, 999);
  });

  await t('STAFF skips DB query entirely', async () => {
    mockQueryImpl = async () => { throw new Error('DB must not be queried for STAFF'); };
    await assertCustomerScope({ role: 'STAFF', id: 2 }, 999);
  });

  await t('CUSTOMER with null customer_id throws 403', async () => {
    mockQueryImpl = async () => [[]];
    try { await assertCustomerScope({ role: 'CUSTOMER', id: 3, customer_id: null }, 5); throw new Error('no throw'); }
    catch(e) { assert.strictEqual(e.status, 403); }
  });

  await t('CUSTOMER whose id is in the tree passes', async () => {
    mockQueryImpl = async () => [[{ id: 10 }, { id: 11 }, { id: 12 }]];
    await assertCustomerScope({ role: 'CUSTOMER', id: 3, customer_id: 10 }, 11);
  });

  await t('CUSTOMER whose id is NOT in the tree throws 403', async () => {
    mockQueryImpl = async () => [[{ id: 10 }, { id: 11 }]];
    try { await assertCustomerScope({ role: 'CUSTOMER', id: 3, customer_id: 10 }, 99); throw new Error('no throw'); }
    catch(e) { assert.strictEqual(e.status, 403); }
  });

  await t('customerScopeWhere returns empty clause for ADMIN', async () => {
    const r = await customerScopeWhere({ role: 'ADMIN' }, 'o.customer_id');
    assert.strictEqual(r.clause, '');
    assert.deepStrictEqual(r.params, []);
  });

  await t('customerScopeWhere returns IN clause for CUSTOMER', async () => {
    mockQueryImpl = async () => [[{ id: 5 }, { id: 6 }]];
    const r = await customerScopeWhere({ role: 'CUSTOMER', customer_id: 5 }, 'o.customer_id');
    assert.ok(r.clause.includes('IN (?,?)'), `Unexpected clause: ${r.clause}`);
    assert.deepStrictEqual(r.params, [5, 6]);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Fix 3: PriceMatrixAgent.saveAllSafe
// ─────────────────────────────────────────────────────────────────────────────
async function section2() {
  console.log('\n[S2] Fix 3 — PriceMatrixAgent.saveAllSafe');

  const PMA = require('../src/agents/PriceMatrixAgent');

  await t('saveAllSafe method exists on the agent', async () => {
    assert.strictEqual(typeof PMA.saveAllSafe, 'function');
  });

  await t('saveAllSafe blocks CUSTOMER accessing out-of-tree customer', async () => {
    mockQueryImpl = async (sql) => {
      if (sql.includes('WITH RECURSIVE')) return [[{ id: 10 }]]; // tree: only 10
      return [[]];
    };
    try {
      await PMA.saveAllSafe(99, { items: [] }, { role: 'CUSTOMER', id: 3, customer_id: 10 });
      throw new Error('no throw');
    } catch(e) { assert.strictEqual(e.status, 403, `Expected 403, got: ${e.message}`); }
  });

  await t('saveAllSafe allows ADMIN on any customer (getConnection stub)', async () => {
    const origGet = mockPool.getConnection;
    mockPool.getConnection = async () => ({
      beginTransaction: async () => {},
      query: async () => [[]],
      commit: async () => {},
      rollback: async () => {},
      release: () => {},
    });
    try {
      await PMA.saveAllSafe(99, { items: [] }, { role: 'ADMIN', id: 1 });
    } finally { mockPool.getConnection = origGet; }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Fix 4: getByToken SQL shape
// ─────────────────────────────────────────────────────────────────────────────
async function section3() {
  console.log('\n[S3] Fix 4 — OrderAgent.getByToken SQL');

  const src = fs.readFileSync(path.resolve(__dirname, '../src/agents/OrderAgent.js'), 'utf8');
  const start = src.indexOf('async getByToken(token)');
  const end   = src.indexOf('\n  async create(');
  const block = src.slice(start, end);

  await t('getByToken WHERE clause does NOT reference order_code', async () => {
    const bad = /private_token=\?.*OR.*order_code=\?/.test(block) ||
                /order_code=\?.*OR.*private_token=\?/.test(block);
    assert.ok(!bad, 'order_code must not appear alongside private_token in WHERE');
  });

  await t('getByToken WHERE clause uses only private_token', async () => {
    assert.ok(block.includes('WHERE o.private_token=?'), 'Must filter by private_token');
  });

  await t('getByToken binds token exactly once', async () => {
    assert.ok(!block.includes('[token, token]'), 'Must not bind token twice');
    assert.ok(block.includes('[token]'), 'Must bind token once');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — Fix 4: orders.js QR token
// ─────────────────────────────────────────────────────────────────────────────
async function section4() {
  console.log('\n[S4] Fix 4 — orders.js QR code no order_code fallback');

  const src = fs.readFileSync(path.resolve(__dirname, '../src/routes/orders.js'), 'utf8');
  const qrBlock = src.slice(src.indexOf('/:id/qrcode'), src.indexOf('\n router.get(\'/:id/print\''));

  await t('QR endpoint does not use order_code fallback', async () => {
    assert.ok(!qrBlock.includes('|| o.order_code'), 'Must not fall back to order_code');
    assert.ok(!qrBlock.includes('||o.order_code'),  'Must not fall back to order_code (no-space form)');
  });

  await t('QR endpoint uses only private_token', async () => {
    assert.ok(qrBlock.includes('o.private_token'), 'Must use private_token as the QR token');
  });

  await t('QR endpoint throws when private_token missing', async () => {
    assert.ok(qrBlock.includes('private_token') && qrBlock.includes('throw'),
      'Must throw an error if private_token is absent');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — Fix 5: PaymentAgent.update scope ordering
// ─────────────────────────────────────────────────────────────────────────────
async function section5() {
  console.log('\n[S5] Fix 5 — PaymentAgent.update pre-transaction scope check');

  const src = fs.readFileSync(path.resolve(__dirname, '../src/agents/PaymentAgent.js'), 'utf8');
  const start = src.indexOf('async update(paymentId, data, user)');
  const end   = src.indexOf('\n  async cancel(');
  const block = src.slice(start, end);

  await t('pool.query (scope lookup) appears before pool.getConnection', async () => {
    const qPos  = block.indexOf('pool.query');
    const gcPos = block.indexOf('pool.getConnection');
    assert.ok(qPos > -1 && gcPos > -1 && qPos < gcPos,
      'pool.query must come before pool.getConnection');
  });

  await t('assertCustomerScope called on old payment customer_id', async () => {
    assert.ok(block.includes('assertCustomerScope(user, prows[0].customer_id)'),
      'Must scope-check existing payment customer');
  });

  await t('assertCustomerScope called on new data.customer_id', async () => {
    assert.ok(block.includes('assertCustomerScope(user, data.customer_id)'),
      'Must scope-check requested new customer');
  });

  await t('old CUSTOMER equality check removed from update()', async () => {
    const oldPattern = /role === 'CUSTOMER'[^}]*old\.customer_id/.test(block);
    assert.ok(!oldPattern, 'Old equality-only check must be gone');
  });

  await t('CUSTOMER blocked before revertPaymentEffects when customer not in tree', async () => {
    let getConnCalled = false;
    mockQueryImpl = async (sql) => {
      if (sql.includes('FROM payments WHERE id=')) return [[{ customer_id: 99 }]];
      if (sql.includes('WITH RECURSIVE'))          return [[{ id: 10 }]]; // tree: only 10
      return [[]];
    };
    const origGet = mockPool.getConnection;
    mockPool.getConnection = async () => { getConnCalled = true; throw new Error('should not reach here'); };
    const PA = require('../src/agents/PaymentAgent');
    try {
      await PA.update(42, { cash_amount: 100, bank_amount: 0 }, { role: 'CUSTOMER', id: 3, customer_id: 10 });
      throw new Error('no throw');
    } catch(e) {
      assert.strictEqual(e.status, 403, `Expected 403, got: ${e.message}`);
      assert.ok(!getConnCalled, 'getConnection must not be called before scope check passes');
    } finally { mockPool.getConnection = origGet; }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — Fix 1 & 2: Route static guards
// ─────────────────────────────────────────────────────────────────────────────
async function section6() {
  console.log('\n[S6] Fix 1 & 2 — Route scope guards (static analysis)');

  const pm = fs.readFileSync(path.resolve(__dirname, '../src/routes/priceMatrix.js'), 'utf8');
  const pr = fs.readFileSync(path.resolve(__dirname, '../src/routes/products.js'), 'utf8');

  // priceMatrix.js
  await t('priceMatrix.js imports assertCustomerScope from scope middleware', async () => {
    assert.ok(pm.includes("require('../middleware/scope')") && pm.includes('assertCustomerScope'));
  });

  await t('priceMatrix.js defines assertBookScope helper', async () => {
    assert.ok(pm.includes('async function assertBookScope'));
  });

  await t('priceMatrix.js guards GET /:customerId/books', async () => {
    assert.ok(pm.includes("assertCustomerScope(req.user, req.params.customerId)"));
  });

  await t('priceMatrix.js guards GET /books/:bookId via assertBookScope', async () => {
    assert.ok(pm.includes('assertBookScope(req.params.bookId, req.user)'));
  });

  await t('priceMatrix.js guards PUT /books/:bookId via assertBookScope', async () => {
    const count = (pm.match(/assertBookScope\(req\.params\.bookId, req\.user\)/g) || []).length;
    assert.ok(count >= 3, `Expected at least 3 assertBookScope calls (GET/PUT/DELETE), got ${count}`);
  });

  await t('priceMatrix.js guards POST /copy for from_customer_id', async () => {
    assert.ok(pm.includes('assertCustomerScope(req.user, req.body.from_customer_id)'));
  });

  await t('priceMatrix.js guards POST /copy for to_customer_id', async () => {
    assert.ok(pm.includes('assertCustomerScope(req.user, req.body.to_customer_id)'));
  });

  await t('priceMatrix.js guards POST /books/:bookId/copy for target customer', async () => {
    assert.ok(pm.includes('assertCustomerScope(req.user, toCustomerId)'));
  });

  await t('priceMatrix.js route calls PriceMatrixAgent.saveAllSafe', async () => {
    assert.ok(pm.includes('PriceMatrixAgent.saveAllSafe'));
  });

  // products.js
  await t('products.js imports assertCustomerScope from scope middleware', async () => {
    assert.ok(pr.includes("require('../middleware/scope')") && pr.includes('assertCustomerScope'));
  });

  await t('products.js guards GET /customer/:customerId', async () => {
    const idx = pr.indexOf('/customer/:customerId');
    const routeBlock = pr.slice(idx, idx + 300);
    assert.ok(routeBlock.includes('assertCustomerScope(req.user, req.params.customerId)'));
  });

  await t('products.js guards PUT /customer-prices/:customerId/:productId', async () => {
    const idx = pr.indexOf('customer-prices');
    const routeBlock = pr.slice(idx, idx + 300);
    assert.ok(routeBlock.includes('assertCustomerScope(req.user, req.params.customerId)'));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  console.log('S1-002F Integration Verification');
  console.log('=================================');
  await section1();
  await section2();
  await section3();
  await section4();
  await section5();
  await section6();
  console.log('\n=================================');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
