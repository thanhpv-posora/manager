'use strict';
// S8.1A Sales Guard — Debt Ledger Synchronization
//   TASK 1: audited every INSERT/UPDATE/DELETE against debt_transactions.
//           Only one production write violated append-only:
//           PaymentAgent.revertPaymentEffects() did
//           `DELETE FROM debt_transactions WHERE payment_id=?`.
//   TASK 2: replaced that DELETE with PaymentAgent.reverseDebtLedgerForPayment(),
//           which posts a compensating ADJUSTMENT_INCREASE/DECREASE row sized
//           to net the payment's current ledger contribution to zero. No row
//           is ever deleted or updated once posted.
//   TASK 3: orders.debt_amount and SUM(debt_transactions) stay synchronized
//           through the SAME transaction on every path that changes unpaid
//           bill total (create, add item, edit qty, edit price, payment,
//           payment edit, payment cancel) — this script asserts the two
//           numbers match after every single step, not just at the end.
//
// This script also asserts the append-only guarantee directly: it snapshots
// every debt_transactions row for the test customer before each mutating
// step and verifies, after the step, that every previously-seen row (id,
// type, amount, customer_id, order_id, payment_id) is still present
// byte-for-byte and that the row count never decreases.
//
// Self-cleaning: throwaway customer + products + orders + payments +
// debt_transactions, removed in `finally`.

const pool = require('../src/config/db');
const OrderAgent = require('../src/agents/OrderAgent');
const PaymentAgent = require('../src/agents/PaymentAgent');
const CustomerAgent = require('../src/agents/CustomerAgent');
const ProductAgent = require('../src/agents/ProductAgent');
const { getCustomerDebt } = require('../src/services/debt.service');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

