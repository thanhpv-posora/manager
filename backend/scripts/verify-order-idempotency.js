'use strict';
// Verifies S6.5's order-creation idempotency (OrderAgent.create + orders.idempotency_key).
//
// Covers exactly the scenarios demonstrated broken in the S6.4 Business Acceptance
// Report (Scenario 20): duplicate click, duplicate HTTP-level call, truly concurrent
// requests, and retry-after-timeout — all with the SAME idempotency_key must resolve
// to ONE order and ONE inventory deduction. Also proves normal (no key / different
// key) behavior is completely unaffected — this must never block two genuinely
// different bills.
//
// Self-cleaning: throwaway customer + products + orders, removed in `finally`.

const pool = require('../src/config/db');
const OrderAgent = require('../src/agents/OrderAgent');
const ProductAgent = require('../src/agents/ProductAgent');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}

async function getProduct(id) {
  const [[row]] = await pool.query(`SELECT * FROM products WHERE id=?`, [id]);
  return row;
}

async function makeTrackedProduct(qty) {
  await ProductAgent.addProduct({ name: `S6.5 IDEMP ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, unit: 'kg', inventory_mode: 'TRACK_STOCK', stock_quantity: qty, allow_negative_stock: 0 });
  const [[created]] = await pool.query(`SELECT id, stock_quantity FROM products WHERE name LIKE 'S6.5 IDEMP %' ORDER BY id DESC LIMIT 1`);
  return created;
}

async function main() {
  const productIds = [];
  const orderIds = [];
  let customerId = null;
  const user = { id: null };
  const today = new Date().toISOString().slice(0, 10);

  try {
    const [custIns] = await pool.query(
      `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type)
       VALUES(?,?,?,?,?,?,?,?)`,
      [`S65-CUST-${Date.now()}`, 'S6.5 Idempotency Test Customer', '0', 'test', 'PRIVATE_PRICE', 0, 0, 'SOLAR']
    );
    customerId = custIns.insertId;

    const orderPayload = (productId, key) => ({
      customer_id: customerId, order_date: today,
      items: [{ product_id: productId, product_name: 'x', unit: 'kg', quantity: 5, sale_price: 10000, manual_price: true }],
      idempotency_key: key,
    });

    // ── Case 1: Duplicate click — two SEQUENTIAL calls, same key ──
    {
      const p = await makeTrackedProduct(100);
      productIds.push(p.id);
      const key = 'test-key-duplicate-click-' + Date.now();
      const r1 = await OrderAgent.create(orderPayload(p.id, key), user);
      const r2 = await OrderAgent.create(orderPayload(p.id, key), user);
      orderIds.push(r1.order_id, r2.order_id);
      check('Case 1 (duplicate click): same order_id returned both times', r1.order_id === r2.order_id, `${r1.order_id} vs ${r2.order_id}`);
      const after = await getProduct(p.id);
      check('Case 1 (duplicate click): stock deducted only ONCE (100→95)', Number(after.stock_quantity) === 95, after.stock_quantity);
      const [[count]] = await pool.query(`SELECT COUNT(*) c FROM orders WHERE idempotency_key=?`, [key]);
      check('Case 1 (duplicate click): only ONE order row exists with this key', Number(count.c) === 1, count.c);
    }

    // ── Case 2: Duplicate HTTP-level call — same shape, calling the agent method
    //    directly twice in a row (equivalent to two separate POST /orders hitting
    //    the same Express handler back to back) ──
    {
      const p = await makeTrackedProduct(50);
      productIds.push(p.id);
      const key = 'test-key-duplicate-http-' + Date.now();
      const r1 = await OrderAgent.create(orderPayload(p.id, key), user);
      const r2 = await OrderAgent.create(orderPayload(p.id, key), user);
      orderIds.push(r1.order_id, r2.order_id);
      check('Case 2 (duplicate HTTP): same order_id', r1.order_id === r2.order_id, `${r1.order_id} vs ${r2.order_id}`);
      const after = await getProduct(p.id);
      check('Case 2 (duplicate HTTP): stock deducted only once (50→45)', Number(after.stock_quantity) === 45, after.stock_quantity);
    }

    // ── Case 3: Concurrent request — two TRULY PARALLEL calls, same key ──
    {
      const p = await makeTrackedProduct(100);
      productIds.push(p.id);
      const key = 'test-key-concurrent-' + Date.now();
      const [r1, r2] = await Promise.all([
        OrderAgent.create(orderPayload(p.id, key), user),
        OrderAgent.create(orderPayload(p.id, key), user),
      ]);
      orderIds.push(r1.order_id, r2.order_id);
      check('Case 3 (concurrent): both calls resolved to the SAME order_id', r1.order_id === r2.order_id, `${r1.order_id} vs ${r2.order_id}`);
      const after = await getProduct(p.id);
      check('Case 3 (concurrent): stock deducted only ONCE despite two parallel requests (100→95)', Number(after.stock_quantity) === 95, after.stock_quantity);
      const [[count]] = await pool.query(`SELECT COUNT(*) c FROM orders WHERE idempotency_key=?`, [key]);
      check('Case 3 (concurrent): only ONE order row exists with this key', Number(count.c) === 1, count.c);
    }

    // ── Case 4: Retry after timeout — same key, calls separated by a real delay
    //    (simulating "user waited, thought it failed, tried again minutes later") ──
    {
      const p = await makeTrackedProduct(30);
      productIds.push(p.id);
      const key = 'test-key-retry-timeout-' + Date.now();
      const r1 = await OrderAgent.create(orderPayload(p.id, key), user);
      await new Promise(resolve => setTimeout(resolve, 300)); // simulate a delay
      const r2 = await OrderAgent.create(orderPayload(p.id, key), user);
      orderIds.push(r1.order_id, r2.order_id);
      check('Case 4 (retry after delay): same order_id', r1.order_id === r2.order_id, `${r1.order_id} vs ${r2.order_id}`);
      const after = await getProduct(p.id);
      check('Case 4 (retry after delay): stock deducted only once (30→25)', Number(after.stock_quantity) === 25, after.stock_quantity);
    }

    // ── Negative control A: DIFFERENT keys → two genuinely different orders,
    //    both deduct stock. Must never be blocked. ──
    {
      const p = await makeTrackedProduct(100);
      productIds.push(p.id);
      const r1 = await OrderAgent.create(orderPayload(p.id, 'test-key-A-' + Date.now()), user);
      const r2 = await OrderAgent.create(orderPayload(p.id, 'test-key-B-' + Date.now()), user);
      orderIds.push(r1.order_id, r2.order_id);
      check('Negative control A: different keys create TWO distinct orders', r1.order_id !== r2.order_id, `${r1.order_id} vs ${r2.order_id}`);
      const after = await getProduct(p.id);
      check('Negative control A: stock deducted TWICE (100→90), legitimate separate sales unaffected', Number(after.stock_quantity) === 90, after.stock_quantity);
    }

    // ── Negative control B: NO key at all (legacy/AI caller) → unaffected,
    //    behaves exactly as before this change, still allows two orders. ──
    {
      const p = await makeTrackedProduct(100);
      productIds.push(p.id);
      const r1 = await OrderAgent.create({ customer_id: customerId, order_date: today, items: [{ product_id: p.id, product_name: 'x', unit: 'kg', quantity: 5, sale_price: 10000, manual_price: true }] }, user);
      const r2 = await OrderAgent.create({ customer_id: customerId, order_date: today, items: [{ product_id: p.id, product_name: 'x', unit: 'kg', quantity: 5, sale_price: 10000, manual_price: true }] }, user);
      orderIds.push(r1.order_id, r2.order_id);
      check('Negative control B: no idempotency_key → unaffected, still creates two orders (backward compatible)', r1.order_id !== r2.order_id, `${r1.order_id} vs ${r2.order_id}`);
      const after = await getProduct(p.id);
      check('Negative control B: stock deducted twice as before this change (100→90)', Number(after.stock_quantity) === 90, after.stock_quantity);
    }

  } finally {
    for (const oid of orderIds) {
      if (!oid) continue;
      await pool.query(`DELETE FROM order_items WHERE order_id=?`, [oid]);
      await pool.query(`DELETE FROM debt_transactions WHERE order_id=?`, [oid]);
      await pool.query(`DELETE FROM orders WHERE id=?`, [oid]);
    }
    for (const id of productIds) {
      await pool.query(`DELETE FROM stock_transactions WHERE product_id=?`, [id]);
      await pool.query(`DELETE FROM products WHERE id=?`, [id]);
    }
    if (customerId) {
      await pool.query(`DELETE FROM customer_product_catalogs WHERE customer_id=?`, [customerId]);
      await pool.query(`DELETE FROM customer_product_prices WHERE customer_id=?`, [customerId]);
      await pool.query(`DELETE FROM customers WHERE id=?`, [customerId]);
    }
    console.log('Cleanup done.');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
