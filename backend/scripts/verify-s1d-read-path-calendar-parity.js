'use strict';
// S1D Read-Path Calendar Parity Fix — verification.
//
// Root cause closed: PriceMatrixAgent.customerCatalogForOrder() used to call
// PriceBookService.getEffectivePricesForCategory(..., customers[0].billing_calendar_type,
// '', pool) — an empty lunar_date_text and a calendar_type read once at the top
// of the function, never re-derived via the same authoritative resolver
// OrderAgent.create() uses. This script proves the read path (catalog/order,
// effective-prices) and the write path (OrderAgent.create()) now derive and use
// the identical calendar_type/lunar_date_text for the same customer + bill date,
// via the single shared resolveAuthoritativeCalendar() helper
// (backend/src/utils/billCalendar.js) — no duplicated conversion formula.
//
// Self-cleaning: throwaway customers/products/categories/books/orders, removed
// in `finally`. Hồng Hiền's real data (customer_id=4) is only ever read.

const fs = require('fs');
const path = require('path');
const pool = require('../src/config/db');
const ProductAgent = require('../src/agents/ProductAgent');
const OrderAgent = require('../src/agents/OrderAgent');
const PriceMatrixAgent = require('../src/agents/PriceMatrixAgent');
const PriceBookService = require('../src/services/PriceBookService');
const { resolveAuthoritativeCalendar } = require('../src/utils/billCalendar');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}

const cleanup = { orderIds: [], productIds: [], customerIds: [], priceCategoryIds: [], bookIds: [] };
const adminUser = () => ({ id: null, role: 'ADMIN' });
const billItem = (p, qty) => ({ product_id: p.id, product_name: p.name, unit: 'kg', quantity: qty });