async function makeProduct(qty) {
  await ProductAgent.addProduct({
    name: `S8.1A LEDGER ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    unit: 'kg', inventory_mode: 'TRACK_STOCK', stock_quantity: qty, allow_negative_stock: 0,
  });
  const [[created]] = await pool.query(`SELECT * FROM products WHERE name LIKE 'S8.1A LEDGER %' ORDER BY id DESC LIMIT 1`);
  return created;
}

async function debtLedgerSum(customerId) {
  const [[row]] = await pool.query(
    `SELECT COALESCE(SUM(CASE
       WHEN type IN ('SALE','ADJUSTMENT_INCREASE') THEN amount
       WHEN type IN ('PAYMENT','ADJUSTMENT_DECREASE') THEN -amount
       ELSE 0 END),0) signed_sum
     FROM debt_transactions WHERE customer_id=?`,
    [customerId]
  );
  return Number(row.signed_sum);
}

async function paymentIdNetEffect(paymentId) {
  const [[row]] = await pool.query(
    `SELECT COALESCE(SUM(CASE
       WHEN type IN ('SALE','ADJUSTMENT_INCREASE') THEN amount
       WHEN type IN ('PAYMENT','ADJUSTMENT_DECREASE') THEN -amount
       ELSE 0 END),0) net_effect
     FROM debt_transactions WHERE payment_id=?`,
    [paymentId]
  );
  return Number(row.net_effect);
}

async function orderDebt(orderId) {
  const [[row]] = await pool.query(`SELECT debt_amount, total_amount, paid_amount FROM orders WHERE id=?`, [orderId]);
  return { debt: Number(row.debt_amount), total: Number(row.total_amount), paid: Number(row.paid_amount) };
}

async function ledgerRows(customerId) {
  const [rows] = await pool.query(
    `SELECT id, type, amount, customer_id, order_id, payment_id FROM debt_transactions WHERE customer_id=? ORDER BY id ASC`,
    [customerId]
  );
  return rows;
}

// Append-only contract: every row seen in `prev` must still exist in `curr`
// with IDENTICAL field values (never rewritten), and `curr` must never have
// fewer rows than `prev` (never deleted).
function assertAppendOnly(stepName, prev, curr) {
  check(`${stepName}: row count never decreases (${prev.length} -> ${curr.length})`, curr.length >= prev.length, { prev: prev.length, curr: curr.length });
  const currById = new Map(curr.map(r => [r.id, r]));
  let allUnchanged = true;
  let missingId = null;
  for (const p of prev) {
    const c = currById.get(p.id);
    if (!c) { allUnchanged = false; missingId = p.id; break; }
    if (Number(c.amount) !== Number(p.amount) || c.type !== p.type || Number(c.customer_id) !== Number(p.customer_id)
        || (c.order_id ?? null) !== (p.order_id ?? null) || (c.payment_id ?? null) !== (p.payment_id ?? null)) {
      allUnchanged = false; missingId = p.id; break;
    }
  }
  check(`${stepName}: no previously-posted row was deleted or rewritten`, allUnchanged, missingId !== null ? { changedOrMissingId: missingId } : undefined);
}

async function main() {
  const productIds = [];
  const orderIds = [];
  const paymentIds = [];
  let customerId = null;
  const user = { id: null, role: 'ADMIN' };
  const today = new Date().toISOString().slice(0, 10);

  try {
    const [custIns] = await pool.query(
      `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type)
       VALUES(?,?,?,?,?,?,?,?)`,
      [`S81A-CUST-${Date.now()}`, 'S8.1A Ledger Test Customer', '0', 'test', 'PRIVATE_PRICE', 0, 0, 'SOLAR']
    );
    customerId = custIns.insertId;

    const p1 = await makeProduct(100);
    const p2 = await makeProduct(100);
    productIds.push(p1.id, p2.id);

    // ══════════════════════ Task 1 audit result (asserted directly) ══════════════════════
    // Only PaymentAgent.revertPaymentEffects touched debt_transactions with a
    // non-INSERT verb before this fix. Confirm the fix is actually wired in.
    check('Fix wired: PaymentAgent.reverseDebtLedgerForPayment exists', typeof PaymentAgent.reverseDebtLedgerForPayment === 'function');

    let snap = await ledgerRows(customerId);
    check('Baseline: no debt_transactions rows for fresh test customer', snap.length === 0, snap.length);

    // ══════════════════════ Create bill ══════════════════════
    const r = await OrderAgent.create({
      customer_id: customerId, order_date: today,
      items: [{ product_id: p1.id, product_name: 'x', unit: 'kg', quantity: 5, sale_price: 100000, manual_price: true }],
    }, user);
    orderIds.push(r.order_id);
    let od = await orderDebt(r.order_id);
    let ledger = await debtLedgerSum(customerId);
    check('Create bill: order debt = 500,000', od.debt === 500000, od.debt);
    check('Create bill: SUM(debt_transactions) matches orders.debt_amount', ledger === od.debt, { ledger, orderDebt: od.debt });
    let curr = await ledgerRows(customerId);
    assertAppendOnly('Create bill', snap, curr); snap = curr;

    // ══════════════════════ Add item ══════════════════════
    await OrderAgent.addItem(r.order_id, { product_id: p2.id, product_name: 'y', unit: 'kg', quantity: 3, sale_price: 100000 }, user);
    od = await orderDebt(r.order_id);
    ledger = await debtLedgerSum(customerId);
    check('Add item: order debt = 800,000', od.debt === 800000, od.debt);
    check('Add item: SUM(debt_transactions) matches orders.debt_amount', ledger === od.debt, { ledger, orderDebt: od.debt });
    curr = await ledgerRows(customerId);
    assertAppendOnly('Add item', snap, curr); snap = curr;

    // ══════════════════════ Edit qty (5kg -> 8kg on item1, +300,000) ══════════════════════
    const [[item1]] = await pool.query(`SELECT * FROM order_items WHERE order_id=? AND product_id=?`, [r.order_id, p1.id]);
    await OrderAgent.updateItem(r.order_id, item1.id, { quantity: 8, sale_price: 100000 }, user);
    od = await orderDebt(r.order_id);
    ledger = await debtLedgerSum(customerId);
    check('Edit qty: order debt = 1,100,000', od.debt === 1100000, od.debt);
    check('Edit qty: SUM(debt_transactions) matches orders.debt_amount', ledger === od.debt, { ledger, orderDebt: od.debt });
    curr = await ledgerRows(customerId);
    assertAppendOnly('Edit qty', snap, curr); snap = curr;

    // ══════════════════════ Edit price (8kg @100,000 -> @90,000 on item1, -80,000) ══════════════════════
    await OrderAgent.updateItem(r.order_id, item1.id, { quantity: 8, sale_price: 90000 }, user);
    od = await orderDebt(r.order_id);
    ledger = await debtLedgerSum(customerId);
    check('Edit price: order debt = 1,020,000', od.debt === 1020000, od.debt);
    check('Edit price: SUM(debt_transactions) matches orders.debt_amount', ledger === od.debt, { ledger, orderDebt: od.debt });
    curr = await ledgerRows(customerId);
    assertAppendOnly('Edit price', snap, curr); snap = curr;

    // ══════════════════════ Payment (400,000 cash against this bill) ══════════════════════
    const payResult = await PaymentAgent.create({
      customer_id: customerId, order_id: r.order_id, payment_date: today,
      cash_amount: 400000, bank_amount: 0, note: 'S8.1A test payment',
    }, user);
    const paymentId = payResult.payment_id;
    paymentIds.push(paymentId);
    od = await orderDebt(r.order_id);
    ledger = await debtLedgerSum(customerId);
    check('Payment: order debt = 620,000 (1,020,000 - 400,000)', od.debt === 620000, od.debt);
    check('Payment: SUM(debt_transactions) matches orders.debt_amount', ledger === od.debt, { ledger, orderDebt: od.debt });
    curr = await ledgerRows(customerId);
    assertAppendOnly('Payment', snap, curr); snap = curr;

    // Payment allocation check — payment_allocations row exists for this bill
    const [allocAfterPay] = await pool.query(`SELECT * FROM payment_allocations WHERE payment_id=?`, [paymentId]);
    check('Payment allocation: a payment_allocations row was created for the bill', allocAfterPay.length === 1 && Number(allocAfterPay[0].order_id) === Number(r.order_id) && Number(allocAfterPay[0].amount) === 400000, allocAfterPay);

    // ══════════════════════ Payment edit (400,000 -> 250,000) ══════════════════════
    const preEditNet = await paymentIdNetEffect(paymentId);
    check('Payment edit (pre): payment_id net ledger effect = -400,000', preEditNet === -400000, preEditNet);
    await PaymentAgent.update(paymentId, {
      customer_id: customerId, order_id: r.order_id, payment_date: today,
      cash_amount: 250000, bank_amount: 0, note: 'S8.1A test payment (edited)',
    }, user);
    od = await orderDebt(r.order_id);
    ledger = await debtLedgerSum(customerId);
    const postEditNet = await paymentIdNetEffect(paymentId);
    check('Payment edit: order debt = 770,000 (1,020,000 - 250,000)', od.debt === 770000, od.debt);
    check('Payment edit: SUM(debt_transactions) matches orders.debt_amount', ledger === od.debt, { ledger, orderDebt: od.debt });
    check('Payment edit: payment_id net ledger effect updates to -250,000', postEditNet === -250000, postEditNet);
    curr = await ledgerRows(customerId);
    assertAppendOnly('Payment edit', snap, curr); // this is the critical regression check for Task 2
    check('Payment edit: appended exactly 2 new rows (reversal + new PAYMENT), none removed', curr.length === snap.length + 2, { before: snap.length, after: curr.length });
    snap = curr;

    // ══════════════════════ Payment cancel ══════════════════════
    await PaymentAgent.cancel(paymentId, { reason: 'S8.1A test cancel' }, user);
    od = await orderDebt(r.order_id);
    ledger = await debtLedgerSum(customerId);
    const postCancelNet = await paymentIdNetEffect(paymentId);
    check('Payment cancel: order debt returns to 1,020,000', od.debt === 1020000, od.debt);
    check('Payment cancel: SUM(debt_transactions) matches orders.debt_amount', ledger === od.debt, { ledger, orderDebt: od.debt });
    check('Payment cancel: payment_id net ledger effect returns to 0', postCancelNet === 0, postCancelNet);
    curr = await ledgerRows(customerId);
    assertAppendOnly('Payment cancel', snap, curr); // the exact scenario the old DELETE broke
    check('Payment cancel: appended exactly 1 new row (reversal), none removed', curr.length === snap.length + 1, { before: snap.length, after: curr.length });
    snap = curr;

    const [[cancelledPayment]] = await pool.query(`SELECT status, amount FROM payments WHERE id=?`, [paymentId]);
    check('Payment cancel: payments row marked CANCELLED with amount 0', String(cancelledPayment.status).toUpperCase() === 'CANCELLED' && Number(cancelledPayment.amount) === 0, cancelledPayment);

    const [allocAfterCancel] = await pool.query(`SELECT * FROM payment_allocations WHERE payment_id=?`, [paymentId]);
    check('Payment allocation: allocation row cleared after cancel (unchanged existing behavior)', allocAfterCancel.length === 0, allocAfterCancel.length);

    // ══════════════════════ Customer debt ══════════════════════
    const custRows = await CustomerAgent.list(user);
    const custRow = custRows.find(c => Number(c.id) === Number(customerId));
    check('Customer debt: CustomerAgent.list() current_debt matches orders.debt_amount', !!custRow && Number(custRow.current_debt) === od.debt, custRow && custRow.current_debt);

    // ══════════════════════ AI debt ══════════════════════
    const aiRows = await getCustomerDebt('S8.1A Ledger Test Customer');
    const aiRow = aiRows.find(c => Number(c.id) === Number(customerId));
    check('AI debt: debt.service.js getCustomerDebt() matches orders.debt_amount', !!aiRow && Number(aiRow.debt_amount) === od.debt, aiRow && aiRow.debt_amount);

    // ══════════════════════ Full regression re-check: original SALE row untouched throughout ══════════════════════
    const [[saleRow]] = await pool.query(`SELECT amount, type FROM debt_transactions WHERE order_id=? AND type='SALE'`, [r.order_id]);
    check('Immutable ledger: original SALE row still 500,000 after every edit/payment/cancel', saleRow && Number(saleRow.amount) === 500000 && saleRow.type === 'SALE', saleRow);

  } finally {
    for (const pid of paymentIds) {
      await pool.query(`DELETE FROM payment_allocations WHERE payment_id=?`, [pid]).catch(() => {});
      await pool.query(`DELETE FROM payment_unapplied_credits WHERE payment_id=?`, [pid]).catch(() => {});
      await pool.query(`DELETE FROM debt_transactions WHERE payment_id=?`, [pid]).catch(() => {});
      await pool.query(`DELETE FROM payments WHERE id=?`, [pid]).catch(() => {});
    }
    for (const oid of orderIds) {
      await pool.query(`DELETE FROM payment_allocations WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM payments WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM order_items WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM debt_transactions WHERE order_id=?`, [oid]).catch(() => {});
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
