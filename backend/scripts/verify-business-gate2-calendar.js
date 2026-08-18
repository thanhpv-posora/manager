'use strict';
// CTO GO-LIVE FINAL BUSINESS ACCEPTANCE — GATE 2: Solar/Lunar billing.
//
// Rules exercised (DERIVED from current code):
//  - backend/src/utils/billCalendar.js resolveAuthoritativeCalendar() (S1D
//    Rule 3): customers.billing_calendar_type is authoritative for every
//    bill-creating write, re-read FRESH from the DB inside the transaction —
//    never trusted from the request. A LUNAR customer's bill always resolves
//    LUNAR (deriving lunar_date_text from order_date via solar->lunar
//    conversion when not supplied); a SOLAR customer's bill always resolves
//    SOLAR (any lunar_date_text sent is ignored).
//  - The resolved calendar_type/lunar_date_text is PERSISTED onto the orders
//    row at creation time, not re-derived live on every read — so changing
//    the customer's billing_calendar_type afterward cannot retroactively
//    alter an already-created bill (structural immutability, not a
//    special-cased guard — verified empirically below, not assumed).
//  - "Ngày xuất hàng" = orders.order_date (confirmed via PaymentAgent.js's
//    own comments: "phân bổ ... theo ngày xuất hàng" orders by order_date).
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
  console.log(`=== GATE 2: Solar/Lunar billing + historical immutability (${TARGET}) ===\n`);

  const ProductAgent = require('../src/agents/ProductAgent');
  const CustomerAgent = require('../src/agents/CustomerAgent');
  const OrderAgent = require('../src/agents/OrderAgent');
  const PaymentAgent = require('../src/agents/PaymentAgent');
  const PriceMatrixAgent = require('../src/agents/PriceMatrixAgent');
  const ReportAgent = require('../src/agents/ReportAgent');
  const { solarToLunar } = require('../src/utils/lunarDate');

  const admin = { id: null, role: 'ADMIN' };
  const today = new Date().toISOString().slice(0, 10);
  const tag = `G2-${Date.now()}`;

  const [[cat]] = await pool.query(`SELECT id FROM product_categories WHERE del_flg=0 ORDER BY id LIMIT 1`);
  const catId = cat.id;

  async function makeCustomer(name, calendarType, defaultFlow = 'INVENTORY_SALE') {
    const res = await CustomerAgent.create({ name: `${tag} ${name}`, phone: `09${String(Date.now()).slice(-6)}${String(Math.floor(Math.random()*90)+10)}`, partner_type: 2, default_sales_flow: defaultFlow, price_mode: 'PRIVATE_PRICE', billing_calendar_type: calendarType }, admin);
    const [[row]] = await pool.query(`SELECT id FROM customers WHERE customer_code=?`, [res.customer_code]);
    return row.id;
  }
  async function makeProduct(name, qty) {
    const full = `${tag} ${name}`;
    await ProductAgent.addProduct({ name: full, unit: 'kg', category_id: catId, inventory_mode: 'TRACK_STOCK', sales_flow: 'INVENTORY_SALE', stock_quantity: qty, allow_negative_stock: 0 });
    const [[p]] = await pool.query(`SELECT * FROM products WHERE name=? LIMIT 1`, [full]);
    return p;
  }

  const custSolar = await makeCustomer('Solar Customer', 'SOLAR');
  const custLunar = await makeCustomer('Lunar Customer', 'LUNAR');
  const product = await makeProduct('Sản phẩm lịch', 200);
  await PriceMatrixAgent.createCustomerPriceCategory(custSolar, catId, { sales_flow: 'INVENTORY_SALE' });
  await PriceMatrixAgent.createCustomerPriceCategory(custLunar, catId, { sales_flow: 'INVENTORY_SALE' });
  await PriceMatrixAgent.saveMatrix(custSolar, [{ product_id: product.id, private_price: 50000, in_catalog: true }], null, { effective_from: '2020-01-01', effective_calendar_type: 'SOLAR' }, catId);
  // A LUNAR customer's price book must itself be versioned in LUNAR dates —
  // PriceMatrixAgent.assertCalendarMatchesCustomer() enforces this (real,
  // sensible rule discovered while writing this test, not invented): a price
  // book's own calendar type must match the customer's billing calendar.
  await PriceMatrixAgent.saveMatrix(custLunar, [{ product_id: product.id, private_price: 50000, in_catalog: true }], null, { effective_from: '2020-01-01', effective_calendar_type: 'LUNAR', effective_lunar_date_text: '01/01/2020' }, catId);

  // ══════════════════ Basic resolution: SOLAR customer, LUNAR customer ══════════════════
  const billDateSolar = today;
  const rSolar = await OrderAgent.create({ customer_id: custSolar, order_date: billDateSolar, items: [{ product_id: product.id, product_name: product.name, unit: 'kg', quantity: 1 }] }, admin);
  const [[oSolar]] = await pool.query(`SELECT order_date, calendar_type, lunar_date_text FROM orders WHERE id=?`, [rSolar.order_id]);
  check('SOLAR customer: bill resolves calendar_type=SOLAR', oSolar.calendar_type === 'SOLAR', oSolar);
  check('SOLAR customer: order_date ("Ngày xuất hàng") matches the requested date', String(oSolar.order_date).slice(0, 10) === billDateSolar, oSolar);
  check('SOLAR customer: lunar_date_text is empty (never used for a SOLAR bill)', !oSolar.lunar_date_text, oSolar);

  // A SOLAR customer's bill ignores any lunar_date_text sent — proves the
  // customer's OWN billing_calendar_type wins, never a client-supplied value.
  const rSolarIgnoresLunar = await OrderAgent.create({ customer_id: custSolar, order_date: billDateSolar, calendar_type: 'LUNAR', lunar_date_text: '01/01/2020', items: [{ product_id: product.id, product_name: product.name, unit: 'kg', quantity: 1 }] }, admin);
  const [[oSolarIgnores]] = await pool.query(`SELECT calendar_type, lunar_date_text FROM orders WHERE id=?`, [rSolarIgnoresLunar.order_id]);
  check('SOLAR customer: request-supplied calendar_type=LUNAR/lunar_date_text is IGNORED (customer config wins)', oSolarIgnores.calendar_type === 'SOLAR' && !oSolarIgnores.lunar_date_text, oSolarIgnores);

  const expectedLunar = solarToLunar(today);
  const expectedLunarText = `${String(expectedLunar.day).padStart(2, '0')}/${String(expectedLunar.month).padStart(2, '0')}/${expectedLunar.year}`;
  const rLunar = await OrderAgent.create({ customer_id: custLunar, order_date: today, items: [{ product_id: product.id, product_name: product.name, unit: 'kg', quantity: 1 }] }, admin);
  const [[oLunar]] = await pool.query(`SELECT order_date, calendar_type, lunar_date_text FROM orders WHERE id=?`, [rLunar.order_id]);
  check('LUNAR customer: bill resolves calendar_type=LUNAR', oLunar.calendar_type === 'LUNAR', oLunar);
  check('LUNAR customer: lunar_date_text auto-derived from order_date when not supplied', oLunar.lunar_date_text === expectedLunarText, { got: oLunar.lunar_date_text, expected: expectedLunarText });
  check('LUNAR customer: order_date ("Ngày xuất hàng") still stored as the real solar date', String(oLunar.order_date).slice(0, 10) === today, oLunar);

  // ══════════════════ Payment/debt dates follow the same bill ══════════════════
  const payLunar = await PaymentAgent.create({ customer_id: custLunar, order_id: rLunar.order_id, cash_amount: 50000, bank_amount: 0, payment_date: today, idempotency_key: `${tag}-pay-lunar` }, admin);
  const [[payRow]] = await pool.query(`SELECT payment_calendar_type, payment_lunar_date_text FROM payments WHERE id=?`, [payLunar.payment_id]);
  check('Payment on a LUNAR bill inherits LUNAR calendar_type/lunar_date_text', payRow.payment_calendar_type === 'LUNAR' && payRow.payment_lunar_date_text === expectedLunarText, payRow);

  // ══════════════════ Report sanity — bills queryable, no crash ══════════════════
  const dash = await ReportAgent.dashboard({ role: 'ADMIN' });
  check('Reports run cleanly with both SOLAR and LUNAR bills present', !!dash && !!dash.summary, dash && dash.summary);

  // ══════════════════ HISTORICAL IMMUTABILITY ══════════════════
  // Bill already created above for custSolar with calendar_type=SOLAR. Now
  // flip the customer to LUNAR and create a NEW bill — old bill must retain
  // its original frozen values; only the new bill follows the new config.
  await pool.query(`UPDATE customers SET billing_calendar_type='LUNAR' WHERE id=?`, [custSolar]);
  const [[custSolarAfterFlip]] = await pool.query(`SELECT billing_calendar_type FROM customers WHERE id=?`, [custSolar]);
  check('Immutability setup: customer billing_calendar_type actually flipped to LUNAR', custSolarAfterFlip.billing_calendar_type === 'LUNAR', custSolarAfterFlip);

  const [[oSolarAfterFlip]] = await pool.query(`SELECT order_date, calendar_type, lunar_date_text FROM orders WHERE id=?`, [rSolar.order_id]);
  check('IMMUTABILITY: old bill keeps calendar_type=SOLAR after customer flips to LUNAR', oSolarAfterFlip.calendar_type === 'SOLAR', oSolarAfterFlip);
  check('IMMUTABILITY: old bill keeps order_date unchanged', String(oSolarAfterFlip.order_date).slice(0, 10) === billDateSolar, oSolarAfterFlip);
  check('IMMUTABILITY: old bill keeps lunar_date_text unchanged (still empty)', !oSolarAfterFlip.lunar_date_text, oSolarAfterFlip);

  // manual_price: true — custSolar's only price book is SOLAR-dated (calendar
  // type is a hard partition on price-book resolution, confirmed above), so a
  // LUNAR-resolved bill for them finds no matching book. Real business action
  // would be to set up a LUNAR book too; sidestepped here since price
  // resolution isn't what this specific check is proving (calendar_type is).
  const rNewAfterFlip = await OrderAgent.create({ customer_id: custSolar, order_date: today, items: [{ product_id: product.id, product_name: product.name, unit: 'kg', quantity: 1, sale_price: 50000, manual_price: true }] }, admin);
  const [[oNewAfterFlip]] = await pool.query(`SELECT calendar_type, lunar_date_text FROM orders WHERE id=?`, [rNewAfterFlip.order_id]);
  check('IMMUTABILITY: NEW bill after the flip uses the NEW config (LUNAR)', oNewAfterFlip.calendar_type === 'LUNAR' && oNewAfterFlip.lunar_date_text === expectedLunarText, oNewAfterFlip);

  // Also verify a payment made NOW (after the flip) against the OLD (SOLAR)
  // bill still resolves the payment's own calendar fields from that ORDER's
  // frozen calendar_type, not the customer's current (now LUNAR) setting.
  const payOldBillAfterFlip = await PaymentAgent.create({ customer_id: custSolar, order_id: rSolar.order_id, cash_amount: 50000, bank_amount: 0, payment_date: today, idempotency_key: `${tag}-pay-old-after-flip` }, admin);
  const [[payOldRow]] = await pool.query(`SELECT payment_calendar_type FROM payments WHERE id=?`, [payOldBillAfterFlip.payment_id]);
  check('IMMUTABILITY: paying the OLD (SOLAR) bill after the customer flipped to LUNAR still records payment_calendar_type=SOLAR (follows the bill, not the current customer config)', payOldRow.payment_calendar_type === 'SOLAR', payOldRow);

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
