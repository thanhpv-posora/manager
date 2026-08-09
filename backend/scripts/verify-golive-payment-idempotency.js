'use strict';
// GO-LIVE BLOCKER 1 — Payment idempotency.
//
// PaymentAgent.create()'s dedup infra (payment_transaction_requests +
// getIdempotentResult/beginIdempotentRequest/finishIdempotentRequest) already
// existed and was correct, but idempotency_key was OPT-IN: any caller that
// omitted it (Payments.jsx never sent one — see [[project_golive_audit_state]]
// P1 backlog) got zero dedup protection, so a double-click "Thu tiền" could
// create two payments and double-apply a debt reduction. This verifies:
//   1. Missing idempotency_key is rejected BEFORE any write (no payment, no
//      debt_transactions row, no payment_transaction_requests row).
//   2. Same key, two SEQUENTIAL calls (duplicate click / retry) → exactly one
//      payment row, debt reduced exactly once, second call returns the SAME
//      payment_id instead of creating a duplicate.
//   3. Different keys → normal behavior, two genuinely different payments.
//   4. TRULY CONCURRENT calls with the same key → exactly one payment row
//      ever gets created; the other resolves to the same payment or is
//      rejected as a conflict (never creates a second row).
//   5. transactionStatus() reports the dedup outcome correctly.
//
// Self-cleaning: throwaway customer + products + orders + payments, removed
// in `finally`. Never touches real data. Each case gets its OWN customer
// (per go-live audit insight #6: PaymentAgent auto-allocates to the oldest
// unpaid bill across ALL of a customer's orders, so sharing a customer across
// cases would let one case's payment silently land on another case's order).

const pool = require('../src/config/db');
const OrderAgent = require('../src/agents/OrderAgent');
const PaymentAgent = require('../src/agents/PaymentAgent');
const ProductAgent = require('../src/agents/ProductAgent');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

const user = { id: null, role: 'ADMIN' };
const today = new Date().toISOString().slice(0, 10);

async function makeProduct(qty) {
  const name = `GOLIVE PAY IDEM ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await ProductAgent.addProduct({ name, unit: 'kg', inventory_mode: 'TRACK_STOCK', sales_flow: 'INVENTORY_SALE', stock_quantity: qty, allow_negative_stock: 0 });
  const [[created]] = await pool.query(`SELECT * FROM products WHERE name=? LIMIT 1`, [name]);
  return created;
}

async function makeCustomer(tag) {
  const [ins] = await pool.query(
    `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type,default_sales_flow)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    [`GOLIVE-PAY-IDEM-${tag}-${Date.now()}`, `GO-LIVE Payment Idem Test ${tag}`, '0', 'test', 'PRIVATE_PRICE', 0, 0, 'SOLAR', 'INVENTORY_SALE']
  );
  return ins.insertId;
}

async function makeOrderWithDebt(customerId, productId, qty, price) {
  const r = await OrderAgent.create({
    customer_id: customerId, order_date: today,
    items: [{ product_id: productId, product_name: 'x', unit: 'kg', quantity: qty, sale_price: price, manual_price: true }],
  }, user);
  return r.order_id;
}

async function orderRow(orderId) {
  const [[row]] = await pool.query(`SELECT * FROM orders WHERE id=?`, [orderId]);
  return row;
}

async function paymentCount(customerId) {
  const [[row]] = await pool.query(`SELECT COUNT(*) c FROM payments WHERE customer_id=?`, [customerId]);
  return Number(row.c);
}

async function debtTxCount(customerId, type) {
  const [[row]] = await pool.query(`SELECT COUNT(*) c FROM debt_transactions WHERE customer_id=? AND type=?`, [customerId, type]);
  return Number(row.c);
}

