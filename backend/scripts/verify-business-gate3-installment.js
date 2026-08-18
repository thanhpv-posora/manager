'use strict';
// CTO GO-LIVE FINAL BUSINESS ACCEPTANCE — GATE 3: Góp nợ (debt installment).
//
// Scope decision (derived from code, not invented — two separate systems
// exist in this codebase and only one matches the described test flow):
//  - DebtInstallmentAgent (debt_installment_plans, /api/installments root
//    paths) — a customer-level flat daily-target plan, order_id=NULL always,
//    no "allocation across bills" concept at all.
//  - DebtMonthlyInstallmentAgent (debt_monthly_installments, /api/installments/
//    monthly/*) — per-customer daily rate effective-by-date, integrated
//    directly into PaymentAgent.create()'s current_bill_amount/
//    monthly_installment_amount/monthly_installment_id fields and its
//    allocateCustomerOpenBillsByDate() multi-bill allocation. This is the one
//    the gate's own described flow ("Bill -> installment -> partial payment
//    -> another bill -> allocation -> final payment -> cancel") matches
//    exactly, and the one this whole GO-LIVE audit has exercised throughout
//    PaymentAgent.js. Tested here; the flat-plan system is a different
//    feature, out of this gate's described scope.
//
// Disposable DB only (CR4_FRESH_DB). Not self-cleaning (left for inspection).

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
  console.log(`=== GATE 3: Góp nợ (debt installment) matrix (${TARGET}) ===\n`);

  const ProductAgent = require('../src/agents/ProductAgent');
  const CustomerAgent = require('../src/agents/CustomerAgent');
  const OrderAgent = require('../src/agents/OrderAgent');
  const PaymentAgent = require('../src/agents/PaymentAgent');
  const PriceMatrixAgent = require('../src/agents/PriceMatrixAgent');
  const DebtMonthlyInstallmentAgent = require('../src/agents/DebtMonthlyInstallmentAgent');

  const admin = { id: null, role: 'ADMIN' };
  const today = new Date().toISOString().slice(0, 10);
  const tag = `G3-${Date.now()}`;

  const [[cat]] = await pool.query(`SELECT id FROM product_categories WHERE del_flg=0 ORDER BY id LIMIT 1`);
  const catId = cat.id;

  async function makeCustomer(name) {
    const res = await CustomerAgent.create({ name: `${tag} ${name}`, phone: `09${String(Date.now()).slice(-6)}${String(Math.floor(Math.random()*90)+10)}`, partner_type: 2, default_sales_flow: 'INVENTORY_SALE', price_mode: 'PRIVATE_PRICE', billing_calendar_type: 'SOLAR' }, admin);
    const [[row]] = await pool.query(`SELECT id FROM customers WHERE customer_code=?`, [res.customer_code]);
    return row.id;
  }
  async function makeProduct(name, qty) {
    const full = `${tag} ${name}`;
    await ProductAgent.addProduct({ name: full, unit: 'kg', category_id: catId, inventory_mode: 'TRACK_STOCK', sales_flow: 'INVENTORY_SALE', stock_quantity: qty, allow_negative_stock: 0 });
    const [[p]] = await pool.query(`SELECT * FROM products WHERE name=? LIMIT 1`, [full]);
    return p;
  }
  async function orderRow(orderId) { const [[r]] = await pool.query(`SELECT * FROM orders WHERE id=?`, [orderId]); return r; }
  async function ledgerSumForOrder(orderId) {
    const [[r]] = await pool.query(`SELECT COALESCE(SUM(CASE WHEN type IN ('SALE','ADJUSTMENT_INCREASE') THEN amount WHEN type IN ('PAYMENT','ADJUSTMENT_DECREASE') THEN -amount ELSE 0 END),0) net FROM debt_transactions WHERE order_id=?`, [orderId]);
    return Number(r.net);
  }
  async function customerLedgerVsOrders(customerId) {
    const [[ledger]] = await pool.query(`SELECT COALESCE(SUM(CASE WHEN type IN ('SALE','ADJUSTMENT_INCREASE') THEN amount WHEN type IN ('PAYMENT','ADJUSTMENT_DECREASE') THEN -amount ELSE 0 END),0) net FROM debt_transactions WHERE customer_id=?`, [customerId]);
    const [[orders]] = await pool.query(`SELECT COALESCE(SUM(debt_amount),0) total FROM orders WHERE customer_id=? AND status<>'CANCELLED'`, [customerId]);
    return { ledgerNet: Number(ledger.net), ordersTotal: Number(orders.total), match: Math.abs(Number(ledger.net) - Number(orders.total)) < 0.01 };
  }

  const product = await makeProduct('Sản phẩm góp nợ', 200);

  // ══════════════════ A. Customer WITH góp nợ enabled ══════════════════
  {
    const custId = await makeCustomer('Gop No Customer');
    await PriceMatrixAgent.createCustomerPriceCategory(custId, catId, { sales_flow: 'INVENTORY_SALE' });
    await PriceMatrixAgent.saveMatrix(custId, [{ product_id: product.id, private_price: 30000, in_catalog: true }], null, { effective_from: today, effective_calendar_type: 'SOLAR' }, catId);

    const installmentConfig = await DebtMonthlyInstallmentAgent.saveDailyInstallment({ customer_id: custId, config_date: today, calendar_type: 'SOLAR', installment_amount: 20000, status: 'ACTIVE' });
    check('A. Daily góp nợ configured (20,000/day)', !!installmentConfig && !!installmentConfig.item, installmentConfig);
    const active = await DebtMonthlyInstallmentAgent.activeByDate(custId, today, 'SOLAR');
    check('A. activeByDate() resolves the configured rate', Number(active.installment_amount) === 20000, active);

    // Bill 1: 10kg * 30,000 = 300,000.
    const bill1 = await OrderAgent.create({ customer_id: custId, order_date: today, items: [{ product_id: product.id, product_name: product.name, unit: 'kg', quantity: 10 }] }, admin);
    check('A. Bill 1 created, product debt = 300,000', Number((await orderRow(bill1.order_id)).debt_amount) === 300000);

    // Payment 1: current_bill_amount=300,000 (the product total) + today's
    // installment 20,000 = payable 320,000. Pay 200,000 partially.
    const pay1 = await PaymentAgent.create({
      customer_id: custId, order_id: bill1.order_id, cash_amount: 200000, bank_amount: 0, payment_date: today,
      current_bill_amount: 300000, monthly_installment_amount: active.installment_amount,
      idempotency_key: `${tag}-pay1`,
    }, admin);
    const bill1AfterPay1 = await orderRow(bill1.order_id);
    check('A. Payment 1: total_amount grows to 320,000 (300k bill + 20k góp nợ)', Number(bill1AfterPay1.total_amount) === 320000, bill1AfterPay1);
    check('A. Payment 1: debt = 120,000 (320,000 - 200,000)', Number(bill1AfterPay1.debt_amount) === 120000, bill1AfterPay1);
    check('A. Payment 1: installment_amount persisted on the order (20,000)', Number(bill1AfterPay1.installment_amount) === 20000, bill1AfterPay1);
    check('A. Ledger reconciles for bill 1 after payment 1', await ledgerSumForOrder(bill1.order_id) === 120000, await ledgerSumForOrder(bill1.order_id));

    // Bill 2, same customer, same day: 5kg * 30,000 = 150,000.
    const bill2 = await OrderAgent.create({ customer_id: custId, order_date: today, items: [{ product_id: product.id, product_name: product.name, unit: 'kg', quantity: 5 }] }, admin);
    check('A. Bill 2 created, product debt = 150,000', Number((await orderRow(bill2.order_id)).debt_amount) === 150000);

    // Payment 2: 200,000 with no order_id (or bill1's remaining as target) —
    // pays off bill1's remaining 120,000 first (oldest open bill by order_date),
    // then the leftover 80,000 flows to bill2.
    const pay2 = await PaymentAgent.create({
      customer_id: custId, order_id: bill2.order_id, cash_amount: 200000, bank_amount: 0, payment_date: today,
      idempotency_key: `${tag}-pay2`,
    }, admin);
    const bill1AfterPay2 = await orderRow(bill1.order_id);
    const bill2AfterPay2 = await orderRow(bill2.order_id);
    check('A. Payment 2: allocation clears bill 1 first (debt 120,000 -> 0)', Number(bill1AfterPay2.debt_amount) === 0, bill1AfterPay2);
    check('A. Payment 2: remainder (80,000) flows to bill 2 (debt 150,000 -> 70,000)', Number(bill2AfterPay2.debt_amount) === 70000, bill2AfterPay2);
    check('A. Ledger reconciles for bill 1 (fully paid)', await ledgerSumForOrder(bill1.order_id) === 0);
    check('A. Ledger reconciles for bill 2 (partially paid)', await ledgerSumForOrder(bill2.order_id) === 70000);

    // Final payment: clear bill 2 entirely.
    const pay3 = await PaymentAgent.create({
      customer_id: custId, order_id: bill2.order_id, cash_amount: 70000, bank_amount: 0, payment_date: today,
      idempotency_key: `${tag}-pay3`,
    }, admin);
    const bill2Final = await orderRow(bill2.order_id);
    check('A. Final payment clears bill 2 (debt = 0, PAID)', Number(bill2Final.debt_amount) === 0 && bill2Final.payment_status === 'PAID', bill2Final);
    const custReconAfterFinal = await customerLedgerVsOrders(custId);
    check('A. Customer-wide ledger-vs-orders reconciliation holds after full payoff', custReconAfterFinal.match, custReconAfterFinal);

    // Cancel/reversal: cancel payment 2 (the one that spanned both bills) and
    // verify its effect is restored exactly, on top of whatever bill1/bill2
    // already reflect from payment 3.
    await PaymentAgent.cancel(pay2.payment_id, { reason: 'Gate 3 cancel test' }, admin);
    const bill1AfterCancel = await orderRow(bill1.order_id);
    const bill2AfterCancel = await orderRow(bill2.order_id);
    // Payment 2 had applied 120,000 to bill1 and 80,000 to bill2 — cancelling
    // it restores exactly those amounts on top of the current (post-payment-3) state.
    check('A. Cancel restores bill 1 debt by exactly payment 2\'s share (0 -> 120,000)', Number(bill1AfterCancel.debt_amount) === 120000, bill1AfterCancel);
    check('A. Cancel restores bill 2 debt by exactly payment 2\'s share (0 -> 80,000)', Number(bill2AfterCancel.debt_amount) === 80000, bill2AfterCancel);
    const custReconAfterCancel = await customerLedgerVsOrders(custId);
    check('A. Customer-wide ledger-vs-orders reconciliation holds after the cancel', custReconAfterCancel.match, custReconAfterCancel);
  }

  // ══════════════════ B. Customer WITHOUT góp nợ ══════════════════
  {
    const custId = await makeCustomer('No Gop No Customer');
    await PriceMatrixAgent.createCustomerPriceCategory(custId, catId, { sales_flow: 'INVENTORY_SALE' });
    await PriceMatrixAgent.saveMatrix(custId, [{ product_id: product.id, private_price: 30000, in_catalog: true }], null, { effective_from: today, effective_calendar_type: 'SOLAR' }, catId);

    const activeNone = await DebtMonthlyInstallmentAgent.activeByDate(custId, today, 'SOLAR');
    check('B. No góp nợ configured for this customer (rate = 0)', Number(activeNone.installment_amount) === 0, activeNone);

    const bill = await OrderAgent.create({ customer_id: custId, order_date: today, items: [{ product_id: product.id, product_name: product.name, unit: 'kg', quantity: 10 }] }, admin);
    check('B. Bill created, debt = 300,000 (product only)', Number((await orderRow(bill.order_id)).debt_amount) === 300000);

    // Payment with NO installment fields passed at all — matches how a normal
    // (non-góp-nợ) Thu tiền submission would look.
    const pay = await PaymentAgent.create({ customer_id: custId, order_id: bill.order_id, cash_amount: 150000, bank_amount: 0, payment_date: today, idempotency_key: `${tag}-b-pay1` }, admin);
    const billAfter = await orderRow(bill.order_id);
    check('B. NO góp nợ amount silently applied — total_amount stays 300,000', Number(billAfter.total_amount) === 300000, billAfter);
    check('B. debt reduces by exactly the payment (300,000 -> 150,000)', Number(billAfter.debt_amount) === 150000, billAfter);
    check('B. installment_amount stays 0 on the order', Number(billAfter.installment_amount || 0) === 0, billAfter);
    check('B. Ledger reconciles', await ledgerSumForOrder(bill.order_id) === 150000);
    const custRecon = await customerLedgerVsOrders(custId);
    check('B. Customer-wide ledger-vs-orders reconciliation holds', custRecon.match, custRecon);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
