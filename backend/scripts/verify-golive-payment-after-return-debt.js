'use strict';
// GO-LIVE BLOCKER 3 — "Payment after Sales Return must never resurrect debt
// that was already reversed by the return."
//
// Root cause (three call sites in PaymentAgent.js all shared the same flaw):
// PaymentAgent.ensureOrderPayableTotal(), .applyPaymentToOrder(), and
// .recalcOrderAfterPaymentChange() each derived an order's debt from
// total_amount-paid_amount arithmetic. total_amount is immutable
// (BR-BILL-004/BR-PRICE-002 — ReturnAgent.complete() never rewrites it) and
// paid_amount only tracks cash payments, never a return's debt forgiveness —
// so any payment made AFTER a return had reversed debt on that order
// silently resurrected exactly the amount the return had already forgiven.
// Fix: derive debt from the order's own debt_transactions ledger (or, for
// the payment-cancel path, restore by the exact delta being reverted)
// instead of total-paid. This script proves the fix and that it changes
// NOTHING about the normal (no-return) path.
//
// Same convention as the other verify-golive-*.js scripts: real pool,
// self-cleaning, pass/fail counters, no external test framework. Every
// scenario gets its own customer (PaymentAgent's real "auto-allocate to
// oldest unpaid bill" feature would otherwise cross-contaminate scenarios
// sharing a customer — see [[project_golive_audit_state]] insight #6).

const pool = require('../src/config/db');
const OrderAgent = require('../src/agents/OrderAgent');
const PaymentAgent = require('../src/agents/PaymentAgent');
const ReturnAgent = require('../src/agents/ReturnAgent');
const ProductAgent = require('../src/agents/ProductAgent');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

const admin = { id: null, role: 'ADMIN' };
const today = new Date().toISOString().slice(0, 10);

async function makeCustomer(tag) {
  const [ins] = await pool.query(
    `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type,default_sales_flow)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    [`GLPAR-${tag}-${Date.now()}`, `GO-LIVE PayAfterReturn Test ${tag}`, '0', 'test', 'PRIVATE_PRICE', 0, 0, 'SOLAR', 'INVENTORY_SALE']
  );
  return ins.insertId;
}
async function makeProduct(qty) {
  const name = `GLPAR-PRODUCT ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await ProductAgent.addProduct({ name, unit: 'kg', inventory_mode: 'TRACK_STOCK', sales_flow: 'INVENTORY_SALE', stock_quantity: qty, allow_negative_stock: 0 });
  const [[created]] = await pool.query(`SELECT * FROM products WHERE name=? LIMIT 1`, [name]);
  return created;
}
async function makeOrder(customerId, productId, qty, price) {
  const r = await OrderAgent.create({
    customer_id: customerId, order_date: today,
    items: [{ product_id: productId, product_name: 'x', unit: 'kg', quantity: qty, sale_price: price, manual_price: true }],
  }, admin);
  return r.order_id;
}
async function orderRow(orderId) {
  const [[r]] = await pool.query(`SELECT * FROM orders WHERE id=?`, [orderId]);
  return r;
}
async function ledgerSumForOrder(orderId) {
  const [[r]] = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN type IN ('SALE','ADJUSTMENT_INCREASE') THEN amount WHEN type IN ('PAYMENT','ADJUSTMENT_DECREASE') THEN -amount ELSE 0 END),0) net
     FROM debt_transactions WHERE order_id=?`, [orderId]
  );
  return Number(r.net);
}
async function ledgerVsOrdersReconciled(customerId) {
  const [[ledger]] = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN type IN ('SALE','ADJUSTMENT_INCREASE') THEN amount WHEN type IN ('PAYMENT','ADJUSTMENT_DECREASE') THEN -amount ELSE 0 END),0) net
     FROM debt_transactions WHERE customer_id=?`, [customerId]
  );
  const [[orders]] = await pool.query(
    `SELECT COALESCE(SUM(debt_amount),0) total FROM orders WHERE customer_id=? AND status<>'CANCELLED'`, [customerId]
  );
  return { ledgerNet: Number(ledger.net), ordersTotal: Number(orders.total), match: Math.abs(Number(ledger.net) - Number(orders.total)) < 0.01 };
}
async function returnAcceptedQty(orderId, orderItemId, qty, disposition = 'RESTOCK') {
  const created = await ReturnAgent.create(orderId, { return_reason_code: 'QUALITY_COMPLAINT', items: [{ order_item_id: orderItemId, quantity_requested: qty }] }, admin);
  const lineId = created.items[0].id;
  await ReturnAgent.receive(created.return_id, { items: [{ return_item_id: lineId, received_qty: qty }] }, admin);
  await ReturnAgent.inspect(created.return_id, { items: [{ return_item_id: lineId, accepted_qty: qty, rejected_qty: 0, disposition }] }, admin);
  return ReturnAgent.complete(created.return_id, admin);
}

