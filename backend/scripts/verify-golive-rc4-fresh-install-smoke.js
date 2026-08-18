'use strict';
/**
 * GO-LIVE BLOCKER 3 — RC4 Phase 3: fresh-install functional sanity.
 *
 * Runs AFTER verify-p0-cr4-fresh-db-rehearsal.js has already proven the
 * schema itself reaches parity on an empty database. This script proves the
 * schema is actually USABLE — that a brand-new install (seeded users, no
 * customer/product/order data at all) can execute one real transaction in
 * every core domain, through the same Agent layer the app itself uses.
 *
 * ── REQUIRES A DISPOSABLE DATABASE ──────────────────────────────────────────
 * Same guard convention as verify-p0-cr4-fresh-db-rehearsal.js: refuses to
 * run against the configured application database.
 *
 *     CR4_FRESH_DB=meatbiz_cr4_rehearsal node scripts/verify-golive-rc4-fresh-install-smoke.js
 *
 * Not self-cleaning by design: this is a disposable rehearsal database meant
 * to be left for inspection (per the RC4 authorization), so fixtures created
 * here are left in place as visible proof rather than deleted.
 */
require('dotenv').config();

const TARGET = process.env.CR4_FRESH_DB;
const APP_DB = process.env.DB_NAME;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

async function main() {
  if (!TARGET) { console.error('CR4_FRESH_DB is not set — refusing to run.'); process.exit(2); }
  if (TARGET === APP_DB) { console.error(`CR4_FRESH_DB (${TARGET}) is the application database — refusing.`); process.exit(2); }

  process.env.DB_NAME = TARGET;
  const pool = require('../src/config/db');

  const [[who]] = await pool.query('SELECT DATABASE() db');
  if (who.db !== TARGET) { console.error(`pool connected to ${who.db}, not ${TARGET} — refusing.`); process.exit(2); }
  console.log(`=== RC4 Phase 3: fresh-install functional sanity (${TARGET}) ===\n`);

  const ProductAgent = require('../src/agents/ProductAgent');
  const CustomerAgent = require('../src/agents/CustomerAgent');
  const OrderAgent = require('../src/agents/OrderAgent');
  const PaymentAgent = require('../src/agents/PaymentAgent');
  const ReturnAgent = require('../src/agents/ReturnAgent');
  const InventoryAdjustmentAgent = require('../src/agents/InventoryAdjustmentAgent');
  const InventoryPurchaseAgent = require('../src/agents/InventoryPurchaseAgent');
  const InventoryReceiveService = require('../src/services/InventoryReceiveService');

  const admin = { id: null, role: 'ADMIN' };
  const today = new Date().toISOString().slice(0, 10);
  const tag = `RC4-${Date.now()}`;

  // ══════════════════ 1. Authentication / bootstrap prerequisites ══════════════════
  {
    const [[u]] = await pool.query(`SELECT * FROM users WHERE username='admin' LIMIT 1`);
    check('Auth: seed admin user exists', !!u, u);
    check('Auth: seed admin has role ADMIN', u && u.role === 'ADMIN', u && u.role);
    check('Auth: seed admin is_active', u && Number(u.is_active) !== 0, u && u.is_active);
    // Same comparison routes/auth.js POST /login performs: password_hash not
    // bcrypt ($2...) means the plaintext branch (gated by ALLOW_PLAIN_PASSWORD,
    // confirmed =true in backend/.env) is what actually authenticates a fresh
    // install's first login.
    const isBcrypt = u && String(u.password_hash || '').startsWith('$2');
    check('Auth: seed admin password_hash is the plaintext seed value (matches routes/auth.js login logic given ALLOW_PLAIN_PASSWORD=true)',
      u && !isBcrypt && u.password_hash === 'admin123', u && u.password_hash);
    const [[menuCount]] = await pool.query(`SELECT COUNT(*) c FROM app_menus`);
    check('Auth: app_menus seeded (RBAC bootstrap ran)', Number(menuCount.c) > 0, menuCount);
  }

  let productId = null, customerId = null, orderId = null, orderItemId = null;

  // ══════════════════ 2. Products ══════════════════
  {
    const name = `${tag} Product`;
    await ProductAgent.addProduct({ name, unit: 'kg', inventory_mode: 'TRACK_STOCK', sales_flow: 'INVENTORY_SALE', stock_quantity: 100, allow_negative_stock: 0 });
    const [[p]] = await pool.query(`SELECT * FROM products WHERE name=? LIMIT 1`, [name]);
    check('Products: product created on a fresh DB', !!p, p);
    check('Products: opening stock recorded', p && Number(p.stock_quantity) === 100, p && p.stock_quantity);
    productId = p && p.id;
  }

  // ══════════════════ 3. Partners / Customers ══════════════════
  {
    const result = await CustomerAgent.create({ name: `${tag} Customer`, phone: `09${String(Date.now()).slice(-6)}${String(Math.floor(Math.random()*90)+10)}`, partner_type: 2, default_sales_flow: 'INVENTORY_SALE', price_mode: 'PRIVATE_PRICE' }, admin);
    check('Customers: create() succeeds on a fresh DB', !!result && !!result.customer_code, result);
    const [[c]] = await pool.query(`SELECT * FROM customers WHERE customer_code=? LIMIT 1`, [result.customer_code]);
    check('Customers: row persisted', !!c, c);
    customerId = c && c.id;
  }

  // ══════════════════ 4. Orders (+ inventory deduction) ══════════════════
  if (productId && customerId) {
    const r = await OrderAgent.create({
      customer_id: customerId, order_date: today,
      items: [{ product_id: productId, product_name: 'x', unit: 'kg', quantity: 10, sale_price: 50000, manual_price: true }],
    }, admin);
    check('Orders: create() succeeds on a fresh DB', !!r && !!r.order_id, r);
    orderId = r && r.order_id;
    const [[oi]] = await pool.query(`SELECT id FROM order_items WHERE order_id=? LIMIT 1`, [orderId]);
    orderItemId = oi && oi.id;
    const [[order]] = await pool.query(`SELECT * FROM orders WHERE id=?`, [orderId]);
    check('Orders: debt posted (500,000)', order && Number(order.debt_amount) === 500000, order && order.debt_amount);
    const [[stock]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [productId]);
    check('Inventory: stock deducted by the sale (100 -> 90)', Number(stock.stock_quantity) === 90, stock);
    const [[debtTx]] = await pool.query(`SELECT COUNT(*) c FROM debt_transactions WHERE order_id=? AND type='SALE'`, [orderId]);
    check('Debt ledger: SALE row posted for the order', Number(debtTx.c) === 1, debtTx);
  } else {
    check('Orders: skipped (product/customer setup failed)', false);
  }

  // ══════════════════ 5. Inventory adjustment ══════════════════
  if (productId) {
    const adj = await InventoryAdjustmentAgent.create({
      product_id: productId, direction: 'INCREASE', quantity: 5, reason: 'FOUND', remark: `${tag} adjustment`,
    }, admin);
    check('Inventory: adjustment create() succeeds', !!adj, adj);
    const [[stock]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [productId]);
    check('Inventory: adjustment applied (90 -> 95)', Number(stock.stock_quantity) === 95, stock);
  }

  // ══════════════════ 6. Payments (+ idempotency) ══════════════════
  let paymentId = null;
  if (orderId && customerId) {
    const key = `${tag}-payment`;
    const pay = await PaymentAgent.create({ customer_id: customerId, order_id: orderId, cash_amount: 200000, bank_amount: 0, payment_date: today, idempotency_key: key }, admin);
    check('Payments: create() succeeds on a fresh DB', !!pay && !!pay.payment_id, pay);
    paymentId = pay && pay.payment_id;
    const [[order]] = await pool.query(`SELECT debt_amount FROM orders WHERE id=?`, [orderId]);
    check('Payments: debt reduced (500,000 -> 300,000)', order && Number(order.debt_amount) === 300000, order);
    const [[debtTx]] = await pool.query(`SELECT COUNT(*) c FROM debt_transactions WHERE order_id=? AND type='PAYMENT'`, [orderId]);
    check('Debt ledger: PAYMENT row posted', Number(debtTx.c) === 1, debtTx);
  }

  // ══════════════════ 7. Purchase / Receive schema ══════════════════
  {
    const [supIns] = await pool.query(
      `INSERT INTO suppliers(supplier_code,name,phone,address,is_active) VALUES(?,?,?,?,1)`,
      [`${tag}-SUP`, `${tag} Supplier`, '0', 'test']
    );
    const supplierId = supIns.insertId;
    const poProdName = `${tag} PO Product`;
    await ProductAgent.addProduct({ name: poProdName, unit: 'kg', inventory_mode: 'TRACK_STOCK', sales_flow: 'INVENTORY_SALE', stock_quantity: 0, allow_negative_stock: 0 });
    const [[poProduct]] = await pool.query(`SELECT * FROM products WHERE name=? LIMIT 1`, [poProdName]);

    const po = await InventoryPurchaseAgent.create({ supplier_id: supplierId, purchase_date: today }, admin.id);
    check('Purchase: PO create() succeeds', !!po && !!po.id, po);
    await InventoryPurchaseAgent.addItem(po.id, { product_id: poProduct.id, quantity: 20, purchase_price: 30000 }, admin.id);
    const poFull = await InventoryPurchaseAgent.get(po.id);
    check('Purchase: PO item added', poFull && poFull.items && poFull.items.length === 1, poFull);
    await InventoryPurchaseAgent.updateStatus(po.id, 'CONFIRMED', admin.id);
    const rv = await InventoryReceiveService.create({
      purchase_order_id: po.id, receive_date: today,
      items: [{ purchase_order_item_id: poFull.items[0].id, actual_stock_qty: 20 }],
    }, admin.id);
    await InventoryReceiveService.receive(rv.id, admin.id);
    const [[stockAfter]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [poProduct.id]);
    check('Receive: stock increased by the received qty (0 -> 20)', Number(stockAfter.stock_quantity) === 20, stockAfter);
  }

  // ══════════════════ 8. Sales Return schema (full lifecycle incl. settlement) ══════════════════
  if (orderId && orderItemId) {
    const ret = await ReturnAgent.create(orderId, {
      return_reason_code: 'QUALITY_COMPLAINT', items: [{ order_item_id: orderItemId, quantity_requested: 4 }],
    }, admin);
    check('Sales Return: create() succeeds on a fresh DB', !!ret && !!ret.return_id, ret);
    const returnId = ret.return_id;
    const lineId = ret.items[0].id;
    await ReturnAgent.receive(returnId, { items: [{ return_item_id: lineId, received_qty: 4 }] }, admin);
    await ReturnAgent.inspect(returnId, { items: [{ return_item_id: lineId, accepted_qty: 4, rejected_qty: 0, disposition: 'RESTOCK' }] }, admin);
    const completeResult = await ReturnAgent.complete(returnId, admin);
    check('Sales Return: complete() succeeds (accepted_qty x frozen price = 4 x 50,000 = 200,000)',
      completeResult && Number(completeResult.debt_reversal.reversal_computed) === 200000, completeResult && completeResult.debt_reversal);
    // Order debt is 300,000 at this point (500,000 - 200,000 payment); reversal
    // of 200,000 fits entirely within it -> pure debt reduction, no credit.
    check('Sales Return: reversal fully absorbed by remaining debt (no credit needed here)',
      completeResult && Number(completeResult.debt_reversal.reversal_applied) === 200000 && Number(completeResult.debt_reversal.credit_created) === 0,
      completeResult && completeResult.debt_reversal);
    const [[orderAfterReturn]] = await pool.query(`SELECT debt_amount FROM orders WHERE id=?`, [orderId]);
    check('Sales Return: order debt reduced (300,000 -> 100,000)', orderAfterReturn && Number(orderAfterReturn.debt_amount) === 100000, orderAfterReturn);

    // Now exercise the GO-LIVE BLOCKER 2 credit-settlement path too — pay the
    // remaining 100,000 in full, then return a second time so the reversal
    // exceeds the (now zero) remaining debt and must become a credit.
    const finalPay = await PaymentAgent.create({ customer_id: customerId, order_id: orderId, cash_amount: 100000, bank_amount: 0, payment_date: today, idempotency_key: `${tag}-payment-2` }, admin);
    check('Sales Return settlement setup: bill paid off in full', !!finalPay && !!finalPay.payment_id, finalPay);
    const [[orderPaidOff]] = await pool.query(`SELECT debt_amount FROM orders WHERE id=?`, [orderId]);
    check('Sales Return settlement setup: debt now 0', orderPaidOff && Number(orderPaidOff.debt_amount) === 0, orderPaidOff);

    const ret2 = await ReturnAgent.create(orderId, {
      return_reason_code: 'QUALITY_COMPLAINT', items: [{ order_item_id: orderItemId, quantity_requested: 2 }],
    }, admin);
    const lineId2 = ret2.items[0].id;
    await ReturnAgent.receive(ret2.return_id, { items: [{ return_item_id: lineId2, received_qty: 2 }] }, admin);
    await ReturnAgent.inspect(ret2.return_id, { items: [{ return_item_id: lineId2, accepted_qty: 2, rejected_qty: 0, disposition: 'RESTOCK' }] }, admin);
    const completeResult2 = await ReturnAgent.complete(ret2.return_id, admin);
    check('Sales Return settlement: reversal against a fully-paid bill becomes credit, not dropped',
      completeResult2 && Number(completeResult2.debt_reversal.reversal_applied) === 0 && Number(completeResult2.debt_reversal.credit_created) === 100000,
      completeResult2 && completeResult2.debt_reversal);
    const [[credit]] = await pool.query(`SELECT * FROM payment_unapplied_credits WHERE source_type='SALES_RETURN' AND source_id=?`, [ret2.return_id]);
    check('Sales Return settlement: payment_unapplied_credits row created for the excess', !!credit && Number(credit.remaining_amount) === 100000, credit);
  } else {
    check('Sales Return: skipped (order setup failed)', false);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(`\nNOTE: ${TARGET} fixtures left in place for inspection (not self-cleaning by design).`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
