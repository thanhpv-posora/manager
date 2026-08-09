'use strict';
// GO-LIVE F-RETURN-DEBT — verifies ReturnAgent.complete() now reverses the
// customer's debt for accepted (RESTOCK/PROCESS/SCRAP) return quantity, at
// the frozen historical sale price, capped at the order's own current
// debt_amount so the customer-ledger reconciliation invariant
// (SUM(debt_transactions) per customer == SUM(orders.debt_amount) across
// non-cancelled orders — the same invariant verify-order-cancel-reversal.js
// S13 already gates) never breaks.
//
// GO-LIVE BLOCKER 2 (settlement for fully-paid returns) extends this same
// script: Scenario 3 now also asserts the shortfall becomes a customer
// unapplied credit instead of being dropped, and Scenario 5 covers the
// all-credit edge case (return against an ALREADY fully-paid bill).
//
// Same convention as verify-p1-01a-return-guards.js / verify-sales-return-
// foundation.js: real pool, self-cleaning, pass/fail counters, no external
// test framework. Run with `node scripts/verify-golive-return-debt-reversal.js`.

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
async function expectError(name, code, fn) {
  try {
    await fn();
    check(name, false, 'expected to throw but succeeded');
  } catch (e) {
    check(name, e && e.code === code, { expected: code, got: e && e.code, message: e && e.message });
  }
}

