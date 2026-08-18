'use strict';
// CTO GO-LIVE FINAL BUSINESS ACCEPTANCE — GATE 6: Cross-flow negative /
// security tests.
//
// Deliberately adversarial: crafted payloads and cross-tenant attempts that
// a correct implementation must reject. Rules exercised (DERIVED from
// current code, not invented):
//  - OrderAgent.create()/addItem() only trust a CLIENT-supplied
//    price_book_id when the item is explicit manual_price (isExplicitManual
//    — OrderAgent.js:680) — every non-manual item always gets its
//    price_book_id server-overwritten by PriceBookService.getEffectivePrice().
//    This makes "manual_price:true + a forged price_book_id" the one real,
//    reachable place assertItemsCategoryPerFlow()'s price_book_id branch
//    (OrderAgent.js:191-273) actually has to defend a hostile input, rather
//    than an always-trustworthy server-computed value — tested here
//    directly, not re-deriving Gate 1's own P0-002 coverage of the
//    NO-price_book_id branch.
//  - middleware/scope.js assertCustomerScope(): a CUSTOMER-role user may act
//    only within their own customer subtree; ADMIN/STAFF bypass entirely.
//  - PaymentAgent.create(): idempotency_key is mandatory (GO-LIVE BLOCKER 1);
//    amount must be >0.
//  - OrderAgent.create(): every item's quantity must be >0 (F3 guard).
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
async function expectError(name, matcher, fn) {
  try { await fn(); check(name, false, 'expected to throw but succeeded'); }
  catch (e) {
    const ok = typeof matcher === 'function' ? matcher(e) : (e && e.code === matcher);
    check(name, ok, { got_code: e && e.code, got_status: e && (e.status || e.statusCode), message: e && e.message });
  }
}

