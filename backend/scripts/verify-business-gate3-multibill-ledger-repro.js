'use strict';
// Focused reproduction — does a multi-bill-spanning payment's per-order ledger
// misattribution (found while writing Gate 3) let a LATER góp nợ payment
// against the fully-paid bill resurrect its debt via PaymentAgent's new
// ledger-derived ensureOrderPayableTotal() (GO-LIVE BLOCKER 3 fix)?
require('dotenv').config();
const TARGET = process.env.CR4_FRESH_DB;
const APP_DB = process.env.DB_NAME;
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}
async function main() {
  if (!TARGET || TARGET === APP_DB) { console.error('refusing'); process.exit(2); }
  process.env.DB_NAME = TARGET;
  const pool = require('../src/config/db');
  const [[who]] = await pool.query('SELECT DATABASE() db');
  if (who.db !== TARGET) { console.error('wrong db'); process.exit(2); }
  console.log(`=== Multi-bill ledger misattribution repro (${TARGET}) ===\n`);

  const ProductAgent = require('../src/agents/ProductAgent');
  const CustomerAgent = require('../src/agents/CustomerAgent');
  const OrderAgent = require('../src/agents/OrderAgent');
  const PaymentAgent = require('../src/agents/PaymentAgent');
  const PriceMatrixAgent = require('../src/agents/PriceMatrixAgent');
  const DebtMonthlyInstallmentAgent = require('../src/agents/DebtMonthlyInstallmentAgent');
  const admin = { id: null, role: 'ADMIN' };
  const today = new Date().toISOString().slice(0, 10);
  const tag = `G3REPRO-${Date.now()}`;
  const [[cat]] = await pool.query(`SELECT id FROM product_categories WHERE del_flg=0 ORDER BY id LIMIT 1`);
  const catId = cat.id;

  const res = await CustomerAgent.create({ name: `${tag} Customer`, phone: `09${String(Date.now()).slice(-6)}${String(Math.floor(Math.random()*90)+10)}`, partner_type: 2, default_sales_flow: 'INVENTORY_SALE', price_mode: 'PRIVATE_PRICE', billing_calendar_type: 'SOLAR' }, admin);
  const [[custRow]] = await pool.query(`SELECT id FROM customers WHERE customer_code=?`, [res.customer_code]);
  const custId = custRow.id;
  const pname = `${tag} Product`;
  await ProductAgent.addProduct({ name: pname, unit: 'kg', category_id: catId, inventory_mode: 'TRACK_STOCK', sales_flow: 'INVENTORY_SALE', stock_quantity: 100, allow_negative_stock: 0 });
  const [[product]] = await pool.query(`SELECT * FROM products WHERE name=?`, [pname]);
  await PriceMatrixAgent.createCustomerPriceCategory(custId, catId, { sales_flow: 'INVENTORY_SALE' });
  await PriceMatrixAgent.saveMatrix(custId, [{ product_id: product.id, private_price: 100000, in_catalog: true }], null, { effective_from: today, effective_calendar_type: 'SOLAR' }, catId);

  const bill1 = await OrderAgent.create({ customer_id: custId, order_date: today, items: [{ product_id: product.id, product_name: product.name, unit: 'kg', quantity: 1 }] }, admin); // 100,000
  const bill2 = await OrderAgent.create({ customer_id: custId, order_date: today, items: [{ product_id: product.id, product_name: product.name, unit: 'kg', quantity: 1 }] }, admin); // 100,000

  // ONE payment, 150,000, targeting bill2 — auto-allocates oldest-first:
  // 100,000 clears bill1, 50,000 lands on bill2. Ledger PAYMENT row is posted
  // ONCE, attributed entirely to order_id=bill2.
  const pay1 = await PaymentAgent.create({ customer_id: custId, order_id: bill2.order_id, cash_amount: 150000, bank_amount: 0, payment_date: today, idempotency_key: `${tag}-pay1` }, admin);

  const [[b1]] = await pool.query(`SELECT debt_amount FROM orders WHERE id=?`, [bill1.order_id]);
  const [[b2]] = await pool.query(`SELECT debt_amount FROM orders WHERE id=?`, [bill2.order_id]);
  check('Setup: bill1 correctly cleared by the cross-bill allocation (debt=0)', Number(b1.debt_amount) === 0, b1);
  check('Setup: bill2 correctly holds the remainder (debt=50,000)', Number(b2.debt_amount) === 50000, b2);

  async function ledgerSumForOrder(orderId) {
    const [[r]] = await pool.query(`SELECT COALESCE(SUM(CASE WHEN type IN ('SALE','ADJUSTMENT_INCREASE') THEN amount WHEN type IN ('PAYMENT','ADJUSTMENT_DECREASE') THEN -amount ELSE 0 END),0) net FROM debt_transactions WHERE order_id=?`, [orderId]);
    return Number(r.net);
  }
  const ledger1 = await ledgerSumForOrder(bill1.order_id);
  const ledger2 = await ledgerSumForOrder(bill2.order_id);
  check('CONFIRMED: bill1\'s own per-order ledger did NOT receive the 100,000 applied to it (stuck at 100,000, not 0) — the PAYMENT row went entirely to bill2\'s order_id', ledger1 === 100000, { ledger1, trueDebt: b1.debt_amount });
  check('CONFIRMED: bill2\'s own per-order ledger absorbed the FULL 150,000 (goes negative: 100,000-150,000=-50,000) instead of just its real 50,000 share', ledger2 === -50000, { ledger2, trueDebt: b2.debt_amount });

  // Now configure góp nợ and make ANOTHER payment specifically against bill1
  // (which is genuinely, correctly fully paid) to see if ensureOrderPayableTotal's
  // ledger-derived recompute (GO-LIVE BLOCKER 3 fix) wrongly resurrects it.
  await DebtMonthlyInstallmentAgent.saveDailyInstallment({ customer_id: custId, config_date: today, calendar_type: 'SOLAR', installment_amount: 5000, status: 'ACTIVE' });
  const active = await DebtMonthlyInstallmentAgent.activeByDate(custId, today, 'SOLAR');

  const pay2 = await PaymentAgent.create({
    customer_id: custId, order_id: bill1.order_id, cash_amount: 1, bank_amount: 0, payment_date: today,
    current_bill_amount: 100000, monthly_installment_amount: active.installment_amount,
    idempotency_key: `${tag}-pay2`,
  }, admin);

  const [[b1After]] = await pool.query(`SELECT debt_amount, total_amount FROM orders WHERE id=?`, [bill1.order_id]);
  check('THE QUESTION: does bill1 (truly fully paid before this) get its debt wrongly resurrected by ensureOrderPayableTotal\'s ledger-derived recompute?',
    true, { debt_amount_after: b1After.debt_amount, total_amount_after: b1After.total_amount, expected_if_bug_present: 'debt_amount near 100,000+', expected_if_correct: 'debt_amount near 0 (105,000 total - 1 - ~0 = ~104,999 is WRONG too if total inflated; correct is total=105,000, debt=104,999 only if this is a legitimately NEW charge, but the PRE-EXISTING 100,000 must not double-count' });

  console.log(`\n${pass} passed, ${fail} failed (informational check above always "passes" — read the detail)`);
  await pool.end();
  process.exit(0);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
