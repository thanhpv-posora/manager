'use strict';
// CTO GO-LIVE FINAL BUSINESS ACCEPTANCE — GATE 4: Customer Price Book,
// effective-by-date.
//
// Scope per CTO instruction: test the EXISTING pricing rules, do not
// redesign them. Rules exercised (DERIVED from current code, not invented):
//  - PriceBookService.getEffectivePrice()/findActiveBookItemsForPartner():
//    picks the single most-recent ACTIVE book (by effective_from, ties
//    broken by highest id) whose effective_from <= the bill's date — the
//    "bill/export date" is orders.order_date (billSolarDate, resolved by
//    resolveAuthoritativeCalendar()+resolveBillSolarDate() in
//    OrderAgent.create() BEFORE any price is resolved).
//  - order_items.sale_price/price_type/price_book_id are written ONCE at
//    order-create time and never re-derived on read — a later price-book
//    version can never retroactively change an already-created bill
//    (structural immutability, not a special-cased guard).
//  - Resolution chain (PriceBookService.getEffectivePrice): PRICE_BOOK (via
//    the customer's CustomerPriceCategory for the item's own product
//    category) -> legacy PRIVATE_PRICE (customer_product_prices) ->
//    COMMON_PRICE (products.default_sale_price) -> missing-price error.
//  - OrderAgent.create() (OrderAgent.js:677-694): every item is
//    auto-re-resolved server-side by bill date UNLESS the client marks it
//    manual_price/force_manual_price===true (MANUAL_PRICE) — client-supplied
//    sale_price is never trusted otherwise.
//  - assertItemsCategoryPerFlow() (P0-002, already proven end-to-end in
//    Gate 1) enforces sales_flow isolation on EVERY price source, including
//    the no-price_book_id branches (COMMON_PRICE/MANUAL_PRICE/legacy
//    PRIVATE_PRICE) — re-checked here specifically through the price-book
//    resolution path, not re-deriving Gate 1's own coverage.
//  - copyBook() (PriceMatrixAgent.js:1209) is a real, shipped "copy a price
//    book's items into a new book" feature — tested below.
//  - No dedicated "import Excel price book" backend endpoint exists anywhere
//    in the repo (confirmed via repo-wide grep for excel/xlsx across
//    routes/agents/services — the only Excel-shaped features found are
//    "Excel-like grid editing" of a price matrix already in the browser, and
//    OrderImportAgent.js, an empty unimplemented stub) — reported as N/A
//    below, not invented/simulated.
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
async function expectError(name, code, fn) {
  try { await fn(); check(name, false, 'expected to throw but succeeded'); }
  catch (e) { check(name, e && e.code === code, { expected: code, got: e && e.code, message: e && e.message }); }
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
  console.log(`=== GATE 4: Customer Price Book — effective by date (${TARGET}) ===\n`);

  const ProductAgent = require('../src/agents/ProductAgent');
  const CustomerAgent = require('../src/agents/CustomerAgent');
  const OrderAgent = require('../src/agents/OrderAgent');
  const PriceMatrixAgent = require('../src/agents/PriceMatrixAgent');

  const admin = { id: null, role: 'ADMIN' };
  const today = new Date().toISOString().slice(0, 10);
  const tag = `G4-${Date.now()}`;

  const [[catA]] = await pool.query(`SELECT id FROM product_categories WHERE del_flg=0 ORDER BY id LIMIT 1`);
  const [[catB]] = await pool.query(`SELECT id FROM product_categories WHERE del_flg=0 AND id<>? ORDER BY id LIMIT 1`, [catA.id]);

  async function makeCustomer(name, defaultFlow = 'INVENTORY_SALE') {
    const res = await CustomerAgent.create({ name: `${tag} ${name}`, partner_type: 2, default_sales_flow: defaultFlow, price_mode: 'PRIVATE_PRICE', billing_calendar_type: 'SOLAR' }, admin);
    const [[row]] = await pool.query(`SELECT id FROM customers WHERE customer_code=?`, [res.customer_code]);
    return row.id;
  }
  async function makeProduct(name, categoryId, defaultPrice, flow = 'INVENTORY_SALE') {
    const full = `${tag} ${name}`;
    await ProductAgent.addProduct({ name: full, unit: 'kg', category_id: categoryId, inventory_mode: 'TRACK_STOCK', sales_flow: flow, stock_quantity: 500, allow_negative_stock: 0, default_sale_price: defaultPrice });
    const [[p]] = await pool.query(`SELECT * FROM products WHERE name=? LIMIT 1`, [full]);
    return p;
  }
  async function itemsOf(orderId) {
    const [rows] = await pool.query(`SELECT product_id,sale_price,price_type,price_book_id FROM order_items WHERE order_id=?`, [orderId]);
    return rows;
  }
  // saveMatrix()/copyBook() return only {message:...}/a copy summary, not the
  // book's own id in every shape this script needs — resolve it the same way
  // the rest of the app does: query customer_price_books directly by its
  // real identity (customer_price_category_id + effective_from), same table
  // PriceMatrixAgent itself is the sole authorized reader/writer of.
  async function bookIdFor(customerId, categoryId, effectiveFrom) {
    const [[cpc]] = await pool.query(`SELECT id FROM customer_price_categories WHERE customer_id=? AND category_id=? LIMIT 1`, [customerId, categoryId]);
    const [[book]] = await pool.query(
      `SELECT id FROM customer_price_books WHERE customer_price_category_id=? AND effective_from=? AND effective_calendar_type='SOLAR' AND COALESCE(status,'ACTIVE')<>'DELETED' LIMIT 1`,
      [cpc.id, effectiveFrom]
    );
    return book.id;
  }

  // ══════════════════ A. V1/V2/V3 effective-by-date + historical immutability ══════════════════
  {
    const custId = await makeCustomer('PriceBook Customer');
    const product = await makeProduct('Ba chỉ', catA.id, 40000);
    await PriceMatrixAgent.createCustomerPriceCategory(custId, catA.id, { sales_flow: 'INVENTORY_SALE' });

    const D1 = addDays(today, -20);
    const D2 = addDays(today, -10);
    const D3 = today;
    await PriceMatrixAgent.saveMatrix(custId, [{ product_id: product.id, private_price: 100000, in_catalog: true }], null, { effective_from: D1, effective_calendar_type: 'SOLAR' }, catA.id);
    const v1Id = await bookIdFor(custId, catA.id, D1);
    await PriceMatrixAgent.saveMatrix(custId, [{ product_id: product.id, private_price: 150000, in_catalog: true }], null, { effective_from: D2, effective_calendar_type: 'SOLAR' }, catA.id);
    const v2Id = await bookIdFor(custId, catA.id, D2);
    check('A. V1 and V2 got different price_book_id (real new versions, not an update-in-place)', v1Id !== v2Id, { v1Id, v2Id });

    // Bill dated D1 (exactly V1's effective date) -> V1 price.
    const billD1 = await OrderAgent.create({ customer_id: custId, order_date: D1, items: [{ product_id: product.id, product_name: product.name, unit: 'kg', quantity: 1 }] }, admin);
    const [lineD1] = await itemsOf(billD1.order_id);
    check('A. Bill dated D1 resolves V1 price (100,000)', Number(lineD1.sale_price) === 100000 && Number(lineD1.price_book_id) === v1Id, lineD1);

    // Bill dated between D1 and D2 (D2 not yet effective) -> still V1.
    const billMid = await OrderAgent.create({ customer_id: custId, order_date: addDays(D1, 3), items: [{ product_id: product.id, product_name: product.name, unit: 'kg', quantity: 1 }] }, admin);
    const [lineMid] = await itemsOf(billMid.order_id);
    check('A. Bill dated between D1 and D2 still resolves V1 price (100,000) — V2 not yet effective', Number(lineMid.sale_price) === 100000 && Number(lineMid.price_book_id) === v1Id, lineMid);

    // Bill dated exactly D2 -> V2 (effective_from <= bill date, on-or-after semantics).
    const billD2 = await OrderAgent.create({ customer_id: custId, order_date: D2, items: [{ product_id: product.id, product_name: product.name, unit: 'kg', quantity: 1 }] }, admin);
    const [lineD2] = await itemsOf(billD2.order_id);
    check('A. Bill dated ON D2 resolves V2 price (150,000) — on-or-after semantics confirmed', Number(lineD2.sale_price) === 150000 && Number(lineD2.price_book_id) === v2Id, lineD2);

    // Bill dated after D2 -> still V2 (no V3 yet).
    const billAfterD2 = await OrderAgent.create({ customer_id: custId, order_date: addDays(D2, 3), items: [{ product_id: product.id, product_name: product.name, unit: 'kg', quantity: 1 }] }, admin);
    const [lineAfterD2] = await itemsOf(billAfterD2.order_id);
    check('A. Bill dated after D2 resolves V2 price (150,000)', Number(lineAfterD2.sale_price) === 150000 && Number(lineAfterD2.price_book_id) === v2Id, lineAfterD2);

    // Now create V3 @ D3=today with a third price.
    await PriceMatrixAgent.saveMatrix(custId, [{ product_id: product.id, private_price: 200000, in_catalog: true }], null, { effective_from: D3, effective_calendar_type: 'SOLAR' }, catA.id);
    const v3Id = await bookIdFor(custId, catA.id, D3);
    check('A. V3 got its own price_book_id (yet another new version)', v3Id !== v1Id && v3Id !== v2Id, { v1Id, v2Id, v3Id });

    // IMMUTABILITY: re-read the already-created historical bills — must be byte-identical to before V3 existed.
    const [lineD1After] = await itemsOf(billD1.order_id);
    const [lineD2After] = await itemsOf(billD2.order_id);
    check('IMMUTABILITY: D1 bill still shows V1 price (100,000) after V3 was created', Number(lineD1After.sale_price) === 100000 && Number(lineD1After.price_book_id) === v1Id, lineD1After);
    check('IMMUTABILITY: D2 bill still shows V2 price (150,000) after V3 was created', Number(lineD2After.sale_price) === 150000 && Number(lineD2After.price_book_id) === v2Id, lineD2After);

    // A genuinely NEW bill dated today (>= D3) picks up V3.
    const billD3 = await OrderAgent.create({ customer_id: custId, order_date: D3, items: [{ product_id: product.id, product_name: product.name, unit: 'kg', quantity: 1 }] }, admin);
    const [lineD3] = await itemsOf(billD3.order_id);
    check('A. NEW bill dated D3 (today) resolves V3 price (200,000)', Number(lineD3.sale_price) === 200000 && Number(lineD3.price_book_id) === v3Id, lineD3);
  }

  // ══════════════════ B. Customer with NO price book at all -> COMMON_PRICE fallback ══════════════════
  {
    const custId = await makeCustomer('No Book Customer');
    const product = await makeProduct('Sườn non', catA.id, 85000);
    // No createCustomerPriceCategory call at all — customer has zero CustomerPriceCategory rows.
    const bill = await OrderAgent.create({ customer_id: custId, order_date: today, items: [{ product_id: product.id, product_name: product.name, unit: 'kg', quantity: 1 }] }, admin);
    const [line] = await itemsOf(bill.order_id);
    check('B. Customer with no price book at all falls back to COMMON_PRICE (products.default_sale_price = 85,000)', Number(line.sale_price) === 85000 && line.price_type === 'COMMON_PRICE' && !line.price_book_id, line);
  }

  // ══════════════════ C. One price category vs multiple price categories + default category ══════════════════
  {
    const custId = await makeCustomer('Category Matrix Customer');
    const productA = await makeProduct('Nạc vai', catA.id, 60000);
    const productB = await makeProduct('Xương ống', catB.id, 45000);

    const cpcA = await PriceMatrixAgent.createCustomerPriceCategory(custId, catA.id, { sales_flow: 'INVENTORY_SALE' });
    // Single-category state: auto-select must resolve deterministically, no ambiguity.
    const selOne = await PriceMatrixAgent.resolveCustomerCategorySelection(custId, 'INVENTORY_SALE');
    check('C. ONE price category: auto_selected_category_id resolves without requiring user selection', selOne.auto_selected_category_id === catA.id && selOne.requires_selection === false, selOne);
    check('C. ONE price category: it is the customer\'s default (first-ever category rule)', cpcA.is_default === true, cpcA);

    await PriceMatrixAgent.saveMatrix(custId, [{ product_id: productA.id, private_price: 130000, in_catalog: true }], null, { effective_from: today, effective_calendar_type: 'SOLAR' }, catA.id);

    // Add a SECOND price category for the same flow (different product category).
    const cpcB = await PriceMatrixAgent.createCustomerPriceCategory(custId, catB.id, { sales_flow: 'INVENTORY_SALE' });
    check('C. Second category is NOT auto-default (only the first-ever category gets is_default)', cpcB.is_default === false, cpcB);
    await PriceMatrixAgent.saveMatrix(custId, [{ product_id: productB.id, private_price: 90000, in_catalog: true }], null, { effective_from: today, effective_calendar_type: 'SOLAR' }, catB.id);

    // MULTIPLE categories, but one IS flagged is_default (catA from the first-ever rule) ->
    // selection still auto-resolves to the default, no ambiguity forced on the user.
    const selMulti = await PriceMatrixAgent.resolveCustomerCategorySelection(custId, 'INVENTORY_SALE');
    check('C. MULTIPLE price categories: auto-resolves to the flagged DEFAULT category (catA), not forced to pick', selMulti.auto_selected_category_id === catA.id && selMulti.requires_selection === false && selMulti.categories.length === 2, selMulti);

    // Re-pointing the default to catB must flip auto-selection.
    await PriceMatrixAgent.setDefaultCustomerPriceCategory(cpcB.id);
    const selAfterDefaultFlip = await PriceMatrixAgent.resolveCustomerCategorySelection(custId, 'INVENTORY_SALE');
    check('C. DEFAULT CATEGORY reassignment: auto-selection follows the new default (catB)', selAfterDefaultFlip.auto_selected_category_id === catB.id, selAfterDefaultFlip);

    // Each category's own book resolves independently — no cross-category price leakage.
    const billA = await OrderAgent.create({ customer_id: custId, order_date: today, items: [{ product_id: productA.id, product_name: productA.name, unit: 'kg', quantity: 1 }] }, admin);
    const billB = await OrderAgent.create({ customer_id: custId, order_date: today, items: [{ product_id: productB.id, product_name: productB.name, unit: 'kg', quantity: 1 }] }, admin);
    const [lineA] = await itemsOf(billA.order_id);
    const [lineB] = await itemsOf(billB.order_id);
    check('C. MULTIPLE categories: category A\'s own book resolves independently (130,000)', Number(lineA.sale_price) === 130000, lineA);
    check('C. MULTIPLE categories: category B\'s own book resolves independently (90,000), no leakage from A', Number(lineB.sale_price) === 90000, lineB);
  }

  // ══════════════════ D. MANUAL_PRICE where currently allowed (correct flow, explicit override) ══════════════════
  {
    const custId = await makeCustomer('Manual Price Customer');
    const product = await makeProduct('Thịt vụn', catA.id, 20000);
    await PriceMatrixAgent.createCustomerPriceCategory(custId, catA.id, { sales_flow: 'INVENTORY_SALE' });
    await PriceMatrixAgent.saveMatrix(custId, [{ product_id: product.id, private_price: 55000, in_catalog: true }], null, { effective_from: today, effective_calendar_type: 'SOLAR' }, catA.id);

    const billManual = await OrderAgent.create({
      customer_id: custId, order_date: today,
      items: [{ product_id: product.id, product_name: product.name, unit: 'kg', quantity: 1, sale_price: 1, manual_price: true }],
    }, admin);
    const [lineManual] = await itemsOf(billManual.order_id);
    check('D. MANUAL_PRICE explicitly overrides the active price book (1 đ, not the book\'s 55,000) — client value trusted only when manual_price=true', Number(lineManual.sale_price) === 1 && lineManual.price_type === 'MANUAL_PRICE', lineManual);

    // Without manual_price, the same client-supplied bogus sale_price is IGNORED — server re-resolves from the book.
    const billAuto = await OrderAgent.create({
      customer_id: custId, order_date: today,
      items: [{ product_id: product.id, product_name: product.name, unit: 'kg', quantity: 1, sale_price: 999999 }],
    }, admin);
    const [lineAuto] = await itemsOf(billAuto.order_id);
    check('D. Without manual_price, a client-supplied sale_price is ignored — server re-resolves from the book (55,000, not 999,999)', Number(lineAuto.sale_price) === 55000 && lineAuto.price_type === 'PRICE_BOOK', lineAuto);
  }

  // ══════════════════ E. Copy price book (currently supported: PriceMatrixAgent.copyBook) ══════════════════
  {
    const custSrc = await makeCustomer('Copy Source Customer');
    const custDst = await makeCustomer('Copy Dest Customer');
    const product = await makeProduct('Chân giò', catA.id, 30000);
    await PriceMatrixAgent.createCustomerPriceCategory(custSrc, catA.id, { sales_flow: 'INVENTORY_SALE' });
    await PriceMatrixAgent.createCustomerPriceCategory(custDst, catA.id, { sales_flow: 'INVENTORY_SALE' });
    await PriceMatrixAgent.saveMatrix(custSrc, [{ product_id: product.id, private_price: 75000, in_catalog: true }], null, { effective_from: today, effective_calendar_type: 'SOLAR' }, catA.id);
    const srcBookId = await bookIdFor(custSrc, catA.id, today);

    const copyResult = await PriceMatrixAgent.copyBook(srcBookId, { customer_id: custDst, effective_from: today, effective_calendar_type: 'SOLAR' }, null);
    check('E. copyBook() creates a new book for the destination customer', !!copyResult.price_book_id && copyResult.price_book_id !== srcBookId, copyResult);
    const billDst = await OrderAgent.create({ customer_id: custDst, order_date: today, items: [{ product_id: product.id, product_name: product.name, unit: 'kg', quantity: 1 }] }, admin);
    const [lineDst] = await itemsOf(billDst.order_id);
    check('E. Destination customer\'s bill resolves the COPIED price (75,000)', Number(lineDst.sale_price) === 75000 && Number(lineDst.price_book_id) === copyResult.price_book_id, lineDst);

    // Source customer's own book must be untouched by the copy.
    const billSrc = await OrderAgent.create({ customer_id: custSrc, order_date: today, items: [{ product_id: product.id, product_name: product.name, unit: 'kg', quantity: 1 }] }, admin);
    const [lineSrc] = await itemsOf(billSrc.order_id);
    check('E. Source customer\'s own book still resolves its original price (75,000) unaffected by the copy', Number(lineSrc.sale_price) === 75000 && Number(lineSrc.price_book_id) === srcBookId, lineSrc);
  }

  // ══════════════════ F. Import Excel pricing path — NOT currently supported (reported, not invented) ══════════════════
  console.log('  [N/A] F. "Import Excel pricing path" — no such backend endpoint exists in this codebase.');
  console.log('        Confirmed via repo-wide grep (routes/agents/services) for excel/xlsx: the only');
  console.log('        Excel-shaped features are (1) an "Excel-like grid" in-browser price-matrix editor');
  console.log('        (PriceMatrixAgent — a UI metaphor, not a file import) and (2) OrderImportAgent.js,');
  console.log('        an empty, unimplemented stub with no methods. Not tested because it does not exist —');
  console.log('        fabricating a pass/fail here would misrepresent an absent feature as a working one.');

  // ══════════════════ CRITICAL: no price fallback (incl. missing price_book_id) bypasses sales_flow isolation ══════════════════
  // Re-checked specifically through the PRICE-BOOK resolution path (server
  // auto-resolves price_book_id from getEffectivePrice(), the client never
  // supplies it) — complements Gate 1's own coverage of the MANUAL_PRICE/
  // COMMON_PRICE branches without re-deriving it.
  {
    const custCarcass = await makeCustomer('Gate4 Carcass Customer', 'CARCASS_POS');
    const [[carcassCat]] = await pool.query(`SELECT id FROM product_categories WHERE del_flg=0 AND name LIKE '%Bò xô%' LIMIT 1`);
    const inventoryProduct = await makeProduct('Gate4 Kho Item', catB.id, 40000, 'INVENTORY_SALE');
    // custCarcass has NO price category / price book for catB at all — server
    // auto-resolves via getEffectivePrice(), finds nothing, falls through to
    // COMMON_PRICE (products.default_sale_price=40000) with price_book_id=NULL.
    // The sales_flow guard must still reject it — a missing price_book_id must
    // never become a silent isolation bypass.
    await expectError('CRITICAL: CARCASS_POS customer buying an INVENTORY_SALE item via auto-resolved COMMON_PRICE (no price_book_id at all) is still rejected',
      'PRICE_CATEGORY_NOT_INVENTORY_SALE',
      () => OrderAgent.create({ customer_id: custCarcass, order_date: today, items: [{ product_id: inventoryProduct.id, product_name: inventoryProduct.name, unit: 'kg', quantity: 1 }] }, admin));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