async function main() {
  const productIds = [];
  const orderIds = [];
  const paymentIds = [];
  const customerIds = [];

  try {
    // ══════════════════ Case 1: missing idempotency_key rejected before any write ══════════════════
    {
      const customerId = await makeCustomer('C1'); customerIds.push(customerId);
      const p = await makeProduct(50); productIds.push(p.id);
      const orderId = await makeOrderWithDebt(customerId, p.id, 5, 30000); orderIds.push(orderId);
      const before = await orderRow(orderId);

      let threw = null;
      try {
        await PaymentAgent.create({ customer_id: customerId, order_id: orderId, cash_amount: 150000, bank_amount: 0, payment_date: today }, user);
      } catch (e) { threw = e; }
      check('Case 1: missing idempotency_key rejected', !!threw && threw.code === 'IDEMPOTENCY_KEY_REQUIRED', threw && { message: threw.message, code: threw.code, status: threw.status });
      check('Case 1: rejected with HTTP 400', threw && threw.status === 400, threw && threw.status);

      const after = await orderRow(orderId);
      check('Case 1: order debt untouched by the rejected attempt', Number(after.debt_amount) === Number(before.debt_amount), { before: before.debt_amount, after: after.debt_amount });
      check('Case 1: no payment row created', await paymentCount(customerId) === 0, await paymentCount(customerId));
      check('Case 1: no debt_transactions PAYMENT row created', await debtTxCount(customerId, 'PAYMENT') === 0, await debtTxCount(customerId, 'PAYMENT'));
    }

    // ══════════════════ Case 2: same key, two sequential calls (duplicate click) ══════════════════
    {
      const customerId = await makeCustomer('C2'); customerIds.push(customerId);
      const p = await makeProduct(50); productIds.push(p.id);
      const orderId = await makeOrderWithDebt(customerId, p.id, 5, 40000); orderIds.push(orderId); // debt = 200,000
      const key = 'test-pay-key-duplicate-click-' + Date.now();
      const payload = { customer_id: customerId, order_id: orderId, cash_amount: 200000, bank_amount: 0, payment_date: today, idempotency_key: key };

      const r1 = await PaymentAgent.create(payload, user);
      paymentIds.push(r1.payment_id);
      const r2 = await PaymentAgent.create(payload, user);
      if (r2.payment_id) paymentIds.push(r2.payment_id);

      check('Case 2: second call returns the SAME payment_id (no duplicate)', r2.payment_id === r1.payment_id, { r1: r1.payment_id, r2: r2.payment_id });
      check('Case 2: only ONE payment row exists for this customer', await paymentCount(customerId) === 1, await paymentCount(customerId));
      check('Case 2: only ONE debt_transactions PAYMENT row (debt not double-applied)', await debtTxCount(customerId, 'PAYMENT') === 1, await debtTxCount(customerId, 'PAYMENT'));
      const after = await orderRow(orderId);
      check('Case 2: debt reduced exactly once (200,000 → 0), not twice into negative', Number(after.debt_amount) === 0, after.debt_amount);

      const status = await PaymentAgent.transactionStatus(key);
      check('Case 2: transactionStatus() reports SUCCESS', status.status === 'SUCCESS', status.status);
      check('Case 2: transactionStatus() response carries the same payment_id', status.response && Number(status.response.payment_id) === Number(r1.payment_id), status.response);
    }

    // ══════════════════ Case 3: different keys → normal behavior, two distinct payments ══════════════════
    {
      const customerId = await makeCustomer('C3'); customerIds.push(customerId);
      const p = await makeProduct(50); productIds.push(p.id);
      const orderId = await makeOrderWithDebt(customerId, p.id, 10, 30000); orderIds.push(orderId); // debt = 300,000

      const r1 = await PaymentAgent.create({ customer_id: customerId, order_id: orderId, cash_amount: 100000, bank_amount: 0, payment_date: today, idempotency_key: 'test-pay-key-A-' + Date.now() }, user);
      const r2 = await PaymentAgent.create({ customer_id: customerId, order_id: orderId, cash_amount: 100000, bank_amount: 0, payment_date: today, idempotency_key: 'test-pay-key-B-' + Date.now() }, user);
      paymentIds.push(r1.payment_id, r2.payment_id);

      check('Case 3: different keys create TWO distinct payments', r1.payment_id !== r2.payment_id, { r1: r1.payment_id, r2: r2.payment_id });
      check('Case 3: both payments actually exist', await paymentCount(customerId) === 2, await paymentCount(customerId));
      const after = await orderRow(orderId);
      check('Case 3: debt reduced by both legitimate payments (300,000 → 100,000)', Number(after.debt_amount) === 100000, after.debt_amount);
    }

    // ══════════════════ Case 4: truly concurrent calls, same key → exactly one payment created ══════════════════
    {
      const customerId = await makeCustomer('C4'); customerIds.push(customerId);
      const p = await makeProduct(50); productIds.push(p.id);
      const orderId = await makeOrderWithDebt(customerId, p.id, 5, 50000); orderIds.push(orderId); // debt = 250,000
      const key = 'test-pay-key-concurrent-' + Date.now();
      const payload = { customer_id: customerId, order_id: orderId, cash_amount: 250000, bank_amount: 0, payment_date: today, idempotency_key: key };

      const [s1, s2] = await Promise.allSettled([
        PaymentAgent.create(payload, user),
        PaymentAgent.create(payload, user),
      ]);

      const fulfilled = [s1, s2].filter(s => s.status === 'fulfilled').map(s => s.value);
      const rejected = [s1, s2].filter(s => s.status === 'rejected').map(s => s.reason);
      for (const r of fulfilled) if (r.payment_id) paymentIds.push(r.payment_id);

      check('Case 4: at least one concurrent call succeeded', fulfilled.length >= 1, { fulfilled: fulfilled.length, rejected: rejected.length });
      if (fulfilled.length === 2) {
        check('Case 4: both concurrent calls that succeeded resolved to the SAME payment_id', fulfilled[0].payment_id === fulfilled[1].payment_id, fulfilled.map(f => f.payment_id));
      } else {
        check('Case 4: the losing call was rejected as a conflict, not a hard failure', rejected.length === 1 && ['PAYMENT_PROCESSING', 'PAYMENT_PREVIOUS_FAILED'].includes(rejected[0]?.code), rejected.map(e => ({ message: e?.message, code: e?.code, status: e?.status })));
        check('Case 4: the conflict was reported as HTTP 409', rejected[0]?.status === 409, rejected[0]?.status);
      }
      check('Case 4: exactly ONE payment row exists despite two truly parallel identical requests', await paymentCount(customerId) === 1, await paymentCount(customerId));
      check('Case 4: exactly ONE debt_transactions PAYMENT row (debt not double-applied by the race)', await debtTxCount(customerId, 'PAYMENT') === 1, await debtTxCount(customerId, 'PAYMENT'));
      const after = await orderRow(orderId);
      check('Case 4: debt reduced exactly once (250,000 → 0), never negative from a double-apply', Number(after.debt_amount) === 0, after.debt_amount);
    }

    // ══════════════════ Regression: AI payment path (aiPayment.service.js) still works ══════════════════
    // confirmPaymentFromPreview() now mints its own idempotency_key (crypto.randomUUID())
    // rather than calling PaymentAgent.create() with none — proves that path doesn't
    // start throwing IDEMPOTENCY_KEY_REQUIRED now that the key is mandatory.
    {
      const aiPaymentService = require('../src/services/aiPayment.service');
      const customerId = await makeCustomer('C5-AI'); customerIds.push(customerId);
      const [[cust]] = await pool.query(`SELECT name FROM customers WHERE id=?`, [customerId]);
      const p = await makeProduct(50); productIds.push(p.id);
      const orderId = await makeOrderWithDebt(customerId, p.id, 5, 20000); orderIds.push(orderId); // debt = 100,000

      const preview = {
        parsed: { customer_name: cust.name, amount: 100000, payment_method: 'CASH' },
        customer: { id: customerId, billing_calendar_type: 'SOLAR' },
      };
      const confirmed = await aiPaymentService.confirmPaymentFromPreview(preview, user);
      check('Regression: AI chat payment confirm still succeeds with a mandatory key', !!confirmed.result?.payment_id, confirmed.result);
      if (confirmed.result?.payment_id) paymentIds.push(confirmed.result.payment_id);
    }

  } finally {
    for (const pid of paymentIds) {
      if (!pid) continue;
      await pool.query(`DELETE FROM payment_allocations WHERE payment_id=?`, [pid]).catch(() => {});
      await pool.query(`DELETE FROM payment_unapplied_credits WHERE payment_id=?`, [pid]).catch(() => {});
      await pool.query(`DELETE FROM debt_transactions WHERE payment_id=?`, [pid]).catch(() => {});
      await pool.query(`DELETE FROM payments WHERE id=?`, [pid]).catch(() => {});
    }
    for (const oid of orderIds) {
      await pool.query(`DELETE FROM payment_allocations WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM order_items WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM debt_transactions WHERE order_id=?`, [oid]).catch(() => {});
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
