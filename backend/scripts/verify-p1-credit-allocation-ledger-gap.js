'use strict';
// PRODUCTION RELEASE GATE — Phase 3: re-audit of the previously-reported P1
// (PaymentAgent.allocateExistingCreditsToOpenBills() applying an existing
// unapplied credit to a new bill's debt_amount with no matching
// debt_transactions row). Do NOT assume the prior audit is still correct —
// this reproduces it live.
//
// Required invariant under test:
//   signed SUM(debt_transactions WHERE order_id = order.id) == orders.debt_amount
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
  console.log(`=== P1 re-audit: allocateExistingCreditsToOpenBills() ledger gap (${TARGET}) ===\n`);

  const ProductAgent = require('../src/agents/ProductAgent');
  const CustomerAgent = require('../src/agents/CustomerAgent');
  const OrderAgent = require('../src/agents/OrderAgent');
  const PaymentAgent = require('../src/agents/PaymentAgent');
  const PriceMatrixAgent = require('../src/agents/PriceMatrixAgent');

  const admin = { id: null, role: 'ADMIN' };
  const today = new Date().toISOString().slice(0, 10);
  const tag = `P1CREDIT-${Date.now()}`;

  const [[cat]] = await pool.query(`SELECT id FROM product_categories WHERE del_flg=0 ORDER BY id LIMIT 1`);
  const catId = cat.id;

  async function ledgerSumForOrder(orderId) {
    const [[r]] = await pool.query(`SELECT COALESCE(SUM(CASE WHEN type IN ('SALE','ADJUSTMENT_INCREASE') THEN amount WHEN type IN ('PAYMENT','ADJUSTMENT_DECREASE') THEN -amount ELSE 0 END),0) net FROM debt_transactions WHERE order_id=?`, [orderId]);
    return Number(r.net);
  }
  async function orderRow(orderId) { const [[r]] = await pool.query(`SELECT * FROM orders WHERE id=?`, [orderId]); return r; }

  const res = await CustomerAgent.create({ name: `${tag} Customer`, partner_type: 2, default_sales_flow: 'INVENTORY_SALE', price_mode: 'PRIVATE_PRICE', billing_calendar_type: 'SOLAR' }, admin);
  const [[custRow]] = await pool.query(`SELECT id FROM customers WHERE customer_code=?`, [res.customer_code]);
  const custId = custRow.id;
  const pname = `${tag} Product`;
  await ProductAgent.addProduct({ name: pname, unit: 'kg', category_id: catId, inventory_mode: 'TRACK_STOCK', sales_flow: 'INVENTORY_SALE', stock_quantity: 100, allow_negative_stock: 0 });
  const [[product]] = await pool.query(`SELECT * FROM products WHERE name=?`, [pname]);
  await PriceMatrixAgent.createCustomerPriceCategory(custId, catId, { sales_flow: 'INVENTORY_SALE' });
  await PriceMatrixAgent.saveMatrix(custId, [{ product_id: product.id, private_price: 100000, in_catalog: true }], null, { effective_from: today, effective_calendar_type: 'SOLAR' }, catId);

  // Step 1: bill 1 for 100,000, overpay by 40,000 to create real unapplied credit
  // via the SAME mechanism PaymentAgent.create() uses in production (V65.38/V65.40).
  const bill1 = await OrderAgent.create({ customer_id: custId, order_date: today, items: [{ product_id: product.id, product_name: product.name, unit: 'kg', quantity: 1 }] }, admin);
  const overpay = await PaymentAgent.create({ customer_id: custId, order_id: bill1.order_id, cash_amount: 140000, bank_amount: 0, payment_date: today, idempotency_key: `${tag}-overpay` }, admin);
  const [[creditRow]] = await pool.query(`SELECT * FROM payment_unapplied_credits WHERE customer_id=? AND remaining_amount>0 ORDER BY id DESC LIMIT 1`, [custId]);
  check('Setup: overpayment created a real unapplied credit row (40,000)', !!creditRow && Number(creditRow.remaining_amount) === 40000, creditRow);
  check('Setup: bill1 is fully paid (debt=0)', Number((await orderRow(bill1.order_id)).debt_amount) === 0);
  check('Setup: bill1 ledger reconciles (0)', await ledgerSumForOrder(bill1.order_id) === 0);

  // Step 2: create a NEW bill for the SAME customer. OrderAgent.create() calls
  // allocateExistingCreditsToOpenBills() automatically (OrderAgent.js, right
  // after debt_transactions SALE insert) — this is the exact reachable path,
  // not a direct/synthetic call to the allocator.
  const bill2 = await OrderAgent.create({ customer_id: custId, order_date: today, items: [{ product_id: product.id, product_name: product.name, unit: 'kg', quantity: 1 }] }, admin);
  const bill2After = await orderRow(bill2.order_id);
  const [[creditAfter]] = await pool.query(`SELECT remaining_amount FROM payment_unapplied_credits WHERE id=?`, [creditRow.id]);

  check('Bill2: the existing 40,000 credit was auto-applied (bill2 total=100,000, debt should be 60,000 if applied)', Number(bill2After.debt_amount) === 60000, bill2After);
  check('Bill2: the credit row was consumed down to 0 remaining', Number(creditAfter.remaining_amount) === 0, creditAfter);

  const bill2LedgerSum = await ledgerSumForOrder(bill2.order_id);
  const invariantHolds = Math.abs(bill2LedgerSum - Number(bill2After.debt_amount)) < 0.01;
  check('THE INVARIANT: signed SUM(debt_transactions WHERE order_id=bill2) equals orders.debt_amount for bill2',
    invariantHolds,
    { ledger_sum: bill2LedgerSum, orders_debt_amount: Number(bill2After.debt_amount), expected_if_bug_present: 'ledger_sum=100000 (only the SALE row, no compensating row for the 40,000 credit application), orders.debt_amount=60000 -> MISMATCH of exactly the credit amount' });

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