async function main() {
  const productIds = [], orderIds = [], returnFixtureIds = { returnIds: [] }, customerIds = [], paymentIds = [];

  try {
    // ══════════════════ Case 1: the exact reproduction sequence (10 required assertions) ══════════════════
    {
      const customerId = await makeCustomer('C1'); customerIds.push(customerId);
      const p = await makeProduct(50); productIds.push(p.id);
      const orderId = await makeOrder(customerId, p.id, 10, 50000); orderIds.push(orderId); // total 500,000
      const [[oi]] = await pool.query(`SELECT id FROM order_items WHERE order_id=? LIMIT 1`, [orderId]);

      check('1. order created with 500,000 debt', Number((await orderRow(orderId)).debt_amount) === 500000);

      const pay1 = await PaymentAgent.create({ customer_id: customerId, order_id: orderId, cash_amount: 200000, bank_amount: 0, payment_date: today, idempotency_key: `glpar-c1-pay1-${Date.now()}` }, admin);
      paymentIds.push(pay1.payment_id);
      check('2. paid 200,000 -> debt 300,000', Number((await orderRow(orderId)).debt_amount) === 300000);

      const completeResult = await returnAcceptedQty(orderId, oi.id, 4); // 4 * 50,000 = 200,000
      check('3. return completes, reverses 200,000', Number(completeResult.debt_reversal.reversal_applied) === 200000, completeResult.debt_reversal);
      check('4. outstanding debt after return = 100,000', Number((await orderRow(orderId)).debt_amount) === 100000, await orderRow(orderId));

      const key2 = `glpar-c1-pay2-${Date.now()}`;
      const pay2 = await PaymentAgent.create({ customer_id: customerId, order_id: orderId, cash_amount: 100000, bank_amount: 0, payment_date: today, idempotency_key: key2 }, admin);
      paymentIds.push(pay2.payment_id);

      const afterFinal = await orderRow(orderId);
      check('5. final payment of 100,000 accepted', !!pay2.payment_id, pay2);
      check('6. orders.debt_amount becomes 0 (THE bug: was resurrecting to 200,000)', Number(afterFinal.debt_amount) === 0, afterFinal);
      check('7. signed SUM(debt_transactions) for the order = 0', await ledgerSumForOrder(orderId) === 0, await ledgerSumForOrder(orderId));
      check('8. payment_status = PAID', afterFinal.payment_status === 'PAID', afterFinal.payment_status);
      check('9. the return\'s 200,000 reversal was never resurrected (order.debt_amount stayed at 100,000 minus this payment, not total-paid)', Number(afterFinal.debt_amount) === 0);

      // 10. retry/idempotency remains safe — same key, must not double-apply.
      const pay2Retry = await PaymentAgent.create({ customer_id: customerId, order_id: orderId, cash_amount: 100000, bank_amount: 0, payment_date: today, idempotency_key: key2 }, admin);
      check('10. retry with same idempotency_key returns the same payment_id (no double-apply)', pay2Retry.payment_id === pay2.payment_id, { first: pay2.payment_id, retry: pay2Retry.payment_id });
      const afterRetry = await orderRow(orderId);
      check('10. retry did not change debt_amount (still 0)', Number(afterRetry.debt_amount) === 0, afterRetry);
    }

    // ══════════════════ Case 2: no Sales Return — normal payment path unaffected ══════════════════
    {
      const customerId = await makeCustomer('C2'); customerIds.push(customerId);
      const p = await makeProduct(50); productIds.push(p.id);
      const orderId = await makeOrder(customerId, p.id, 5, 40000); orderIds.push(orderId); // 200,000
      const pay1 = await PaymentAgent.create({ customer_id: customerId, order_id: orderId, cash_amount: 80000, bank_amount: 0, payment_date: today, idempotency_key: `glpar-c2-pay1-${Date.now()}` }, admin);
      paymentIds.push(pay1.payment_id);
      check('Case 2: normal payment reduces debt correctly (200,000 -> 120,000)', Number((await orderRow(orderId)).debt_amount) === 120000, await orderRow(orderId));
      const pay2 = await PaymentAgent.create({ customer_id: customerId, order_id: orderId, cash_amount: 120000, bank_amount: 0, payment_date: today, idempotency_key: `glpar-c2-pay2-${Date.now()}` }, admin);
      paymentIds.push(pay2.payment_id);
      const after = await orderRow(orderId);
      check('Case 2: second payment pays it off fully (debt 0, PAID)', Number(after.debt_amount) === 0 && after.payment_status === 'PAID', after);
      check('Case 2: ledger reconciles', await ledgerSumForOrder(orderId) === 0, await ledgerSumForOrder(orderId));
    }

    // ══════════════════ Case 3: partially returned + partially paid bill ══════════════════
    {
      const customerId = await makeCustomer('C3'); customerIds.push(customerId);
      const p = await makeProduct(50); productIds.push(p.id);
      const orderId = await makeOrder(customerId, p.id, 10, 50000); orderIds.push(orderId); // 500,000
      const [[oi]] = await pool.query(`SELECT id FROM order_items WHERE order_id=? LIMIT 1`, [orderId]);

      const pay1 = await PaymentAgent.create({ customer_id: customerId, order_id: orderId, cash_amount: 100000, bank_amount: 0, payment_date: today, idempotency_key: `glpar-c3-pay1-${Date.now()}` }, admin);
      paymentIds.push(pay1.payment_id);
      check('Case 3: after first payment, debt = 400,000', Number((await orderRow(orderId)).debt_amount) === 400000);

      const ret = await returnAcceptedQty(orderId, oi.id, 3); // 3*50,000=150,000
      check('Case 3: return reverses 150,000 -> debt 250,000', Number((await orderRow(orderId)).debt_amount) === 250000, await orderRow(orderId));
      check('Case 3: return reports reversal_applied 150,000, no credit', Number(ret.debt_reversal.reversal_applied) === 150000 && Number(ret.debt_reversal.credit_created) === 0, ret.debt_reversal);

      const pay2 = await PaymentAgent.create({ customer_id: customerId, order_id: orderId, cash_amount: 100000, bank_amount: 0, payment_date: today, idempotency_key: `glpar-c3-pay2-${Date.now()}` }, admin);
      paymentIds.push(pay2.payment_id);
      const after = await orderRow(orderId);
      check('Case 3: second payment reduces the TRUE remaining debt (250,000 -> 150,000), not resurrected total-paid', Number(after.debt_amount) === 150000, after);
      check('Case 3: ledger reconciles with orders.debt_amount', await ledgerSumForOrder(orderId) === 150000, await ledgerSumForOrder(orderId));
    }

    // ══════════════════ Case 4: fully paid bill + return credit path remains unchanged (Blocker 2 regression) ══════════════════
    {
      const customerId = await makeCustomer('C4'); customerIds.push(customerId);
      const p = await makeProduct(50); productIds.push(p.id);
      const orderId = await makeOrder(customerId, p.id, 4, 30000); orderIds.push(orderId); // 120,000
      const [[oi]] = await pool.query(`SELECT id FROM order_items WHERE order_id=? LIMIT 1`, [orderId]);
      const pay1 = await PaymentAgent.create({ customer_id: customerId, order_id: orderId, cash_amount: 120000, bank_amount: 0, payment_date: today, idempotency_key: `glpar-c4-pay1-${Date.now()}` }, admin);
      paymentIds.push(pay1.payment_id);
      check('Case 4 setup: bill fully paid, debt 0', Number((await orderRow(orderId)).debt_amount) === 0);

      const ret = await returnAcceptedQty(orderId, oi.id, 4); // 4*30,000=120,000, entirely excess
      check('Case 4: reversal_applied stays 0 (bill already fully paid)', Number(ret.debt_reversal.reversal_applied) === 0, ret.debt_reversal);
      check('Case 4: credit_created = full 120,000 (Blocker 2 path unchanged)', Number(ret.debt_reversal.credit_created) === 120000, ret.debt_reversal);
      const [[credit]] = await pool.query(`SELECT * FROM payment_unapplied_credits WHERE source_type='SALES_RETURN' AND source_id=?`, [ret.return_id]);
      check('Case 4: payment_unapplied_credits row created as before', !!credit && Number(credit.remaining_amount) === 120000, credit);
      await pool.query(`DELETE FROM payment_unapplied_credits WHERE source_type='SALES_RETURN' AND source_id=?`, [ret.return_id]).catch(() => {});
    }

    // ══════════════════ Case 5: payment cancel AFTER a return keeps ledger/order reconciliation correct ══════════════════
    {
      const customerId = await makeCustomer('C5'); customerIds.push(customerId);
      const p = await makeProduct(50); productIds.push(p.id);
      const orderId = await makeOrder(customerId, p.id, 10, 50000); orderIds.push(orderId); // 500,000
      const [[oi]] = await pool.query(`SELECT id FROM order_items WHERE order_id=? LIMIT 1`, [orderId]);

      const pay1 = await PaymentAgent.create({ customer_id: customerId, order_id: orderId, cash_amount: 200000, bank_amount: 0, payment_date: today, idempotency_key: `glpar-c5-pay1-${Date.now()}` }, admin);
      paymentIds.push(pay1.payment_id);
      check('Case 5 setup: after payment, debt 300,000', Number((await orderRow(orderId)).debt_amount) === 300000);

      const ret = await returnAcceptedQty(orderId, oi.id, 4); // 200,000
      check('Case 5 setup: after return, debt 100,000', Number((await orderRow(orderId)).debt_amount) === 100000, ret.debt_reversal);

      await PaymentAgent.cancel(pay1.payment_id, { reason: 'Case 5 cancel test' }, admin);
      const afterCancel = await orderRow(orderId);
      // Cancelling the 200,000 payment restores exactly that much debt on top
      // of what the return had already (correctly) reduced it to: 100,000 +
      // 200,000 = 300,000 — NOT total(500,000)-paid(0)=500,000, which would
      // silently discard the return's forgiveness a second way.
      check('Case 5: cancelling the payment restores debt to 300,000 (100,000 + the 200,000 reverted), not 500,000', Number(afterCancel.debt_amount) === 300000, afterCancel);
      const recon = await ledgerVsOrdersReconciled(customerId);
      check('Case 5: customer-wide ledger-vs-orders reconciliation holds after cancel', recon.match, recon);
    }

  } finally {
    for (const pid of paymentIds) {
      await pool.query(`DELETE FROM payment_allocations WHERE payment_id=?`, [pid]).catch(() => {});
      await pool.query(`DELETE FROM payment_unapplied_credits WHERE payment_id=?`, [pid]).catch(() => {});
      await pool.query(`DELETE FROM debt_transactions WHERE payment_id=?`, [pid]).catch(() => {});
      await pool.query(`DELETE FROM payments WHERE id=?`, [pid]).catch(() => {});
    }
    for (const oid of orderIds) {
      await pool.query(`DELETE FROM sales_return_inspections WHERE return_item_id IN (SELECT id FROM sales_return_items WHERE return_id IN (SELECT id FROM sales_returns WHERE order_id=?))`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM sales_return_items WHERE return_id IN (SELECT id FROM sales_returns WHERE order_id=?)`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM stock_transactions WHERE reference_type='SALES_RETURN' AND reference_id IN (SELECT id FROM sales_returns WHERE order_id=?)`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM sales_returns WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM payment_allocations WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM order_items WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM debt_transactions WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM payments WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM orders WHERE id=?`, [oid]).catch(() => {});
    }
    for (const id of productIds) {
      await pool.query(`DELETE FROM stock_transactions WHERE product_id=?`, [id]).catch(() => {});
      await pool.query(`DELETE FROM products WHERE id=?`, [id]).catch(() => {});
    }
    for (const customerId of customerIds) {
      await pool.query(`DELETE FROM debt_transactions WHERE customer_id=?`, [customerId]).catch(() => {});
      await pool.query(`DELETE FROM customer_product_catalogs WHERE customer_id=?`, [customerId]).catch(() => {});
      await pool.query(`DELETE FROM customer_product_prices WHERE customer_id=?`, [customerId]).catch(() => {});
      await pool.query(`DELETE FROM customers WHERE id=?`, [customerId]).catch(() => {});
    }
    console.log('Cleanup done.');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
