'use strict';
// CTO GO-LIVE FINAL BUSINESS ACCEPTANCE — GATE 5: Combined customer matrix.
//
// Each scenario combines dimensions individually proven in Gates 1-4
// (calendar type, góp nợ on/off, price source, sales_flow) into one
// realistic customer profile, to catch any interaction the single-dimension
// gates couldn't see:
//   A: SOLAR + no góp nợ  + private price (price book) + INVENTORY_SALE
//   B: LUNAR + góp nợ     + private price (price book) + CARCASS_POS
//   C: SOLAR + góp nợ     + no active price book (COMMON_PRICE fallback)
//   D: LUNAR + no góp nợ  + price changes by effective_from (V1/V2 under LUNAR)
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
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function main() {
  if (!TARGET) { console.error('CR4_FRESH_DB is not set — refusing to run.'); process.exit(2); }
  if (TARGET === APP_DB) { console.error(`CR4_FRESH_DB (${TARGET}) is the application database — refusing.`); process.exit(2); }
  process.env.DB_NAME = TARGET;
  const pool = require('../src/config/db');
  const [[who]] = await pool.query('SELECT DATABASE() db');
  if (who.db !== TARGET) { console.error(`pool connected to ${who.db}, not ${TARGET} — refusing.`); process.exit(2); }
  console.log(`=== GATE 5: Combined customer matrix (${TARGET}) ===\n`);

  const ProductAgent = require('../src/agents/ProductAgent');
  const CustomerAgent = require('../src/agents/CustomerAgent');
  const OrderAgent = require('../src/agents/OrderAgent');
  const PaymentAgent = require('../src/agents/PaymentAgent');
  const PriceMatrixAgent = require('../src/agents/PriceMatrixAgent');
  const DebtMonthlyInstallmentAgent = require('../src/agents/DebtMonthlyInstallmentAgent');
  const { solarToLunar } = require('../src/utils/lunarDate');

  const admin = { id: null, role: 'ADMIN' };
  const today = new Date().toISOString().slice(0, 10);
  const tag = `G5-${Date.now()}`;

  const [[warehouseCat]] = await pool.query(`SELECT id FROM product_categories WHERE del_flg=0 AND name NOT LIKE '%Bò xô%' ORDER BY id LIMIT 1`);
  const [[carcassCat]] = await pool.query(`SELECT id FROM product_categories WHERE del_flg=0 AND name LIKE '%Bò xô%' LIMIT 1`);

  function lunarTextOf(solarDate) {
    const l = solarToLunar(solarDate);
    return `${String(l.day).padStart(2, '0')}/${String(l.month).padStart(2, '0')}/${l.year}`;
  }

  async function makeCustomer(name, defaultFlow, calendarType) {
    const res = await CustomerAgent.create({ name: `${tag} ${name}`, phone: `09${String(Date.now()).slice(-6)}${String(Math.floor(Math.random()*90)+10)}`, partner_type: 2, default_sales_flow: defaultFlow, price_mode: 'PRIVATE_PRICE', billing_calendar_type: calendarType }, admin);
    const [[row]] = await pool.query(`SELECT id FROM customers WHERE customer_code=?`, [res.customer_code]);
    return row.id;
  }
  async function makeProduct(name, categoryId, defaultPrice, flow, inventoryMode, qty) {
    const full = `${tag} ${name}`;
    await ProductAgent.addProduct({ name: full, unit: 'kg', category_id: categoryId, inventory_mode: inventoryMode, sales_flow: flow, stock_quantity: qty || 0, allow_negative_stock: 0, default_sale_price: defaultPrice });
    const [[p]] = await pool.query(`SELECT * FROM products WHERE name=? LIMIT 1`, [full]);
    return p;
  }
  async function orderRow(orderId) { const [[r]] = await pool.query(`SELECT * FROM orders WHERE id=?`, [orderId]); return r; }
  async function itemsOf(orderId) { const [rows] = await pool.query(`SELECT product_id,sale_price,price_type,price_book_id FROM order_items WHERE order_id=?`, [orderId]); return rows; }
  async function stockOf(productId) { const [[p]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [productId]); return Number(p.stock_quantity); }
  async function ledgerSumForOrder(orderId) {
    const [[r]] = await pool.query(`SELECT COALESCE(SUM(CASE WHEN type IN ('SALE','ADJUSTMENT_INCREASE') THEN amount WHEN type IN ('PAYMENT','ADJUSTMENT_DECREASE') THEN -amount ELSE 0 END),0) net FROM debt_transactions WHERE order_id=?`, [orderId]);
    return Number(r.net);
  }
  async function customerLedgerVsOrders(customerId) {
    const [[ledger]] = await pool.query(`SELECT COALESCE(SUM(CASE WHEN type IN ('SALE','ADJUSTMENT_INCREASE') THEN amount WHEN type IN ('PAYMENT','ADJUSTMENT_DECREASE') THEN -amount ELSE 0 END),0) net FROM debt_transactions WHERE customer_id=?`, [customerId]);
    const [[orders]] = await pool.query(`SELECT COALESCE(SUM(debt_amount),0) total FROM orders WHERE customer_id=? AND status<>'CANCELLED'`, [customerId]);
    return { ledgerNet: Number(ledger.net), ordersTotal: Number(orders.total), match: Math.abs(Number(ledger.net) - Number(orders.total)) < 0.01 };
  }

  // ══════════════════ A: SOLAR + no góp nợ + private price + INVENTORY_SALE ══════════════════
  {
    const custId = await makeCustomer('Matrix A', 'INVENTORY_SALE', 'SOLAR');
    const product = await makeProduct('A Item', warehouseCat.id, 10000, 'INVENTORY_SALE', 'TRACK_STOCK', 50);
    await PriceMatrixAgent.createCustomerPriceCategory(custId, warehouseCat.id, { sales_flow: 'INVENTORY_SALE' });
    await PriceMatrixAgent.saveMatrix(custId, [{ product_id: product.id, private_price: 45000, in_catalog: true }], null, { effective_from: today, effective_calendar_type: 'SOLAR' }, warehouseCat.id);

    const active = await DebtMonthlyInstallmentAgent.activeByDate(custId, today, 'SOLAR');
    check('A. No góp nợ configured for this customer (rate=0)', Number(active.installment_amount) === 0, active);

    const bill = await OrderAgent.create({ customer_id: custId, order_date: today, items: [{ product_id: product.id, product_name: product.name, unit: 'kg', quantity: 2 }] }, admin);
    const order = await orderRow(bill.order_id);
    const [line] = await itemsOf(bill.order_id);
    check('A. Bill resolves calendar_type=SOLAR', order.calendar_type === 'SOLAR' && !order.lunar_date_text, order);
    check('A. Bill resolves PRIVATE price book price (45,000/kg x2 = 90,000)', Number(line.sale_price) === 45000 && line.price_type === 'PRICE_BOOK' && Number(order.total_amount) === 90000, { line, total: order.total_amount });
    check('A. INVENTORY_SALE deducts stock (50 -> 48)', await stockOf(product.id) === 48);

    const pay = await PaymentAgent.create({ customer_id: custId, order_id: bill.order_id, cash_amount: 40000, bank_amount: 0, payment_date: today, idempotency_key: `${tag}-A-pay` }, admin);
    const orderAfter = await orderRow(bill.order_id);
    check('A. NO góp nợ amount applied — total_amount stays 90,000 after payment', Number(orderAfter.total_amount) === 90000, orderAfter);
    check('A. debt reduces by exactly the payment (90,000 -> 50,000)', Number(orderAfter.debt_amount) === 50000, orderAfter);
    check('A. installment_amount stays 0', Number(orderAfter.installment_amount || 0) === 0, orderAfter);
    check('A. Ledger reconciles for the bill', await ledgerSumForOrder(bill.order_id) === 50000);
    check('A. Customer-wide ledger-vs-orders reconciliation holds', (await customerLedgerVsOrders(custId)).match);
  }

  // ══════════════════ B: LUNAR + góp nợ + private price + CARCASS_POS ══════════════════
  {
    const custId = await makeCustomer('Matrix B', 'CARCASS_POS', 'LUNAR');
    const product = await makeProduct('B Đùi', carcassCat.id, 0, 'CARCASS_POS', 'NON_STOCK', 0);
    await PriceMatrixAgent.createCustomerPriceCategory(custId, carcassCat.id, { sales_flow: 'CARCASS_POS' });
    const todayLunarText = lunarTextOf(today);
    await PriceMatrixAgent.saveMatrix(custId, [{ product_id: product.id, private_price: 170000, in_catalog: true }], null, { effective_from: today, effective_calendar_type: 'LUNAR', effective_lunar_date_text: todayLunarText }, carcassCat.id);

    await DebtMonthlyInstallmentAgent.saveDailyInstallment({ customer_id: custId, config_date: today, calendar_type: 'LUNAR', lunar_date_text: todayLunarText, installment_amount: 15000, status: 'ACTIVE' });
    const active = await DebtMonthlyInstallmentAgent.activeByDate(custId, today, 'LUNAR', todayLunarText);
    check('B. Góp nợ configured under LUNAR calendar resolves (15,000/day)', Number(active.installment_amount) === 15000, active);

    const stockBefore = await stockOf(product.id);
    const bill = await OrderAgent.create({ customer_id: custId, order_date: today, items: [{ product_id: product.id, product_name: product.name, unit: 'kg', quantity: 3 }] }, admin);
    const order = await orderRow(bill.order_id);
    const [line] = await itemsOf(bill.order_id);
    check('B. Bill resolves calendar_type=LUNAR with the correct auto-derived lunar_date_text', order.calendar_type === 'LUNAR' && order.lunar_date_text === todayLunarText, order);
    check('B. Bill resolves the LUNAR-versioned private price book price (170,000/kg x3 = 510,000)', Number(line.sale_price) === 170000 && line.price_type === 'PRICE_BOOK' && Number(order.total_amount) === 510000, { line, total: order.total_amount });
    check('B. CARCASS_POS (NON_STOCK) sale does not touch stock_quantity', await stockOf(product.id) === stockBefore);

    const pay = await PaymentAgent.create({
      customer_id: custId, order_id: bill.order_id, cash_amount: 300000, bank_amount: 0, payment_date: today,
      current_bill_amount: 510000, monthly_installment_amount: active.installment_amount,
      idempotency_key: `${tag}-B-pay`,
    }, admin);
    const [[payRow]] = await pool.query(`SELECT payment_calendar_type,payment_lunar_date_text FROM payments WHERE id=?`, [pay.payment_id]);
    check('B. Payment inherits LUNAR calendar_type/lunar_date_text from the bill', payRow.payment_calendar_type === 'LUNAR' && payRow.payment_lunar_date_text === todayLunarText, payRow);
    const orderAfter = await orderRow(bill.order_id);
    check('B. total_amount grows by the góp nợ installment (510,000 + 15,000 = 525,000)', Number(orderAfter.total_amount) === 525000, orderAfter);
    check('B. debt = 525,000 - 300,000 = 225,000', Number(orderAfter.debt_amount) === 225000, orderAfter);
    check('B. installment_amount persisted on the order (15,000)', Number(orderAfter.installment_amount) === 15000, orderAfter);
    check('B. Ledger reconciles for the bill', await ledgerSumForOrder(bill.order_id) === 225000, await ledgerSumForOrder(bill.order_id));
    check('B. Customer-wide ledger-vs-orders reconciliation holds', (await customerLedgerVsOrders(custId)).match);
  }

  // ══════════════════ C: SOLAR + góp nợ + no active price book (COMMON_PRICE fallback) ══════════════════
  {
    const custId = await makeCustomer('Matrix C', 'INVENTORY_SALE', 'SOLAR');
    const product = await makeProduct('C Item', warehouseCat.id, 25000, 'INVENTORY_SALE', 'TRACK_STOCK', 30);
    // Deliberately NO createCustomerPriceCategory / saveMatrix call — customer has zero price books at all.
    await DebtMonthlyInstallmentAgent.saveDailyInstallment({ customer_id: custId, config_date: today, calendar_type: 'SOLAR', installment_amount: 10000, status: 'ACTIVE' });
    const active = await DebtMonthlyInstallmentAgent.activeByDate(custId, today, 'SOLAR');
    check('C. Góp nợ configured despite no price book (independent mechanisms, 10,000/day)', Number(active.installment_amount) === 10000, active);

    const bill = await OrderAgent.create({ customer_id: custId, order_date: today, items: [{ product_id: product.id, product_name: product.name, unit: 'kg', quantity: 4 }] }, admin);
    const [line] = await itemsOf(bill.order_id);
    const order = await orderRow(bill.order_id);
    check('C. No price book -> COMMON_PRICE fallback (25,000/kg x4 = 100,000), price_book_id NULL', Number(line.sale_price) === 25000 && line.price_type === 'COMMON_PRICE' && !line.price_book_id && Number(order.total_amount) === 100000, { line, total: order.total_amount });
    check('C. INVENTORY_SALE still deducts stock correctly (30 -> 26) even via COMMON_PRICE', await stockOf(product.id) === 26);

    const pay = await PaymentAgent.create({
      customer_id: custId, order_id: bill.order_id, cash_amount: 60000, bank_amount: 0, payment_date: today,
      current_bill_amount: 100000, monthly_installment_amount: active.installment_amount,
      idempotency_key: `${tag}-C-pay`,
    }, admin);
    const orderAfter = await orderRow(bill.order_id);
    check('C. total_amount grows by the góp nợ installment even on a COMMON_PRICE bill (100,000 + 10,000 = 110,000)', Number(orderAfter.total_amount) === 110000, orderAfter);
    check('C. debt = 110,000 - 60,000 = 50,000', Number(orderAfter.debt_amount) === 50000, orderAfter);
    check('C. Ledger reconciles for the bill', await ledgerSumForOrder(bill.order_id) === 50000);
    check('C. Customer-wide ledger-vs-orders reconciliation holds', (await customerLedgerVsOrders(custId)).match);
  }

  // ══════════════════ D: LUNAR + no góp nợ + price changes by effective_from (V1/V2 under LUNAR) ══════════════════
  {
    const custId = await makeCustomer('Matrix D', 'INVENTORY_SALE', 'LUNAR');
    const product = await makeProduct('D Item', warehouseCat.id, 0, 'INVENTORY_SALE', 'TRACK_STOCK', 100);
    await PriceMatrixAgent.createCustomerPriceCategory(custId, warehouseCat.id, { sales_flow: 'INVENTORY_SALE' });

    const D1 = addDays(today, -20);
    const D2 = addDays(today, -10);
    const L1 = lunarTextOf(D1);
    const L2 = lunarTextOf(D2);
    await PriceMatrixAgent.saveMatrix(custId, [{ product_id: product.id, private_price: 60000, in_catalog: true }], null, { effective_from: D1, effective_calendar_type: 'LUNAR', effective_lunar_date_text: L1 }, warehouseCat.id);
    await PriceMatrixAgent.saveMatrix(custId, [{ product_id: product.id, private_price: 80000, in_catalog: true }], null, { effective_from: D2, effective_calendar_type: 'LUNAR', effective_lunar_date_text: L2 }, warehouseCat.id);

    const active = await DebtMonthlyInstallmentAgent.activeByDate(custId, today, 'LUNAR', lunarTextOf(today));
    check('D. No góp nợ configured for this customer (rate=0)', Number(active.installment_amount) === 0, active);

    const billD1 = await OrderAgent.create({ customer_id: custId, order_date: D1, items: [{ product_id: product.id, product_name: product.name, unit: 'kg', quantity: 1 }] }, admin);
    const [lineD1] = await itemsOf(billD1.order_id);
    const orderD1 = await orderRow(billD1.order_id);
    check('D. Bill at D1 (LUNAR) resolves V1 price (60,000) with the correct lunar_date_text', Number(lineD1.sale_price) === 60000 && orderD1.calendar_type === 'LUNAR' && orderD1.lunar_date_text === L1, { lineD1, orderD1 });

    const billD2 = await OrderAgent.create({ customer_id: custId, order_date: D2, items: [{ product_id: product.id, product_name: product.name, unit: 'kg', quantity: 1 }] }, admin);
    const [lineD2] = await itemsOf(billD2.order_id);
    check('D. Bill at D2 (LUNAR, on-or-after V2\'s effective date) resolves V2 price (80,000)', Number(lineD2.sale_price) === 80000, lineD2);

    check('D. Bill at D1 has no installment growth (total_amount == item total, 60,000)', Number(orderD1.total_amount) === 60000, orderD1);

    // Re-confirm D1's bill is untouched by V2 having been created after it (immutability, LUNAR path).
    const [lineD1After] = await itemsOf(billD1.order_id);
    check('D. IMMUTABILITY: D1 bill still resolves V1 price (60,000) after V2 exists', Number(lineD1After.sale_price) === 60000, lineD1After);

    const payD1 = await PaymentAgent.create({ customer_id: custId, order_id: billD1.order_id, cash_amount: 60000, bank_amount: 0, payment_date: today, idempotency_key: `${tag}-D-pay` }, admin);
    const orderD1After = await orderRow(billD1.order_id);
    check('D. Payment with no installment fields leaves total_amount unchanged (60,000), bill fully paid', Number(orderD1After.total_amount) === 60000 && Number(orderD1After.debt_amount) === 0 && orderD1After.payment_status === 'PAID', orderD1After);
    check('D. Ledger reconciles for the D1 bill', await ledgerSumForOrder(billD1.order_id) === 0);
    check('D. Customer-wide ledger-vs-orders reconciliation holds', (await customerLedgerVsOrders(custId)).match);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