async function makeProduct(qty) {
  const name = `GOLIVE-RETURN-DEBT ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await ProductAgent.addProduct({
    name, unit: 'kg', inventory_mode: 'TRACK_STOCK', sales_flow: 'INVENTORY_SALE',
    stock_quantity: qty, allow_negative_stock: 0,
  });
  const [[created]] = await pool.query(`SELECT * FROM products WHERE name=? LIMIT 1`, [name]);
  return created;
}

async function orderRow(orderId) {
  const [[r]] = await pool.query(`SELECT debt_amount, payment_status, paid_amount FROM orders WHERE id=?`, [orderId]);
  return r;
}
async function debtLedgerSumForOrder(orderId) {
  const [[r]] = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN type IN ('SALE','ADJUSTMENT_INCREASE') THEN amount WHEN type IN ('PAYMENT','ADJUSTMENT_DECREASE') THEN -amount ELSE 0 END),0) net
     FROM debt_transactions WHERE order_id=?`, [orderId]
  );
  return Number(r.net);
}
async function unappliedCreditsForReturn(returnId) {
  const [rows] = await pool.query(
    `SELECT * FROM payment_unapplied_credits WHERE source_type='SALES_RETURN' AND source_id=?`, [returnId]
  );
  return rows;
}
async function paymentCountForCustomer(customerId) {
  const [[r]] = await pool.query(`SELECT COUNT(*) c FROM payments WHERE customer_id=?`, [customerId]);
  return Number(r.c);
}
async function customerLedgerVsOrdersReconciled(customerId) {
  const [[ledger]] = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN type IN ('SALE','ADJUSTMENT_INCREASE') THEN amount WHEN type IN ('PAYMENT','ADJUSTMENT_DECREASE') THEN -amount ELSE 0 END),0) net
     FROM debt_transactions WHERE customer_id=?`, [customerId]
  );
  const [[orders]] = await pool.query(
    `SELECT COALESCE(SUM(debt_amount),0) total FROM orders WHERE customer_id=? AND status<>'CANCELLED'`, [customerId]
  );
  return { ledgerNet: Number(ledger.net), ordersTotal: Number(orders.total), match: Math.abs(Number(ledger.net) - Number(orders.total)) < 0.01 };
}

async function main() {
  const productIds = [];
  const orderIds = [];
  const returnIds = [];
  let customerId = null;
  const paymentIds = [];
  const admin = { id: null, role: 'ADMIN' };
  const today = new Date().toISOString().slice(0, 10);

  try {
    const [custIns] = await pool.query(
      `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type,default_sales_flow)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      [`GLRD-CUST-${Date.now()}`, 'GO-LIVE Return Debt Test Customer', '0', 'test', 'PRIVATE_PRICE', 0, 0, 'SOLAR', 'INVENTORY_SALE']
    );
    customerId = custIns.insertId;

    const pA = await makeProduct(100);
    const pB = await makeProduct(100);
    const pC = await makeProduct(100);
    productIds.push(pA.id, pB.id, pC.id);

    // ══════════════════ Scenario 1: unpaid bill, RESTOCK+rejected mix ══════════════════
    // 10kg @ 50,000 = 500,000 debt. Return 4kg: 3 accepted(RESTOCK) + 1 rejected.
    // Expected debt reversal = 3 * 50,000 = 150,000 (rejected qty excluded).
    {
      const orderResult = await OrderAgent.create({
        customer_id: customerId, order_date: today,
        items: [{ product_id: pA.id, product_name: 'A', unit: 'kg', quantity: 10, sale_price: 50000, manual_price: true }],
      }, admin);
      const orderId = orderResult.order_id;
      orderIds.push(orderId);
      const [[itemA]] = await pool.query(`SELECT * FROM order_items WHERE order_id=? LIMIT 1`, [orderId]);

      const before = await orderRow(orderId);
      check('S1 setup: initial debt = 500,000', Number(before.debt_amount) === 500000, before);

      const created = await ReturnAgent.create(orderId, {
        return_reason_code: 'QUALITY_COMPLAINT', items: [{ order_item_id: itemA.id, quantity_requested: 4 }],
      }, admin);
      const returnId = created.return_id;
      returnIds.push(returnId);
      const lineId = created.items[0].id;

      await ReturnAgent.receive(returnId, { items: [{ return_item_id: lineId, received_qty: 4 }] }, admin);
      await ReturnAgent.inspect(returnId, {
        items: [{ return_item_id: lineId, accepted_qty: 3, rejected_qty: 1, disposition: 'RESTOCK' }],
      }, admin);
      const result = await ReturnAgent.complete(returnId, admin);

      check('S1: complete() reports reversal_computed = 150,000', Number(result.debt_reversal.reversal_computed) === 150000, result.debt_reversal);
      check('S1: complete() reports reversal_applied = 150,000 (not capped, order had enough debt)', Number(result.debt_reversal.reversal_applied) === 150000, result.debt_reversal);

      const after = await orderRow(orderId);
      check('S1: orders.debt_amount reduced to 350,000 (500,000 - 150,000)', Number(after.debt_amount) === 350000, after);
      check('S1: payment_status stays PARTIAL (debt still > 0)', after.payment_status === 'PARTIAL' || after.payment_status === 'UNPAID', after.payment_status);

      const ledgerNet = await debtLedgerSumForOrder(orderId);
      check('S1: debt_transactions ledger sum for this order matches orders.debt_amount exactly (350,000)', ledgerNet === 350000, { ledgerNet });

      const [[decRow]] = await pool.query(
        `SELECT COUNT(*) cnt FROM debt_transactions WHERE order_id=? AND type='ADJUSTMENT_DECREASE' AND amount=150000`, [orderId]
      );
      check('S1: exactly one ADJUSTMENT_DECREASE row of 150,000 posted', Number(decRow.cnt) === 1, decRow);

      // Idempotency: retry complete() on an already-COMPLETED return must not double-reverse.
      await expectError('S1: retrying complete() after COMPLETED is rejected', 'RETURN_INVALID_STATE',
        () => ReturnAgent.complete(returnId, admin));
      const afterRetry = await orderRow(orderId);
      check('S1: retry did not further reduce debt_amount (still 350,000)', Number(afterRetry.debt_amount) === 350000, afterRetry);
      const [[decRowAfterRetry]] = await pool.query(
        `SELECT COUNT(*) cnt FROM debt_transactions WHERE order_id=? AND type='ADJUSTMENT_DECREASE'`, [orderId]
      );
      check('S1: retry did not create a second ADJUSTMENT_DECREASE row', Number(decRowAfterRetry.cnt) === 1, decRowAfterRetry);
    }

    // ══════════════════ Scenario 2: PROCESS/SCRAP disposition also reverses debt ══════════════════
    // (not just RESTOCK — "accepted into custody" is the basis, not the disposition)
    {
      const orderResult = await OrderAgent.create({
        customer_id: customerId, order_date: today,
        items: [{ product_id: pB.id, product_name: 'B', unit: 'kg', quantity: 5, sale_price: 20000, manual_price: true }],
      }, admin);
      const orderId = orderResult.order_id;
      orderIds.push(orderId);
      const [[itemB]] = await pool.query(`SELECT * FROM order_items WHERE order_id=? LIMIT 1`, [orderId]);

      const created = await ReturnAgent.create(orderId, {
        return_reason_code: 'QUALITY_COMPLAINT', items: [{ order_item_id: itemB.id, quantity_requested: 5 }],
      }, admin);
      const returnId = created.return_id;
      returnIds.push(returnId);
      const lineId = created.items[0].id;

      await ReturnAgent.receive(returnId, { items: [{ return_item_id: lineId, received_qty: 5 }] }, admin);
      await ReturnAgent.inspect(returnId, {
        items: [{ return_item_id: lineId, accepted_qty: 5, rejected_qty: 0, disposition: 'SCRAP' }],
      }, admin);
      const stockBefore = (await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [pB.id]))[0][0].stock_quantity;
      const result = await ReturnAgent.complete(returnId, admin);

      check('S2: SCRAP disposition still reverses debt = 100,000 (5 * 20,000)', Number(result.debt_reversal.reversal_applied) === 100000, result.debt_reversal);
      const stockAfter = (await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [pB.id]))[0][0].stock_quantity;
      check('S2: SCRAP disposition does NOT restock inventory (no RESTOCK line)', Number(stockAfter) === Number(stockBefore), { stockBefore, stockAfter });
      const after = await orderRow(orderId);
      check('S2: orders.debt_amount reduced to 0 (100,000 - 100,000)', Number(after.debt_amount) === 0, after);
      check('S2: payment_status becomes UNPAID (debt=0, paid_amount=0)', after.payment_status === 'UNPAID', after.payment_status);
    }

    // ══════════════════ Scenario 3: reversal exceeds current debt — capped, not negative ══════════════════
    // Order paid down to 50,000 remaining debt via a real payment; return computes to
    // 200,000 worth of accepted qty. Reversal must cap at 50,000, never go negative,
    // and the customer-wide ledger-vs-orders reconciliation invariant must hold.
    //
    // Uses its OWN customer (customerId2), isolated from customerId's other
    // scenarios: PaymentAgent.create()'s real "auto-allocate to oldest unpaid
    // bill by order date" feature (V65.38) would otherwise apply this payment
    // against Scenario 1's still-outstanding order instead of this one.
    let customerId2 = null;
    {
      const [custIns2] = await pool.query(
        `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type,default_sales_flow)
         VALUES(?,?,?,?,?,?,?,?,?)`,
        [`GLRD-CUST2-${Date.now()}`, 'GO-LIVE Return Debt Test Customer 2', '0', 'test', 'PRIVATE_PRICE', 0, 0, 'SOLAR', 'INVENTORY_SALE']
      );
      customerId2 = custIns2.insertId;

      const orderResult = await OrderAgent.create({
        customer_id: customerId2, order_date: today,
        items: [{ product_id: pC.id, product_name: 'C', unit: 'kg', quantity: 10, sale_price: 20000, manual_price: true }],
      }, admin); // total_amount = 200,000
      const orderId = orderResult.order_id;
      orderIds.push(orderId);
      const [[itemC]] = await pool.query(`SELECT * FROM order_items WHERE order_id=? LIMIT 1`, [orderId]);

      const payResult = await PaymentAgent.create({
        customer_id: customerId2, order_id: orderId, payment_date: today,
        cash_amount: 150000, bank_amount: 0,
        idempotency_key: `golive-return-debt-reversal-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      }, admin);
      paymentIds.push(payResult.payment_id);

      const midway = await orderRow(orderId);
      check('S3 setup: debt down to 50,000 after a 150,000 payment', Number(midway.debt_amount) === 50000, midway);

      const created = await ReturnAgent.create(orderId, {
        return_reason_code: 'QUALITY_COMPLAINT', items: [{ order_item_id: itemC.id, quantity_requested: 10 }],
      }, admin);
      const returnId = created.return_id;
      returnIds.push(returnId);
      const lineId = created.items[0].id;

      await ReturnAgent.receive(returnId, { items: [{ return_item_id: lineId, received_qty: 10 }] }, admin);
      await ReturnAgent.inspect(returnId, {
        items: [{ return_item_id: lineId, accepted_qty: 10, rejected_qty: 0, disposition: 'RESTOCK' }],
      }, admin); // computed reversal = 10 * 20,000 = 200,000, but only 50,000 debt remains
      const result = await ReturnAgent.complete(returnId, admin);

      check('S3: reversal_computed = 200,000 (full accepted qty x frozen price)', Number(result.debt_reversal.reversal_computed) === 200000, result.debt_reversal);
      check('S3: reversal_applied capped at 50,000 (the order\'s remaining debt)', Number(result.debt_reversal.reversal_applied) === 50000, result.debt_reversal);

      const after = await orderRow(orderId);
      check('S3: orders.debt_amount floors at 0 (never negative)', Number(after.debt_amount) === 0, after);

      const ledgerNet = await debtLedgerSumForOrder(orderId);
      check('S3: debt_transactions ledger sum for this order matches orders.debt_amount exactly (0, not -150,000)', ledgerNet === 0, { ledgerNet });

      const recon = await customerLedgerVsOrdersReconciled(customerId2);
      check('S3: customer-wide ledger-vs-orders reconciliation invariant holds after the capped reversal', recon.match, recon);

      // GO-LIVE BLOCKER 2: the 150,000 shortfall (200,000 computed - 50,000
      // absorbed by the bill) is no longer dropped — it becomes a customer
      // unapplied credit.
      check('S3: complete() reports credit_created = 150,000 (200,000 - 50,000)', Number(result.debt_reversal.credit_created) === 150000, result.debt_reversal);
      const creditsS3 = await unappliedCreditsForReturn(returnId);
      check('S3: exactly one payment_unapplied_credits row created for this return', creditsS3.length === 1, creditsS3);
      if (creditsS3.length) {
        const c = creditsS3[0];
        check('S3: credit customer_id matches', Number(c.customer_id) === Number(customerId2), c);
        check('S3: credit original_amount = remaining_amount = 150,000 (fresh, unconsumed)', Number(c.original_amount) === 150000 && Number(c.remaining_amount) === 150000, c);
        check('S3: credit payment_id is NULL (no real payments row backs a return credit)', c.payment_id === null, c.payment_id);
        check('S3: credit source_type/source_id trace back to this return', c.source_type === 'SALES_RETURN' && Number(c.source_id) === Number(returnId), c);
      }
      const auditCreditRowsS3 = (await pool.query(
        `SELECT COUNT(*) c FROM audit_logs WHERE entity_type='sales_returns' AND entity_id=? AND action='SALES_RETURN_CREDIT_CREATED'`, [returnId]
      ))[0][0].c;
      check('S3: SALES_RETURN_CREDIT_CREATED audit row written exactly once', Number(auditCreditRowsS3) === 1, auditCreditRowsS3);
      check('S3: never touched payment history — the setup payment still exists, count stays at 1 (not deleted by the credit branch)', await paymentCountForCustomer(customerId2) === 1, await paymentCountForCustomer(customerId2));

      // Idempotency: retry complete() must not double-create the credit either.
      await expectError('S3: retrying complete() after COMPLETED is rejected', 'RETURN_INVALID_STATE',
        () => ReturnAgent.complete(returnId, admin));
      const creditsS3AfterRetry = await unappliedCreditsForReturn(returnId);
      check('S3: retry did not create a second credit row', creditsS3AfterRetry.length === 1, creditsS3AfterRetry);
      check('S3: retry did not change the credit amount', Number(creditsS3AfterRetry[0].remaining_amount) === 150000, creditsS3AfterRetry[0]);

      await pool.query(`DELETE FROM payment_unapplied_credits WHERE source_type='SALES_RETURN' AND source_id=?`, [returnId]).catch(() => {});
      await pool.query(`DELETE FROM debt_transactions WHERE customer_id=?`, [customerId2]).catch(() => {});
      await pool.query(`DELETE FROM customers WHERE id=?`, [customerId2]).catch(() => {});
    }

    // ══════════════════ Scenario 3B: return against an ALREADY fully-paid bill ══════════════════
    // currentDebt = 0 at completion time — actualReversal never fires at all
    // (the `if (actualReversal > 0.001)` guard is skipped entirely), so the
    // WHOLE computed reversal must become credit, zero ADJUSTMENT_DECREASE
    // rows posted, and the payment that fully paid the bill must survive
    // untouched (never deleted, never rewritten).
    let customerId3b = null;
    {
      const [custIns3b] = await pool.query(
        `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type,default_sales_flow)
         VALUES(?,?,?,?,?,?,?,?,?)`,
        [`GLRD-CUST3B-${Date.now()}`, 'GO-LIVE Return Settlement Fully-Paid Test Customer', '0', 'test', 'PRIVATE_PRICE', 0, 0, 'SOLAR', 'INVENTORY_SALE']
      );
      customerId3b = custIns3b.insertId;

      const pD = await makeProduct(100);
      productIds.push(pD.id);

      const orderResult = await OrderAgent.create({
        customer_id: customerId3b, order_date: today,
        items: [{ product_id: pD.id, product_name: 'D', unit: 'kg', quantity: 4, sale_price: 30000, manual_price: true }],
      }, admin); // total_amount = 120,000
      const orderId = orderResult.order_id;
      orderIds.push(orderId);
      const [[itemD]] = await pool.query(`SELECT * FROM order_items WHERE order_id=? LIMIT 1`, [orderId]);

      const payResult = await PaymentAgent.create({
        customer_id: customerId3b, order_id: orderId, payment_date: today,
        cash_amount: 120000, bank_amount: 0,
        idempotency_key: `golive-return-debt-reversal-s3b-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      }, admin);
      paymentIds.push(payResult.payment_id);

      const midway = await orderRow(orderId);
      check('S3B setup: bill fully paid, debt = 0', Number(midway.debt_amount) === 0, midway);
      check('S3B setup: payment_status = PAID', midway.payment_status === 'PAID', midway.payment_status);

      const created = await ReturnAgent.create(orderId, {
        return_reason_code: 'QUALITY_COMPLAINT', items: [{ order_item_id: itemD.id, quantity_requested: 4 }],
      }, admin);
      const returnId = created.return_id;
      returnIds.push(returnId);
      const lineId = created.items[0].id;

      await ReturnAgent.receive(returnId, { items: [{ return_item_id: lineId, received_qty: 4 }] }, admin);
      await ReturnAgent.inspect(returnId, {
        items: [{ return_item_id: lineId, accepted_qty: 4, rejected_qty: 0, disposition: 'RESTOCK' }],
      }, admin); // computed reversal = 4 * 30,000 = 120,000, but the bill already has 0 debt
      const result = await ReturnAgent.complete(returnId, admin);

      check('S3B: reversal_computed = 120,000', Number(result.debt_reversal.reversal_computed) === 120000, result.debt_reversal);
      check('S3B: reversal_applied = 0 (bill already fully paid, nothing left to absorb)', Number(result.debt_reversal.reversal_applied) === 0, result.debt_reversal);
      check('S3B: credit_created = the FULL 120,000 (entire reversal becomes credit)', Number(result.debt_reversal.credit_created) === 120000, result.debt_reversal);

      const after = await orderRow(orderId);
      check('S3B: orders.debt_amount stays 0 (unaffected)', Number(after.debt_amount) === 0, after);
      const [[decRowS3b]] = await pool.query(`SELECT COUNT(*) cnt FROM debt_transactions WHERE order_id=? AND type='ADJUSTMENT_DECREASE'`, [orderId]);
      check('S3B: zero ADJUSTMENT_DECREASE rows posted (nothing to reverse against)', Number(decRowS3b.cnt) === 0, decRowS3b);

      const creditsS3b = await unappliedCreditsForReturn(returnId);
      check('S3B: exactly one payment_unapplied_credits row for the full 120,000', creditsS3b.length === 1 && Number(creditsS3b[0].remaining_amount) === 120000, creditsS3b);

      // Never delete payment history: the payment that fully paid this bill
      // must still exist, unmodified, after the return settles as credit.
      const [[paymentAfter]] = await pool.query(`SELECT * FROM payments WHERE id=?`, [payResult.payment_id]);
      check('S3B: the original payment row still exists (payment history never deleted)', !!paymentAfter, paymentAfter);
      check('S3B: the original payment amount is unchanged (120,000)', paymentAfter && Number(paymentAfter.amount) === 120000, paymentAfter);
      check('S3B: the original payment status is not CANCELLED', paymentAfter && String(paymentAfter.status || 'ACTIVE').toUpperCase() !== 'CANCELLED', paymentAfter && paymentAfter.status);

      // Transactional: the credit row and the COMPLETED status landed together
      // (both committed in the same transaction) — status is COMPLETED iff the
      // credit row exists, never one without the other.
      check('S3B: return status is COMPLETED alongside the credit row', result.status === 'COMPLETED', result.status);

      await pool.query(`DELETE FROM payment_unapplied_credits WHERE source_type='SALES_RETURN' AND source_id=?`, [returnId]).catch(() => {});
      await pool.query(`DELETE FROM payment_allocations WHERE payment_id=?`, [payResult.payment_id]).catch(() => {});
      await pool.query(`DELETE FROM debt_transactions WHERE customer_id=?`, [customerId3b]).catch(() => {});
      await pool.query(`DELETE FROM customers WHERE id=?`, [customerId3b]).catch(() => {});
    }

    // ══════════════════ Scenario 4: reject() path never touches debt ══════════════════
    {
      const orderResult = await OrderAgent.create({
        customer_id: customerId, order_date: today,
        items: [{ product_id: pA.id, product_name: 'A', unit: 'kg', quantity: 2, sale_price: 50000, manual_price: true }],
      }, admin);
      const orderId = orderResult.order_id;
      orderIds.push(orderId);
      const [[itemA2]] = await pool.query(`SELECT * FROM order_items WHERE order_id=? LIMIT 1`, [orderId]);
      const beforeDebt = (await orderRow(orderId)).debt_amount;

      const created = await ReturnAgent.create(orderId, {
        return_reason_code: 'QUALITY_COMPLAINT', items: [{ order_item_id: itemA2.id, quantity_requested: 2 }],
      }, admin);
      const returnId = created.return_id;
      returnIds.push(returnId);
      const lineId = created.items[0].id;

      await ReturnAgent.receive(returnId, { items: [{ return_item_id: lineId, received_qty: 2 }] }, admin);
      await ReturnAgent.inspect(returnId, {
        items: [{ return_item_id: lineId, accepted_qty: 0, rejected_qty: 2 }],
      }, admin);
      const rejectResult = await ReturnAgent.reject(returnId, { reason: 'not eligible' }, admin);
      check('S4: reject() succeeds', rejectResult.status === 'REJECTED', rejectResult.status);

      const afterDebt = (await orderRow(orderId)).debt_amount;
      check('S4: reject() leaves orders.debt_amount completely untouched', Number(afterDebt) === Number(beforeDebt), { beforeDebt, afterDebt });
      const [[decRow]] = await pool.query(`SELECT COUNT(*) cnt FROM debt_transactions WHERE order_id=? AND type='ADJUSTMENT_DECREASE'`, [orderId]);
      check('S4: reject() posts zero debt_transactions rows', Number(decRow.cnt) === 0, decRow);
    }

    // Final whole-customer reconciliation across every order touched in this run.
    {
      const recon = await customerLedgerVsOrdersReconciled(customerId);
      check('Final: customer-wide ledger-vs-orders reconciliation invariant holds across all scenarios', recon.match, recon);
    }

  } finally {
    console.log('\nCleaning up...');
    for (const rid of returnIds) {
      await pool.query(`DELETE FROM sales_return_inspections WHERE return_item_id IN (SELECT id FROM sales_return_items WHERE return_id=?)`, [rid]).catch(() => {});
      await pool.query(`DELETE FROM sales_return_items WHERE return_id=?`, [rid]).catch(() => {});
      await pool.query(`DELETE FROM stock_transactions WHERE reference_type='SALES_RETURN' AND reference_id=?`, [rid]).catch(() => {});
      await pool.query(`DELETE FROM sales_returns WHERE id=?`, [rid]).catch(() => {});
    }
    for (const pid of paymentIds) {
      await pool.query(`DELETE FROM payment_allocations WHERE payment_id=?`, [pid]).catch(() => {});
      await pool.query(`DELETE FROM debt_transactions WHERE order_id IN (SELECT order_id FROM payment_allocations WHERE payment_id=?)`, [pid]).catch(() => {});
      await pool.query(`DELETE FROM payments WHERE id=?`, [pid]).catch(() => {});
    }
    for (const oid of orderIds) {
      await pool.query(`DELETE FROM order_items WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM debt_transactions WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM payments WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM orders WHERE id=?`, [oid]).catch(() => {});
    }
    for (const id of productIds) {
      await pool.query(`DELETE FROM stock_transactions WHERE product_id=?`, [id]).catch(() => {});
      await pool.query(`DELETE FROM products WHERE id=?`, [id]).catch(() => {});
    }
    if (customerId) {
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