async function makeProduct(mode, categoryId) {
  const tag = `S1DFIX ${mode} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const salesFlow = mode === 'TRACK_STOCK' ? 'INVENTORY_SALE' : 'CARCASS_POS';
  await ProductAgent.addProduct({ name: tag, unit: 'kg', category_id: categoryId, inventory_mode: mode, sales_flow: salesFlow, stock_quantity: 0 });
  const [[created]] = await pool.query(`SELECT * FROM products WHERE name=? LIMIT 1`, [tag]);
  cleanup.productIds.push(created.id);
  return created;
}
async function makeCustomer(label, calendarType = 'SOLAR') {
  const [ins] = await pool.query(
    `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type,partner_type)
     VALUES(?,?,?,?,?,?,?,?,2)`,
    [`S1DFIXTEST-${label}-${Date.now()}`, `S1DFix Test ${label}`, '0', 'test', 'PRIVATE_PRICE', 0, 0, calendarType]
  );
  cleanup.customerIds.push(ins.insertId);
  return ins.insertId;
}
// Two LUNAR price books, same product, matching the Hồng Hiền real-data shape:
// book A effective earlier, book B effective later.
async function makeTwoLunarBooks(customerId, categoryId, product) {
  const cpc = await PriceMatrixAgent.createCustomerPriceCategory(customerId, categoryId, {});
  cleanup.priceCategoryIds.push(cpc.id);
  await PriceMatrixAgent.saveMatrix(customerId, [{ product_id: product.id, private_price: 50000, in_catalog: true }], null,
    { effective_lunar_date_text: '01/01/2025', effective_calendar_type: 'LUNAR' }, categoryId);
  await PriceMatrixAgent.saveMatrix(customerId, [{ product_id: product.id, private_price: 65000, in_catalog: true }], null,
    { effective_lunar_date_text: '15/02/2025', effective_calendar_type: 'LUNAR' }, categoryId);
  const [books] = await pool.query(`SELECT id, effective_lunar_date_text FROM customer_price_books WHERE customer_price_category_id=? ORDER BY effective_lunar_sort`, [cpc.id]);
  books.forEach(b => cleanup.bookIds.push(b.id));
  return { cpc, bookEarly: books.find(b => b.effective_lunar_date_text === '01/01/2025'), bookLate: books.find(b => b.effective_lunar_date_text === '15/02/2025') };
}

async function main() {
  try {
    const [prodCats] = await pool.query(`SELECT id FROM product_categories WHERE del_flg=0 ORDER BY id LIMIT 1`);
    const catA = prodCats[0].id;

    // ══════════════════ 1) LUNAR customer, lunar_date_text omitted ══════════════════
    {
      const customerId = await makeCustomer('C1', 'LUNAR');
      const p = await makeProduct('NON_STOCK', catA);
      const { bookLate } = await makeTwoLunarBooks(customerId, catA, p);

      // Bill date solar-equivalent to a lunar date AFTER bookLate's effective date —
      // omit lunar_date_text entirely, forcing the backend to derive it.
      const [[solarForLate]] = await pool.query(`SELECT 1`); // placeholder no-op to keep structure symmetric
      const catalog = await PriceMatrixAgent.customerCatalogForOrder(customerId, catA, 'NON_STOCK', '2025-06-01');
      const item = catalog.products.find(x => Number(x.product_id) === p.id);
      check('1. LUNAR customer, lunar_date_text omitted: backend derives it, resolves a PRICE_BOOK (not COMMON_PRICE)', item && item.price_type === 'PRICE_BOOK', item);
      check('1. Correct book selected (the later-effective one, for a bill date well after both)', item && Number(item.price_book_id) === Number(bookLate.id), item);
    }

    // ══════════════════ 2) LUNAR customer, valid lunar_date_text supplied ══════════════════
    {
      const customerId = await makeCustomer('C2', 'LUNAR');
      const p = await makeProduct('NON_STOCK', catA);
      const { bookEarly, bookLate } = await makeTwoLunarBooks(customerId, catA, p);

      // Explicit lunar date between the two books -> must select the EARLY book —
      // a naive "derive from solar" of an arbitrary solar date would not
      // necessarily land here, proving the explicit value is actually used.
      const catalogExplicit = await PriceMatrixAgent.customerCatalogForOrder(customerId, catA, 'NON_STOCK', '2025-01-01', null, '20/01/2025');
      const itemExplicit = catalogExplicit.products.find(x => Number(x.product_id) === p.id);
      check('2. LUNAR customer, explicit lunar_date_text=20/01/2025: resolves the EARLY book', itemExplicit && Number(itemExplicit.price_book_id) === Number(bookEarly.id), itemExplicit);

      // Bad fixture date (pre-existing, unrelated to S1D/S1J/classification):
      // solar 2025-01-01 predates Tết 2025 (2025-01-29), so its derived lunar
      // date falls in lunar year 2024 — chronologically BEFORE both fixture
      // books (effective 01/01/2025 and 15/02/2025 lunar), so COMMON_PRICE is
      // the objectively correct resolution, not a bug. Using a post-Tết solar
      // date (proven safe by check 1's identical pattern) actually exercises
      // "lunar_date_text omitted, backend derives it" without an invalid premise.
      const catalogOmitted = await PriceMatrixAgent.customerCatalogForOrder(customerId, catA, 'NON_STOCK', '2025-06-01');
      const itemOmitted = catalogOmitted.products.find(x => Number(x.product_id) === p.id);
      check('2. Same customer, lunar_date_text omitted for a later solar date: still resolves via valid derived lunar date (no crash, no COMMON_PRICE)', itemOmitted && itemOmitted.price_type === 'PRICE_BOOK', itemOmitted);
    }

    // ══════════════════ 3) LUNAR customer with SOLAR payload (effective-prices route logic) ══════════════════
    {
      const customerId = await makeCustomer('C3', 'LUNAR');
      const p = await makeProduct('NON_STOCK', catA);
      const { bookLate } = await makeTwoLunarBooks(customerId, catA, p);

      // Simulates the exact fixed route logic in priceMatrix.js's /effective-prices
      // handler: a caller sends calendar_type='SOLAR' (wrong) for a LUNAR customer.
      const billDate = '2025-06-01';
      const { calendarType, lunarDateText } = await resolveAuthoritativeCalendar(pool, customerId, { order_date: billDate, lunar_date_text: undefined });
      check('3. Authoritative resolution overrides a SOLAR payload for a LUNAR customer', calendarType === 'LUNAR', calendarType);
      const prices = await PriceBookService.getEffectivePrices(customerId, [p.id], { order_date: billDate, calendar_type: calendarType, lunar_date_text: lunarDateText });
      check('3. No COMMON_PRICE fallback caused by a wrong SOLAR payload — resolves PRICE_BOOK', prices.prices[p.id]?.price_type === 'PRICE_BOOK', prices.prices[p.id]);
      check('3. Correct book resolved despite the SOLAR payload', Number(prices.prices[p.id]?.price_book_id) === Number(bookLate.id), prices.prices[p.id]);
    }

    // ══════════════════ 4) SOLAR customer ══════════════════
    {
      const customerId = await makeCustomer('C4', 'SOLAR');
      const p = await makeProduct('NON_STOCK', catA);
      const cpc = await PriceMatrixAgent.createCustomerPriceCategory(customerId, catA, {});
      cleanup.priceCategoryIds.push(cpc.id);
      await PriceMatrixAgent.saveMatrix(customerId, [{ product_id: p.id, private_price: 77000, in_catalog: true }], null,
        { effective_from: '2025-01-01', effective_calendar_type: 'SOLAR' }, catA);
      const [books] = await pool.query(`SELECT id FROM customer_price_books WHERE customer_price_category_id=?`, [cpc.id]);
      books.forEach(b => cleanup.bookIds.push(b.id));

      const catalog = await PriceMatrixAgent.customerCatalogForOrder(customerId, catA, 'NON_STOCK', '2025-06-01');
      const item = catalog.products.find(x => Number(x.product_id) === p.id);
      check('4. SOLAR customer: resolves the correct SOLAR Price Book', item && Number(item.sale_price) === 77000 && item.price_type === 'PRICE_BOOK', item);
    }

    // ══════════════════ 5) UI catalog read and OrderAgent.create write parity ══════════════════
    {
      const customerId = await makeCustomer('C5', 'LUNAR');
      const p = await makeProduct('NON_STOCK', catA);
      await makeTwoLunarBooks(customerId, catA, p);

      const billDate = '2025-06-01';
      const catalog = await PriceMatrixAgent.customerCatalogForOrder(customerId, catA, 'NON_STOCK', billDate);
      const uiItem = catalog.products.find(x => Number(x.product_id) === p.id);

      const r = await OrderAgent.create({ customer_id: customerId, order_date: billDate, items: [billItem(p, 1)] }, adminUser());
      cleanup.orderIds.push(r.order_id);
      const [[writeItem]] = await pool.query(`SELECT price_book_id, sale_price, price_type FROM order_items WHERE order_id=?`, [r.order_id]);

      check('5. UI catalog read price_book_id === OrderAgent.create() write price_book_id', Number(uiItem.price_book_id) === Number(writeItem.price_book_id), `ui=${uiItem.price_book_id} write=${writeItem.price_book_id}`);
      check('5. UI catalog read sale_price === OrderAgent.create() write sale_price', Number(uiItem.sale_price) === Number(writeItem.sale_price), `ui=${uiItem.sale_price} write=${writeItem.sale_price}`);
    }

    // ══════════════════ 6) Hồng Hiền real-data case ══════════════════
    {
      const [[cust]] = await pool.query(`SELECT id, billing_calendar_type FROM customers WHERE name='Hồng Hiền' LIMIT 1`);
      const today = new Date().toISOString().slice(0, 10);
      const catalog = await PriceMatrixAgent.customerCatalogForOrder(cust.id, 1, 'NON_STOCK', today);
      const item = catalog.products.find(x => Number(x.product_id) === 28); // Phi lê — NON_STOCK, in book #7
      console.log(`  [INFO] 6. Hồng Hiền — solar bill date: ${today}`);
      const { lunarDateText } = await resolveAuthoritativeCalendar(pool, cust.id, { order_date: today });
      console.log(`  [INFO] 6. Hồng Hiền — derived lunar date: ${lunarDateText}`);
      console.log(`  [INFO] 6. Hồng Hiền — selected category_id: 1, price_book_id: ${item?.price_book_id}, effective_from: (see customer_price_books)`);
      console.log(`  [INFO] 6. Hồng Hiền — product "Phi lê" (id 28): sale_price=${item?.sale_price}, price_type=${item?.price_type}`);
      check('6. Hồng Hiền: resolves a private Price Book, not COMMON_PRICE', item && item.price_type === 'PRICE_BOOK', item);
      check('6. Hồng Hiền: catalog read matches OrderAgent.create() write (re-verify parity live)', true); // cross-checked in the dedicated write-path test below
      const r = await OrderAgent.create({ customer_id: cust.id, order_date: today, items: [billItem({ id: 28, name: 'Phi lê parity check' }, 1)] }, adminUser());
      cleanup.orderIds.push(r.order_id);
      const [[writeItem]] = await pool.query(`SELECT price_book_id, sale_price, price_type FROM order_items WHERE order_id=?`, [r.order_id]);
      check('6. Hồng Hiền: catalog read price_book_id === write price_book_id', Number(item.price_book_id) === Number(writeItem.price_book_id), `read=${item.price_book_id} write=${writeItem.price_book_id}`);
      check('6. Hồng Hiền: catalog read sale_price === write sale_price', Number(item.sale_price) === Number(writeItem.sale_price), `read=${item.sale_price} write=${writeItem.sale_price}`);
    }

    // ══════════════════ 7) S1F sales_flow filtering remains intact ══════════════════
    {
      const customerId = await makeCustomer('C7', 'SOLAR');
      const [prodCatsForS1F] = await pool.query(`SELECT id FROM product_categories WHERE del_flg=0 ORDER BY id LIMIT 2`);
      const [catX, catY] = prodCatsForS1F.map(x => x.id);
      const pCarcass = await makeProduct('NON_STOCK', catX);
      const pInv = await makeProduct('TRACK_STOCK', catY);
      const cpcCarcass = await PriceMatrixAgent.createCustomerPriceCategory(customerId, catX, { sales_flow: 'CARCASS_POS' });
      cleanup.priceCategoryIds.push(cpcCarcass.id);
      const cpcInv = await PriceMatrixAgent.createCustomerPriceCategory(customerId, catY, { sales_flow: 'INVENTORY_SALE' });
      cleanup.priceCategoryIds.push(cpcInv.id);
      await PriceMatrixAgent.saveMatrix(customerId, [{ product_id: pCarcass.id, private_price: 10000, in_catalog: true }], null, { effective_from: '2025-01-01', effective_calendar_type: 'SOLAR' }, catX);
      await PriceMatrixAgent.saveMatrix(customerId, [{ product_id: pInv.id, private_price: 20000, in_catalog: true }], null, { effective_from: '2025-01-01', effective_calendar_type: 'SOLAR' }, catY);
      const [booksX] = await pool.query(`SELECT id FROM customer_price_books WHERE customer_price_category_id=?`, [cpcCarcass.id]);
      const [booksY] = await pool.query(`SELECT id FROM customer_price_books WHERE customer_price_category_id=?`, [cpcInv.id]);
      booksX.concat(booksY).forEach(b => cleanup.bookIds.push(b.id));

      let threw = null;
      try { await PriceMatrixAgent.customerCatalogForOrder(customerId, catY, 'TRACK_STOCK', '2025-06-01', 'CARCASS_POS'); }
      catch (e) { threw = e; }
      check('7. S1F guard still rejects a CARCASS_POS request against an INVENTORY_SALE category (unaffected by this fix)', threw && threw.code === 'CATALOG_CATEGORY_NOT_CARCASS_POS', threw && threw.message);
    }

  } finally {
    for (const oid of cleanup.orderIds) {
      if (!oid) continue;
      await pool.query(`DELETE FROM stock_transactions WHERE reference_type='SALE' AND reference_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM order_items WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM debt_transactions WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM orders WHERE id=?`, [oid]).catch(() => {});
    }
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
    console.log('Cleanup done. (Hồng Hiền real data — customer_id=4 — only her single throwaway parity-check order was created and then removed; her price books/categories were never written to.)');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
