'use strict';
// S1F — Sales Flow Context Propagation verification.
//
// Covers:
//  1. Hồng Hiền in CreateOrder context (sales_flow=CARCASS_POS): selects only
//     CARCASS_POS or Legacy NULL, never INVENTORY_SALE.
//  2. Hồng Hiền in InventorySales context (sales_flow=INVENTORY_SALE): NULL
//     rejected (no auto-select), CARCASS_POS category rejected.
//  3. Customer with NULL default + INVENTORY_SALE category: CreateOrder uses
//     Legacy NULL, InventorySales uses INVENTORY_SALE.
//  4. Customer with both CARCASS_POS and INVENTORY_SALE categories: each page
//     selects its own.
//  5. S1E navigation-state handoff (static source proof — sessionStorage keys
//     match between producer and consumer).
//  6. Customer calendar (billing_calendar_type) is independent of category
//     sales_flow selection — LUNAR/SOLAR customers can default to either branch.
//  7. Hồng Hiền's existing effective-date pricing (S1D) is unaffected.
//  8. Frontend build — run separately (`npx vite build`), not from Node.
//
// Also verifies customerCatalogForOrder()'s new salesFlow guard (Task 3,
// defense-in-depth at the catalog-loading endpoint, not just category-selection).
//
// Self-cleaning: throwaway customers/products/categories/books, removed in
// `finally`. Hồng Hiền's real data (customer_id=4) is only ever read, never
// written.

const fs = require('fs');
const path = require('path');
const pool = require('../src/config/db');
const ProductAgent = require('../src/agents/ProductAgent');
const PriceMatrixAgent = require('../src/agents/PriceMatrixAgent');
const PriceBookService = require('../src/services/PriceBookService');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}

const cleanup = { productIds: [], customerIds: [], priceCategoryIds: [], bookIds: [] };

