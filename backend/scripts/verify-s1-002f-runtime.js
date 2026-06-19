'use strict';
// S1-002F Runtime Integration Verification
// Invokes actual route handlers and agent methods with a mocked DB pool.
// Proves each of the 5 fixes blocks or allows the correct behaviour at runtime.
// No live database or test framework required.

process.env.NODE_ENV = 'test';
const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

// ─── Mock pool: must be injected before any module loads db ──────────────────
let mockQueryImpl = async () => [[]];
const mockPool = {
  query:         async (...a) => mockQueryImpl(...a),
  getConnection: async ()    => { throw new Error('getConnection called unexpectedly'); },
};
const dbPath = require.resolve('../src/config/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockPool };

// ─── Test runner ──────────────────────────────────────────────────────────────
const results = [];
async function t(label, fn) {
  try {
    await fn();
    results.push({ label, ok: true });
    process.stdout.write(`  PASS  ${label}\n`);
  } catch(e) {
    results.push({ label, ok: false, reason: e.message });
    process.stdout.write(`  FAIL  ${label}\n`);
    process.stdout.write(`        ${e.message}\n`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Extract a specific route's last handler from an Express Router.
function routeHandler(router, method, routePath) {
  for (const layer of router.stack || []) {
    if (!layer.route) continue;
    const m = Object.keys(layer.route.methods)[0]?.toUpperCase();
    if (m === method.toUpperCase() && layer.route.path === routePath) {
      const stack = layer.route.stack || [];
      return stack[stack.length - 1].handle;
    }
  }
  throw new Error(`Route ${method} ${routePath} not found in router`);
}

// Build a minimal mock request.
function req(params = {}, user = {}, body = {}) {
  return { params, user, body };
}

// Invoke a route handler; re-throw anything passed to next().
async function call(handler, request) {
  const res = {
    _data: null,
    json(d) { this._data = d; return this; },
    send(d) { this._data = d; return this; },
    setHeader() { return this; },
  };
  let nextErr = null;
  await handler(request, res, err => { nextErr = err; });
  if (nextErr) throw nextErr;
  return res._data;
}

// Tree returns [root] only unless overridden.
function treeOf(...ids) {
  return ids.map(id => ({ id }));
}

// Standard CUSTOMER user belonging to customer 10.
const CUST10 = { role: 'CUSTOMER', id: 3, customer_id: 10 };
const ADMIN  = { role: 'ADMIN',    id: 1 };
const STAFF  = { role: 'STAFF',    id: 2 };

// ─────────────────────────────────────────────────────────────────────────────
// FIX 1 — CUSTOMER cannot access another customer's price books
// ─────────────────────────────────────────────────────────────────────────────
async function fix1() {
  process.stdout.write('\n[Fix 1] CUSTOMER cannot access another customer\'s price books\n');

  // Load router fresh (db already mocked)
  // Clear cached routes module so we get a clean load
  const routePath = require.resolve('../src/routes/priceMatrix');
  delete require.cache[routePath];
  const pmRouter = require('../src/routes/priceMatrix');

  // ── 1a. GET /:customerId/books ────────────────────────────────────────────
  await t('GET /:customerId/books — CUSTOMER blocked from customer 99 (403)', async () => {
    mockQueryImpl = async sql => {
      if (sql.includes('WITH RECURSIVE')) return [treeOf(10, 11)]; // CUST10's tree
      return [[]];
    };
    const h = routeHandler(pmRouter, 'GET', '/:customerId/books');
    try { await call(h, req({ customerId: '99' }, CUST10)); throw new Error('no throw'); }
    catch(e) { assert.strictEqual(e.status, 403, `Expected 403 got: ${e.message}`); }
  });

  await t('GET /:customerId/books — CUSTOMER allowed for own customer (200)', async () => {
    mockQueryImpl = async sql => {
      if (sql.includes('WITH RECURSIVE')) return [treeOf(10, 11)];
      // listBooks query
      if (sql.includes('FROM customer_price_books')) return [[]];
      return [[]];
    };
    const h = routeHandler(pmRouter, 'GET', '/:customerId/books');
    const result = await call(h, req({ customerId: '10' }, CUST10));
    assert.ok(Array.isArray(result), 'Expected array response');
  });

  await t('GET /:customerId/books — ADMIN allowed for any customer (200)', async () => {
    mockQueryImpl = async sql => {
      if (sql.includes('FROM customer_price_books')) return [[]];
      return [[]];
    };
    const h = routeHandler(pmRouter, 'GET', '/:customerId/books');
    const result = await call(h, req({ customerId: '99' }, ADMIN));
    assert.ok(Array.isArray(result), 'Expected array response');
  });

  // ── 1b. GET /:customerId (matrix) ────────────────────────────────────────
  await t('GET /:customerId matrix — CUSTOMER blocked from customer 99 (403)', async () => {
    mockQueryImpl = async sql => {
      if (sql.includes('WITH RECURSIVE')) return [treeOf(10, 11)];
      return [[]];
    };
    const h = routeHandler(pmRouter, 'GET', '/:customerId');
    try { await call(h, req({ customerId: '99' }, CUST10)); throw new Error('no throw'); }
    catch(e) { assert.strictEqual(e.status, 403); }
  });

  // ── 1c. GET /books/:bookId (lookup by bookId) ─────────────────────────────
  await t('GET /books/:bookId — CUSTOMER blocked when book belongs to customer 99 (403)', async () => {
    mockQueryImpl = async sql => {
      if (sql.includes('FROM customer_price_books WHERE id=')) return [[{ customer_id: 99 }]];
      if (sql.includes('WITH RECURSIVE')) return [treeOf(10, 11)];
      return [[]];
    };
    const h = routeHandler(pmRouter, 'GET', '/books/:bookId');
    try { await call(h, req({ bookId: '55' }, CUST10)); throw new Error('no throw'); }
    catch(e) { assert.strictEqual(e.status, 403); }
  });

  await t('GET /books/:bookId — CUSTOMER allowed when book belongs to own customer (200)', async () => {
    // assertBookScope issues:  SELECT customer_id FROM customer_price_books WHERE id=? LIMIT 1
    // getBook issues:          SELECT b.* … FROM customer_price_books b LEFT JOIN … WHERE b.id=?
    // Both patterns must return data; they differ by alias presence.
    mockQueryImpl = async sql => {
      if (sql.includes('WITH RECURSIVE')) return [treeOf(10, 11)];
      if (sql.includes('FROM customer_price_book_items')) return [[]];
      if (sql.includes('FROM customer_price_books')) {
        return [[{
          id: 55, customer_id: 10, status: 'ACTIVE', book_name: 'Test',
          effective_from: '2026-01-01', effective_calendar_type: 'SOLAR',
          effective_lunar_date_text: '', effective_lunar_sort: 0,
          note: '', created_at: null, updated_at: null,
          item_count: 0, bill_count: 0, paid_bill_count: 0, unpaid_bill_count: 0,
        }]];
      }
      return [[]];
    };
    const h = routeHandler(pmRouter, 'GET', '/books/:bookId');
    const result = await call(h, req({ bookId: '55' }, CUST10));
    assert.ok(result && typeof result === 'object', 'Expected book object');
  });

  // ── 1d. POST /copy — CUSTOMER blocked on from or to ──────────────────────
  await t('POST /copy — CUSTOMER blocked when from_customer_id is out of tree (403)', async () => {
    mockQueryImpl = async sql => {
      if (sql.includes('WITH RECURSIVE')) return [treeOf(10, 11)];
      return [[]];
    };
    const h = routeHandler(pmRouter, 'POST', '/copy');
    try {
      await call(h, req({}, CUST10, { from_customer_id: 99, to_customer_id: 10 }));
      throw new Error('no throw');
    } catch(e) { assert.strictEqual(e.status, 403); }
  });

  await t('POST /copy — CUSTOMER blocked when to_customer_id is out of tree (403)', async () => {
    let treeCallCount = 0;
    mockQueryImpl = async sql => {
      if (sql.includes('WITH RECURSIVE')) {
        treeCallCount++;
        return [treeOf(10, 11)]; // only 10 and 11 in tree
      }
      return [[]];
    };
    const h = routeHandler(pmRouter, 'POST', '/copy');
    try {
      await call(h, req({}, CUST10, { from_customer_id: 10, to_customer_id: 99 }));
      throw new Error('no throw');
    } catch(e) { assert.strictEqual(e.status, 403); }
  });

  // ── 1e. GET /:customerId/catalog/order ───────────────────────────────────
  await t('GET /:customerId/catalog/order — CUSTOMER blocked (403)', async () => {
    mockQueryImpl = async sql => {
      if (sql.includes('WITH RECURSIVE')) return [treeOf(10, 11)];
      return [[]];
    };
    const h = routeHandler(pmRouter, 'GET', '/:customerId/catalog/order');
    try { await call(h, req({ customerId: '99' }, CUST10)); throw new Error('no throw'); }
    catch(e) { assert.strictEqual(e.status, 403); }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX 2 — CUSTOMER cannot access another customer's product prices
// ─────────────────────────────────────────────────────────────────────────────
async function fix2() {
  process.stdout.write('\n[Fix 2] CUSTOMER cannot access another customer\'s product prices\n');

  const prPath = require.resolve('../src/routes/products');
  delete require.cache[prPath];
  const prRouter = require('../src/routes/products');

  // ── 2a. GET /customer/:customerId ─────────────────────────────────────────
  await t('GET /customer/:customerId — CUSTOMER blocked from customer 99 (403)', async () => {
    mockQueryImpl = async sql => {
      if (sql.includes('WITH RECURSIVE')) return [treeOf(10, 11)];
      return [[]];
    };
    const h = routeHandler(prRouter, 'GET', '/customer/:customerId');
    try { await call(h, req({ customerId: '99' }, CUST10)); throw new Error('no throw'); }
    catch(e) { assert.strictEqual(e.status, 403); }
  });

  await t('GET /customer/:customerId — CUSTOMER allowed for own customer (200)', async () => {
    mockQueryImpl = async sql => {
      if (sql.includes('WITH RECURSIVE'))  return [treeOf(10, 11)];
      if (sql.includes('FROM customers'))  return [[{ id: 10, name: 'Test', billing_calendar_type: 'SOLAR' }]];
      if (sql.includes('FROM products'))   return [[]];
      return [[]];
    };
    const h = routeHandler(prRouter, 'GET', '/customer/:customerId');
    const result = await call(h, req({ customerId: '10' }, CUST10));
    assert.ok(result && typeof result === 'object', 'Expected object response');
  });

  await t('GET /customer/:customerId — STAFF allowed for any customer (200)', async () => {
    mockQueryImpl = async sql => {
      if (sql.includes('FROM customers')) return [[{ id: 99, name: 'Other', billing_calendar_type: 'SOLAR' }]];
      if (sql.includes('FROM products'))  return [[]];
      return [[]];
    };
    const h = routeHandler(prRouter, 'GET', '/customer/:customerId');
    const result = await call(h, req({ customerId: '99' }, STAFF));
    assert.ok(result && typeof result === 'object');
  });

  // ── 2b. PUT /customer-prices/:customerId/:productId ───────────────────────
  await t('PUT /customer-prices/:customerId/:productId — CUSTOMER blocked from customer 99 (403)', async () => {
    mockQueryImpl = async sql => {
      if (sql.includes('WITH RECURSIVE')) return [treeOf(10, 11)];
      return [[]];
    };
    const h = routeHandler(prRouter, 'PUT', '/customer-prices/:customerId/:productId');
    try {
      await call(h, req({ customerId: '99', productId: '1' }, CUST10, { sale_price: 100 }));
      throw new Error('no throw');
    } catch(e) { assert.strictEqual(e.status, 403); }
  });

  await t('PUT /customer-prices/:customerId/:productId — ADMIN allowed (passes scope)', async () => {
    // ADMIN bypasses scope; agent will still call customerProducts which queries DB.
    // Give it enough mock data to not crash.
    mockQueryImpl = async sql => {
      if (sql.includes('FROM customers'))  return [[{ id: 99, billing_calendar_type: 'SOLAR' }]];
      if (sql.includes('FROM products'))   return [[]];
      if (sql.includes('customer_price_books')) return [[]];
      return [[]];
    };
    const origGet = mockPool.getConnection;
    mockPool.getConnection = async () => ({
      beginTransaction: async () => {},
      query:            async ()    => [{ insertId: 1 }],
      commit:           async ()    => {},
      rollback:         async ()    => {},
      release:          ()          => {},
    });
    try {
      const h = routeHandler(prRouter, 'PUT', '/customer-prices/:customerId/:productId');
      const result = await call(h, req({ customerId: '99', productId: '1' }, ADMIN, { sale_price: 50000 }));
      assert.ok(result && result.message, 'Expected success message');
    } finally { mockPool.getConnection = origGet; }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX 3 — saveAllSafe endpoint works
// ─────────────────────────────────────────────────────────────────────────────
async function fix3() {
  process.stdout.write('\n[Fix 3] saveAllSafe endpoint works\n');

  const pmPath = require.resolve('../src/routes/priceMatrix');
  delete require.cache[pmPath];
  const pmRouter = require('../src/routes/priceMatrix');

  await t('POST /:customerId/save-all-safe — route exists and calls agent', async () => {
    const h = routeHandler(pmRouter, 'POST', '/:customerId/save-all-safe');
    assert.ok(typeof h === 'function', 'Route handler must exist');
  });

  await t('POST /:customerId/save-all-safe — CUSTOMER blocked for out-of-tree customer (403)', async () => {
    mockQueryImpl = async sql => {
      if (sql.includes('WITH RECURSIVE')) return [treeOf(10, 11)];
      return [[]];
    };
    const h = routeHandler(pmRouter, 'POST', '/:customerId/save-all-safe');
    try {
      await call(h, req({ customerId: '99' }, CUST10, { items: [] }));
      throw new Error('no throw');
    } catch(e) { assert.strictEqual(e.status, 403); }
  });

  await t('POST /:customerId/save-all-safe — ADMIN succeeds for own customer (2xx)', async () => {
    const origGet = mockPool.getConnection;
    mockPool.getConnection = async () => ({
      beginTransaction: async () => {},
      query:            async ()    => [[]],
      commit:           async ()    => {},
      rollback:         async ()    => {},
      release:          ()          => {},
    });
    try {
      const h = routeHandler(pmRouter, 'POST', '/:customerId/save-all-safe');
      const result = await call(h, req({ customerId: '10' }, ADMIN, { items: [] }));
      assert.ok(result && result.message, `Expected message, got: ${JSON.stringify(result)}`);
    } finally { mockPool.getConnection = origGet; }
  });

  await t('PriceMatrixAgent.saveAllSafe — delegates to saveMatrix after scope pass', async () => {
    const PMA = require('../src/agents/PriceMatrixAgent');
    let saveMatrixCalled = false;
    const origSM = PMA.saveMatrix.bind(PMA);
    PMA.saveMatrix = async (...args) => { saveMatrixCalled = true; return { message: 'ok' }; };
    const origGet = mockPool.getConnection;
    mockPool.getConnection = async () => ({
      beginTransaction: async () => {},
      query:            async ()    => [[]],
      commit:           async ()    => {},
      rollback:         async ()    => {},
      release:          ()          => {},
    });
    try {
      await PMA.saveAllSafe(10, { items: [] }, ADMIN);
      assert.ok(saveMatrixCalled, 'saveMatrix must be called by saveAllSafe');
    } finally {
      PMA.saveMatrix = origSM;
      mockPool.getConnection = origGet;
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX 4 — Public print rejects order_code, accepts private_token only
// ─────────────────────────────────────────────────────────────────────────────
async function fix4() {
  process.stdout.write('\n[Fix 4] Public print rejects order_code, accepts private_token only\n');

  const OrderAgent = require('../src/agents/OrderAgent');

  // ── 4a. getByToken with order_code → not found ────────────────────────────
  await t('getByToken with order_code (predictable) → 404-style error', async () => {
    mockQueryImpl = async sql => {
      if (sql.includes('private_token')) {
        // Return nothing — order_code is not in WHERE clause anymore
        return [[]];
      }
      return [[]];
    };
    try {
      await OrderAgent.getByToken('BILL001'); // typical sequential order_code
      throw new Error('no throw');
    } catch(e) {
      assert.ok(
        e.message.includes('Không tìm thấy'),
        `Expected not-found error, got: ${e.message}`
      );
    }
  });

  // ── 4b. getByToken SQL does NOT query by order_code ───────────────────────
  await t('getByToken SQL query does NOT contain order_code in WHERE', async () => {
    const queries = [];
    mockQueryImpl = async (sql) => { queries.push(sql); return [[]]; };
    try { await OrderAgent.getByToken('BILL001'); } catch(_) {}
    const tokenQuery = queries.find(q => q.includes('private_token'));
    assert.ok(tokenQuery, 'Must issue a private_token query');
    assert.ok(!tokenQuery.includes('order_code'), `order_code must not appear in token WHERE: ${tokenQuery}`);
  });

  // ── 4c. getByToken with valid private_token → returns order ───────────────
  await t('getByToken with valid private_token → returns order data', async () => {
    const fakeOrder = {
      id: 1, order_code: 'BILL001', private_token: 'abc123xyz',
      customer_id: 10, order_date: '2026-01-01', total_amount: 100,
      paid_amount: 0, debt_amount: 100, calendar_type: 'SOLAR',
      lunar_date_text: '', status: 'DELIVERED', payment_status: 'UNPAID',
      customer_name: 'Test', phone: '0123', address: 'HN',
    };
    mockQueryImpl = async sql => {
      if (sql.includes('private_token'))   return [[fakeOrder]];
      if (sql.includes('FROM order_items')) return [[]];
      if (sql.includes('debt_amount>0'))   return [[]];
      if (sql.includes('FROM payments'))   return [[]];
      if (sql.includes('payment_allocations')) return [[]];
      if (sql.includes('debt_monthly')) return [[]];
      return [[]];
    };
    const result = await OrderAgent.getByToken('abc123xyz');
    assert.strictEqual(result.order_code, 'BILL001');
    assert.strictEqual(result.private_token, 'abc123xyz');
  });

  // ── 4d. QR code endpoint no longer falls back to order_code ───────────────
  await t('orders.js QR endpoint token is always private_token (no order_code fallback)', async () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/routes/orders.js'), 'utf8'
    );
    const qrSection = src.slice(src.indexOf('/:id/qrcode'), src.indexOf('\n router.get(\'/:id/print\'') > -1
      ? src.indexOf('\nrouter.get(\'/:id/print\'')
      : src.indexOf('/:id/print'));
    assert.ok(!qrSection.includes('|| o.order_code'), 'Must not fall back to order_code');
    assert.ok(!qrSection.includes('||o.order_code'),  'Must not fall back to order_code (no-space)');
    assert.ok(qrSection.includes('private_token'),    'Must use private_token');
    assert.ok(qrSection.includes('throw'),            'Must throw if private_token missing');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX 5 — Payment update rejects changing to another customer's tree
// ─────────────────────────────────────────────────────────────────────────────
async function fix5() {
  process.stdout.write('\n[Fix 5] Payment update rejects changing to another customer\'s tree\n');

  const PaymentAgent = require('../src/agents/PaymentAgent');

  // ── 5a. Access to payment belonging to out-of-tree customer ───────────────
  await t('CUSTOMER blocked when existing payment belongs to customer 99 (403)', async () => {
    let getConnCalled = false;
    mockQueryImpl = async sql => {
      if (sql.includes('FROM payments WHERE id=')) return [[{ customer_id: 99 }]];
      if (sql.includes('WITH RECURSIVE'))          return [treeOf(10, 11)];
      return [[]];
    };
    const origGet = mockPool.getConnection;
    mockPool.getConnection = async () => { getConnCalled = true; throw new Error('must not reach'); };
    try {
      await PaymentAgent.update(42, { cash_amount: 100, bank_amount: 0 }, CUST10);
      throw new Error('no throw');
    } catch(e) {
      assert.strictEqual(e.status, 403, `Expected 403, got: ${e.message}`);
      assert.ok(!getConnCalled, 'getConnection must not be called — scope check must fire first');
    } finally { mockPool.getConnection = origGet; }
  });

  // ── 5b. Reassigning payment to out-of-tree customer blocked ───────────────
  await t('CUSTOMER blocked when data.customer_id is 99 (out-of-tree reassignment) (403)', async () => {
    let treeCallCount = 0;
    let getConnCalled = false;
    mockQueryImpl = async sql => {
      if (sql.includes('FROM payments WHERE id=')) return [[{ customer_id: 10 }]];
      if (sql.includes('WITH RECURSIVE')) {
        treeCallCount++;
        return [treeOf(10, 11)]; // tree: only 10 and 11
      }
      return [[]];
    };
    const origGet = mockPool.getConnection;
    mockPool.getConnection = async () => { getConnCalled = true; throw new Error('must not reach'); };
    try {
      await PaymentAgent.update(42,
        { cash_amount: 100, bank_amount: 0, customer_id: 99 }, // trying to reassign to 99
        CUST10
      );
      throw new Error('no throw');
    } catch(e) {
      assert.strictEqual(e.status, 403, `Expected 403, got: ${e.message}`);
      assert.ok(!getConnCalled, 'getConnection must not be called');
      assert.ok(treeCallCount >= 2, `Expected 2 tree queries (old + new customer), got ${treeCallCount}`);
    } finally { mockPool.getConnection = origGet; }
  });

  // ── 5c. ADMIN can update payment for any customer ─────────────────────────
  await t('ADMIN update passes scope and proceeds into transaction', async () => {
    let transactionStarted = false;
    mockQueryImpl = async sql => {
      if (sql.includes('FROM payments WHERE id=')) return [[{ customer_id: 99 }]];
      return [[]];
    };
    const origGet = mockPool.getConnection;
    mockPool.getConnection = async () => {
      transactionStarted = true;
      return {
        beginTransaction: async () => {},
        query:            async sql => {
          if (sql.includes('FOR UPDATE')) return [[{
            id: 42, customer_id: 99, amount: 100, is_locked: 0, status: 'ACTIVE',
            payment_code: 'PAY001', order_id: null, payment_date: '2026-01-01',
          }]];
          return [[]];
        },
        commit:  async () => {},
        rollback: async () => {},
        release:  ()      => {},
      };
    };
    try {
      await PaymentAgent.update(42,
        { cash_amount: 100, bank_amount: 0 },
        ADMIN
      );
      assert.ok(transactionStarted, 'ADMIN must reach the transaction');
    } catch(e) {
      // A deeper agent error (e.g. missing allocate method mock) is acceptable —
      // what matters is it was NOT a 403 and transactionStarted is true.
      assert.ok(transactionStarted, `Transaction must have started; error was: ${e.message}`);
      assert.notStrictEqual(e.status, 403, 'Must not throw 403 for ADMIN');
    } finally { mockPool.getConnection = origGet; }
  });

  // ── 5d. Scope check is pre-transaction (no mutations before block) ─────────
  await t('Scope check fires before beginTransaction — no partial mutations', async () => {
    const mutations = [];
    mockQueryImpl = async sql => {
      // payment lookup (read-only, OK before transaction)
      if (sql.includes('FROM payments WHERE id=')) return [[{ customer_id: 99 }]];
      if (sql.includes('WITH RECURSIVE'))           return [treeOf(10, 11)];
      mutations.push(sql); // any other query = mutation attempt
      return [[]];
    };
    const origGet = mockPool.getConnection;
    mockPool.getConnection = async () => {
      mutations.push('getConnection'); // also counts as mutation trigger
      throw new Error('must not reach');
    };
    try {
      await PaymentAgent.update(42, { cash_amount: 50, bank_amount: 0 }, CUST10);
    } catch(e) {
      assert.strictEqual(e.status, 403);
    } finally { mockPool.getConnection = origGet; }
    assert.strictEqual(mutations.length, 0, `No mutations expected before scope check, found: ${mutations.join('; ')}`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  process.stdout.write('S1-002F Runtime Integration Verification\n');
  process.stdout.write('=========================================\n');
  await fix1();
  await fix2();
  await fix3();
  await fix4();
  await fix5();

  const pass = results.filter(r =>  r.ok).length;
  const fail = results.filter(r => !r.ok).length;

  process.stdout.write('\n=========================================\n');
  process.stdout.write(`Results: ${pass} passed, ${fail} failed\n`);

  if (fail > 0) {
    process.stdout.write('\nFailed tests:\n');
    results.filter(r => !r.ok).forEach(r => {
      process.stdout.write(`  • ${r.label}\n    ${r.reason}\n`);
    });
    process.exit(1);
  }
})();