async function main() {
  if (!TARGET) { console.error('CR4_FRESH_DB is not set — refusing to run.'); process.exit(2); }
  if (TARGET === APP_DB) { console.error(`CR4_FRESH_DB (${TARGET}) is the application database — refusing.`); process.exit(2); }
  process.env.DB_NAME = TARGET;
  const pool = require('../src/config/db');
  const [[who]] = await pool.query('SELECT DATABASE() db');
  if (who.db !== TARGET) { console.error(`pool connected to ${who.db}, not ${TARGET} — refusing.`); process.exit(2); }
  console.log(`=== GATE 6: Cross-flow negative / security tests (${TARGET}) ===\n`);

  const ProductAgent = require('../src/agents/ProductAgent');
  const CustomerAgent = require('../src/agents/CustomerAgent');
  const OrderAgent = require('../src/agents/OrderAgent');
  const PaymentAgent = require('../src/agents/PaymentAgent');
  const PriceMatrixAgent = require('../src/agents/PriceMatrixAgent');

  const admin = { id: null, role: 'ADMIN' };
  const today = new Date().toISOString().slice(0, 10);
  const tag = `G6-${Date.now()}`;

  const [cats] = await pool.query(`SELECT id,name FROM product_categories WHERE del_flg=0 AND name NOT LIKE '%Bò xô%' ORDER BY id LIMIT 3`);
  const [catA, catB, catC] = cats;

  async function makeCustomer(name, defaultFlow = 'INVENTORY_SALE') {
    const res = await CustomerAgent.create({ name: `${tag} ${name}`, phone: `09${String(Date.now()).slice(-6)}${String(Math.floor(Math.random()*90)+10)}`, partner_type: 2, default_sales_flow: defaultFlow, price_mode: 'PRIVATE_PRICE', billing_calendar_type: 'SOLAR' }, admin);
    const [[row]] = await pool.query(`SELECT id FROM customers WHERE customer_code=?`, [res.customer_code]);
    return row.id;
  }
  async function makeProduct(name, categoryId, defaultPrice, flow = 'INVENTORY_SALE') {
    const full = `${tag} ${name}`;
    await ProductAgent.addProduct({ name: full, unit: 'kg', category_id: categoryId, inventory_mode: 'TRACK_STOCK', sales_flow: flow, stock_quantity: 100, allow_negative_stock: 0, default_sale_price: defaultPrice });
    const [[p]] = await pool.query(`SELECT * FROM products WHERE name=? LIMIT 1`, [full]);
    return p;
  }
  async function bookIdFor(customerId, categoryId, effectiveFrom) {
    const [[cpc]] = await pool.query(`SELECT id FROM customer_price_categories WHERE customer_id=? AND category_id=? LIMIT 1`, [customerId, categoryId]);
    const [[book]] = await pool.query(
      `SELECT id FROM customer_price_books WHERE customer_price_category_id=? AND effective_from=? AND effective_calendar_type='SOLAR' AND COALESCE(status,'ACTIVE')<>'DELETED' LIMIT 1`,
      [cpc.id, effectiveFrom]
    );
    return book.id;
  }

  // ══════════════════ A. Forged price_book_id — belongs to a DIFFERENT customer ══════════════════
  {
    const custVictim = await makeCustomer('Victim Customer');
    const custAttacker = await makeCustomer('Attacker Customer');
    const product = await makeProduct('Shared Item A', catA.id, 20000);
    await PriceMatrixAgent.createCustomerPriceCategory(custVictim, catA.id, { sales_flow: 'INVENTORY_SALE' });
    await PriceMatrixAgent.saveMatrix(custVictim, [{ product_id: product.id, private_price: 999000, in_catalog: true }], null, { effective_from: today, effective_calendar_type: 'SOLAR' }, catA.id);
    const victimBookId = await bookIdFor(custVictim, catA.id, today);

    await PriceMatrixAgent.createCustomerPriceCategory(custAttacker, catA.id, { sales_flow: 'INVENTORY_SALE' });

    await expectError('A. A bill for one customer cannot use ANOTHER customer\'s real price_book_id (forged via manual_price to bypass server resolution)',
      'PRICE_BOOK_WRONG_CUSTOMER',
      () => OrderAgent.create({
        customer_id: custAttacker, order_date: today,
        items: [{ product_id: product.id, product_name: product.name, unit: 'kg', quantity: 1, sale_price: 999000, manual_price: true, price_type: 'PRICE_BOOK', price_book_id: victimBookId }],
      }, admin));
  }

  // ══════════════════ B. Forged price_book_id — real book, but product not in it ══════════════════
  {
    const custId = await makeCustomer('Product Mismatch Customer');
    const productInBook = await makeProduct('In Book Item', catA.id, 15000);
    const productNotInBook = await makeProduct('Not In Book Item', catA.id, 15000);
    await PriceMatrixAgent.createCustomerPriceCategory(custId, catA.id, { sales_flow: 'INVENTORY_SALE' });
    await PriceMatrixAgent.saveMatrix(custId, [{ product_id: productInBook.id, private_price: 40000, in_catalog: true }], null, { effective_from: today, effective_calendar_type: 'SOLAR' }, catA.id);
    const bookId = await bookIdFor(custId, catA.id, today);

    await expectError('B. A real, own price_book_id cannot be reused for a product that is NOT actually in that book',
      'PRODUCT_NOT_IN_PRICE_BOOK',
      () => OrderAgent.create({
        customer_id: custId, order_date: today,
        items: [{ product_id: productNotInBook.id, product_name: productNotInBook.name, unit: 'kg', quantity: 1, sale_price: 40000, manual_price: true, price_type: 'PRICE_BOOK', price_book_id: bookId }],
      }, admin));
  }

  // ══════════════════ C. Two INVENTORY_SALE price categories smuggled into ONE bill ══════════════════
  {
    const custId = await makeCustomer('Multi Category Customer');
    const productB = await makeProduct('Cat B Item', catB.id, 20000);
    const productC = await makeProduct('Cat C Item', catC.id, 20000);
    await PriceMatrixAgent.createCustomerPriceCategory(custId, catB.id, { sales_flow: 'INVENTORY_SALE' });
    await PriceMatrixAgent.createCustomerPriceCategory(custId, catC.id, { sales_flow: 'INVENTORY_SALE' });
    await PriceMatrixAgent.saveMatrix(custId, [{ product_id: productB.id, private_price: 30000, in_catalog: true }], null, { effective_from: today, effective_calendar_type: 'SOLAR' }, catB.id);
    await PriceMatrixAgent.saveMatrix(custId, [{ product_id: productC.id, private_price: 30000, in_catalog: true }], null, { effective_from: today, effective_calendar_type: 'SOLAR' }, catC.id);
    const bookBId = await bookIdFor(custId, catB.id, today);
    const bookCId = await bookIdFor(custId, catC.id, today);

    // Each individually is a perfectly legitimate, correctly-owned book for the
    // SAME flow (INVENTORY_SALE) — only combining both in one bill is rejected
    // ("a bill may only draw from ONE price category per flow").
    await expectError('C. One bill cannot mix TWO different INVENTORY_SALE price categories, even with two individually-valid, correctly-owned price_book_ids',
      'MULTIPLE_PRICE_CATEGORIES_PER_FLOW',
      () => OrderAgent.create({
        customer_id: custId, order_date: today,
        items: [
          { product_id: productB.id, product_name: productB.name, unit: 'kg', quantity: 1, sale_price: 30000, manual_price: true, price_type: 'PRICE_BOOK', price_book_id: bookBId },
          { product_id: productC.id, product_name: productC.name, unit: 'kg', quantity: 1, sale_price: 30000, manual_price: true, price_type: 'PRICE_BOOK', price_book_id: bookCId },
        ],
      }, admin));
  }

  // ══════════════════ D. CUSTOMER-role cross-tenant scope violation ══════════════════
  {
    const custA = await makeCustomer('Scope Customer A');
    const custB = await makeCustomer('Scope Customer B');
    const customerRoleUserA = { id: null, role: 'CUSTOMER', customer_id: custA };

    await expectError('D. A CUSTOMER-role user cannot create an order for a DIFFERENT customer_id',
      e => (e && (e.status === 403 || e.statusCode === 403)),
      () => OrderAgent.create({ customer_id: custB, order_date: today, items: [{ product_id: 1, product_name: 'x', unit: 'kg', quantity: 1, sale_price: 1, manual_price: true }] }, customerRoleUserA));

    await expectError('D. A CUSTOMER-role user cannot read ANOTHER customer\'s payment summary',
      e => (e && (e.status === 403 || e.statusCode === 403)),
      () => PaymentAgent.summary(custB, customerRoleUserA));

    await expectError('D. A CUSTOMER-role user cannot post a payment against ANOTHER customer_id',
      e => (e && (e.status === 403 || e.statusCode === 403)),
      () => PaymentAgent.create({ customer_id: custB, cash_amount: 1000, bank_amount: 0, payment_date: today, idempotency_key: `${tag}-D-attack` }, customerRoleUserA));

    // Positive control: the SAME user acting on their OWN customer_id must not be blocked by scope.
    const [[custARow]] = await pool.query(`SELECT id,name FROM customers WHERE id=?`, [custA]);
    check('D. Positive control: the same CUSTOMER-role user CAN read their OWN payment summary (scope is not over-broad)', !!custARow, custARow);
    const ownSummary = await PaymentAgent.summary(custA, customerRoleUserA);
    check('D. Positive control result: own-customer summary call succeeds', !!ownSummary && !!ownSummary.customer, ownSummary && ownSummary.customer);
  }

  // ══════════════════ E. Zero / negative quantity rejected ══════════════════
  {
    const custId = await makeCustomer('Negative Qty Customer');
    const product = await makeProduct('Neg Qty Item', catA.id, 10000);
    await expectError('E. Zero quantity is rejected before any price resolution or inventory write',
      e => /lớn hơn 0/.test(String(e && e.message)),
      () => OrderAgent.create({ customer_id: custId, order_date: today, items: [{ product_id: product.id, product_name: product.name, unit: 'kg', quantity: 0, sale_price: 10000, manual_price: true }] }, admin));
    await expectError('E. Negative quantity is rejected',
      e => /lớn hơn 0/.test(String(e && e.message)),
      () => OrderAgent.create({ customer_id: custId, order_date: today, items: [{ product_id: product.id, product_name: product.name, unit: 'kg', quantity: -5, sale_price: 10000, manual_price: true }] }, admin));
    const [[stockRow]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [product.id]);
    check('E. Rejected negative/zero-quantity attempts left stock untouched (100)', Number(stockRow.stock_quantity) === 100, stockRow);
  }

  // ══════════════════ F. Zero / negative payment amount rejected ══════════════════
  {
    const custId = await makeCustomer('Negative Amount Customer');
    await expectError('F. A payment with zero cash/bank/amount is rejected',
      e => /không hợp lệ|Thiếu/.test(String(e && e.message)),
      () => PaymentAgent.create({ customer_id: custId, cash_amount: 0, bank_amount: 0, payment_date: today, idempotency_key: `${tag}-F-zero` }, admin));
    await expectError('F. A payment with a negative cash_amount is rejected (does not net to a false-positive "amount>0")',
      e => /không hợp lệ|Thiếu/.test(String(e && e.message)),
      () => PaymentAgent.create({ customer_id: custId, cash_amount: -50000, bank_amount: 0, payment_date: today, idempotency_key: `${tag}-F-neg` }, admin));
  }

  // ══════════════════ G. Missing idempotency_key rejected (GO-LIVE BLOCKER 1, re-confirmed under Gate 6) ══════════════════
  {
    const custId = await makeCustomer('No Idempotency Customer');
    await expectError('G. A payment with NO idempotency_key is rejected before any read/write',
      'IDEMPOTENCY_KEY_REQUIRED',
      () => PaymentAgent.create({ customer_id: custId, cash_amount: 10000, bank_amount: 0, payment_date: today }, admin));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