async function makeProduct(mode, categoryId) {
  const tag = `S1F ${mode} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const salesFlow = mode === 'TRACK_STOCK' ? 'INVENTORY_SALE' : 'CARCASS_POS';
  await ProductAgent.addProduct({ name: tag, unit: 'kg', category_id: categoryId, inventory_mode: mode, sales_flow: salesFlow, stock_quantity: mode === 'TRACK_STOCK' ? 20 : 0 });
  const [[created]] = await pool.query(`SELECT * FROM products WHERE name=? LIMIT 1`, [tag]);
  cleanup.productIds.push(created.id);
  return created;
}
async function makeCustomer(label, calendarType = 'SOLAR') {
  const [ins] = await pool.query(
    `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type,partner_type)
     VALUES(?,?,?,?,?,?,?,?,2)`,
    [`S1FTEST-${label}-${Date.now()}`, `S1F Test ${label}`, '0', 'test', 'PRIVATE_PRICE', 0, 0, calendarType]
  );
  cleanup.customerIds.push(ins.insertId);
  return ins.insertId;
}
async function makeCategory(customerId, productCategoryId, salesFlow, product, price, calendarType = 'SOLAR') {
  const cpc = await PriceMatrixAgent.createCustomerPriceCategory(customerId, productCategoryId, salesFlow ? { sales_flow: salesFlow } : {});
  cleanup.priceCategoryIds.push(cpc.id);
  const meta = calendarType === 'LUNAR'
    ? { effective_lunar_date_text: '01/01/2025', effective_calendar_type: 'LUNAR' }
    : { effective_from: '2025-01-01', effective_calendar_type: 'SOLAR' };
  await PriceMatrixAgent.saveMatrix(customerId, [{ product_id: product.id, private_price: price, in_catalog: true }], null, meta, productCategoryId);
  const [books] = await pool.query(`SELECT id FROM customer_price_books WHERE customer_price_category_id=?`, [cpc.id]);
  books.forEach(b => cleanup.bookIds.push(b.id));
  return cpc;
}

async function main() {
  try {
    const [prodCats] = await pool.query(`SELECT id FROM product_categories WHERE del_flg=0 ORDER BY id LIMIT 2`);
    const [catA, catB] = prodCats.map(x => x.id);

    // ══════════════════ 1) Hồng Hiền + CreateOrder context (CARCASS_POS) ══════════════════
    {
      const r = await PriceMatrixAgent.resolveCustomerCategorySelection(4, 'CARCASS_POS');
      check('1. Hồng Hiền + CARCASS_POS: does NOT need_initialization (Legacy NULL fallback applies)', r.needs_initialization === false, r);
      check('1. Hồng Hiền + CARCASS_POS: auto-selects a category (Legacy NULL)', !!r.auto_selected_category_id, r.auto_selected_category_id);
      const selectedRow = r.categories.find(c => Number(c.category_id) === Number(r.auto_selected_category_id));
      check('1. Hồng Hiền + CARCASS_POS: selected category has sales_flow NULL or CARCASS_POS (never INVENTORY_SALE)',
        selectedRow && selectedRow.sales_flow !== 'INVENTORY_SALE', selectedRow);
      check('1. Hồng Hiền + CARCASS_POS: no returned category is INVENTORY_SALE', r.categories.every(c => c.sales_flow !== 'INVENTORY_SALE'), r.categories);
    }

    // ══════════════════ 2) Hồng Hiền + InventorySales context (INVENTORY_SALE) ══════════════════
    {
      const r = await PriceMatrixAgent.resolveCustomerCategorySelection(4, 'INVENTORY_SALE');
      check('2. Hồng Hiền + INVENTORY_SALE: NULL category rejected (needs_initialization=true, no auto-select)', r.needs_initialization === true && !r.auto_selected_category_id, r);
      check('2. Hồng Hiền + INVENTORY_SALE: zero categories returned (both her categories are NULL)', r.categories.length === 0, r.categories);
    }
    // CARCASS_POS-category rejection for INVENTORY_SALE requests — separate throwaway customer
    {
      const customerId = await makeCustomer('C2B');
      const p = await makeProduct('NON_STOCK', catA);
      await makeCategory(customerId, catA, 'CARCASS_POS', p, 70000);
      const r = await PriceMatrixAgent.resolveCustomerCategorySelection(customerId, 'INVENTORY_SALE');
      check('2b. Customer with only a CARCASS_POS category + INVENTORY_SALE request: rejected (not auto-selected)', r.needs_initialization === true && !r.auto_selected_category_id, r);
    }

    // ══════════════════ 3) NULL default + INVENTORY_SALE category ══════════════════
    {
      const customerId = await makeCustomer('C3');
      const pNull = await makeProduct('NON_STOCK', catA);
      const pInv = await makeProduct('TRACK_STOCK', catB);
      const cpcNull = await makeCategory(customerId, catA, null, pNull, 50000); // default, unclassified
      await makeCategory(customerId, catB, 'INVENTORY_SALE', pInv, 60000);

      const rCarcass = await PriceMatrixAgent.resolveCustomerCategorySelection(customerId, 'CARCASS_POS');
      check('3. CreateOrder (CARCASS_POS) uses the Legacy NULL category', Number(rCarcass.auto_selected_category_id) === Number(catA), rCarcass);

      const rInventory = await PriceMatrixAgent.resolveCustomerCategorySelection(customerId, 'INVENTORY_SALE');
      check('3. InventorySales (INVENTORY_SALE) uses the INVENTORY_SALE category', Number(rInventory.auto_selected_category_id) === Number(catB), rInventory);
    }

    // ══════════════════ 4) Both CARCASS_POS and INVENTORY_SALE categories ══════════════════
    {
      const customerId = await makeCustomer('C4');
      const pCarcass = await makeProduct('NON_STOCK', catA);
      const pInv = await makeProduct('TRACK_STOCK', catB);
      await makeCategory(customerId, catA, 'CARCASS_POS', pCarcass, 70000);
      await makeCategory(customerId, catB, 'INVENTORY_SALE', pInv, 60000);

      const rCarcass = await PriceMatrixAgent.resolveCustomerCategorySelection(customerId, 'CARCASS_POS');
      check('4. CreateOrder selects its own CARCASS_POS category', Number(rCarcass.auto_selected_category_id) === Number(catA), rCarcass);
      const rInventory = await PriceMatrixAgent.resolveCustomerCategorySelection(customerId, 'INVENTORY_SALE');
      check('4. InventorySales selects its own INVENTORY_SALE category', Number(rInventory.auto_selected_category_id) === Number(catB), rInventory);

      // customerCatalogForOrder's own salesFlow guard (defense-in-depth)
      const catalogOk = await PriceMatrixAgent.customerCatalogForOrder(customerId, catA, 'NON_STOCK', '2025-06-01', 'CARCASS_POS');
      check('4. customerCatalogForOrder: CARCASS_POS request against CARCASS_POS category succeeds', Array.isArray(catalogOk.products));
      let threwWrongFlow = null;
      try { await PriceMatrixAgent.customerCatalogForOrder(customerId, catA, 'NON_STOCK', '2025-06-01', 'INVENTORY_SALE'); }
      catch (e) { threwWrongFlow = e; }
      check('4. customerCatalogForOrder: INVENTORY_SALE request against a CARCASS_POS category is rejected', threwWrongFlow && threwWrongFlow.code === 'CATALOG_CATEGORY_NOT_INVENTORY_SALE', threwWrongFlow && threwWrongFlow.message);
      let threwOtherWay = null;
      try { await PriceMatrixAgent.customerCatalogForOrder(customerId, catB, 'TRACK_STOCK', '2025-06-01', 'CARCASS_POS'); }
      catch (e) { threwOtherWay = e; }
      check('4. customerCatalogForOrder: CARCASS_POS request against an INVENTORY_SALE category is rejected', threwOtherWay && threwOtherWay.code === 'CATALOG_CATEGORY_NOT_CARCASS_POS', threwOtherWay && threwOtherWay.message);
    }

    // ══════════════════ 5) S1E navigation-state handoff (static proof) ══════════════════
    {
      const createOrderSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', 'CreateOrder.jsx'), 'utf8');
      const inventorySalesSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', 'InventorySales.jsx'), 'utf8');
      check('5. CreateOrder.jsx writes the handoff key before navigating', /sessionStorage\.setItem\('s1e_pending_customer_context'/.test(createOrderSrc));
      check('5. CreateOrder.jsx handoff includes customer_id', /customer_id:id/.test(createOrderSrc));
      check('5. InventorySales.jsx reads the SAME handoff key', /sessionStorage\.getItem\('s1e_pending_customer_context'\)/.test(inventorySalesSrc));
      check('5. InventorySales.jsx clears the key after reading (one-shot)', /sessionStorage\.removeItem\('s1e_pending_customer_context'\)/.test(inventorySalesSrc));
      check('5. InventorySales.jsx auto-selects the customer from the handoff', /selectCustomer\(String\(ctx\.customer_id\)\)/.test(inventorySalesSrc));
    }

    // ══════════════════ 6) Calendar independence ══════════════════
    {
      const customerLunar = await makeCustomer('C6Lunar', 'LUNAR');
      const pLunarInv = await makeProduct('TRACK_STOCK', catA);
      await makeCategory(customerLunar, catA, 'INVENTORY_SALE', pLunarInv, 40000, 'LUNAR');
      const rLunarInv = await PriceMatrixAgent.resolveCustomerCategorySelection(customerLunar, 'INVENTORY_SALE');
      check('6. LUNAR customer can default to INVENTORY_SALE (calendar does not block it)', !!rLunarInv.auto_selected_category_id, rLunarInv);

      const customerSolar = await makeCustomer('C6Solar', 'SOLAR');
      const pSolarCarcass = await makeProduct('NON_STOCK', catA);
      await makeCategory(customerSolar, catA, 'CARCASS_POS', pSolarCarcass, 40000);
      const rSolarCarcass = await PriceMatrixAgent.resolveCustomerCategorySelection(customerSolar, 'CARCASS_POS');
      check('6. SOLAR customer can default to CARCASS_POS', !!rSolarCarcass.auto_selected_category_id, rSolarCarcass);

      const priceMatrixSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'agents', 'PriceMatrixAgent.js'), 'utf8');
      const resolverSection = priceMatrixSrc.slice(priceMatrixSrc.indexOf('async listCustomerPriceCategories'), priceMatrixSrc.indexOf('createCustomerPriceCategory('));
      check('6. Category sales_flow resolution never references billing_calendar_type', !/billing_calendar_type/.test(resolverSection));
    }

    // ══════════════════ 7) Hồng Hiền effective-date pricing unaffected ══════════════════
    {
      const [[book126]] = await pool.query(`SELECT id FROM customer_price_books WHERE customer_id=4 AND effective_lunar_date_text='01/01/2026'`);
      const [[book7]] = await pool.query(`SELECT id FROM customer_price_books WHERE customer_id=4 AND effective_lunar_date_text='12/02/2026'`);
      const [[productRow]] = await pool.query(
        `SELECT product_id FROM customer_price_book_items WHERE price_book_id IN (?, ?) GROUP BY product_id HAVING COUNT(DISTINCT price_book_id)=2 LIMIT 1`,
        [book126.id, book7.id]
      );
      const before = await PriceBookService.getEffectivePrice(4, productRow.product_id, '2025-01-01', pool, 'LUNAR', '15/01/2026');
      const after = await PriceBookService.getEffectivePrice(4, productRow.product_id, '2025-01-01', pool, 'LUNAR', '01/03/2026');
      check('7. Hồng Hiền: bill before 12/02 ÂL still resolves book #126', Number(before.price_book_id) === Number(book126.id), before);
      check('7. Hồng Hiền: bill after 12/02 ÂL still resolves book #7', Number(after.price_book_id) === Number(book7.id), after);
    }

  } finally {
    for (const id of cleanup.productIds) {
      await pool.query(`DELETE FROM stock_transactions WHERE product_id=?`, [id]).catch(() => {});
      await pool.query(`DELETE FROM customer_product_prices WHERE product_id=?`, [id]).catch(() => {});
      await pool.query(`DELETE FROM customer_price_book_items WHERE product_id=?`, [id]).catch(() => {});
      await pool.query(`DELETE FROM products WHERE id=?`, [id]).catch(() => {});
    }
    for (const bookId of cleanup.bookIds) {
      await pool.query(`DELETE FROM customer_price_book_items WHERE price_book_id=?`, [bookId]).catch(() => {});
      await pool.query(`DELETE FROM customer_price_books WHERE id=?`, [bookId]).catch(() => {});
    }
    for (const cpcId of cleanup.priceCategoryIds) {
      await pool.query(`DELETE FROM customer_price_categories WHERE id=?`, [cpcId]).catch(() => {});
    }
    for (const customerId of cleanup.customerIds) {
      await pool.query(`DELETE FROM price_change_logs WHERE customer_id=?`, [customerId]).catch(() => {});
      await pool.query(`DELETE FROM customer_product_catalogs WHERE customer_id=?`, [customerId]).catch(() => {});
      await pool.query(`DELETE FROM customers WHERE id=?`, [customerId]).catch(() => {});
    }
    console.log('Cleanup done. (Hồng Hiền real data — customer_id=4 — was only ever read, never written.)');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
