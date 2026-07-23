'use strict';
// S1D — Price Book Data Integrity verification.
//
// Covers, against:
//  - Rule 1 (unchanged): PriceBookService resolver orders by effective_from /
//    effective_lunar_sort DESC, never created_at/id.
//  - Rule 2 (new): PriceBookService.assertNotBackdated(), wired into
//    PriceMatrixAgent.upsertBook() and PriceBookService.createOrReplaceBook().
//  - Rule 3 (new): OrderAgent.create()'s resolveAuthoritativeCalendar()
//    (backend/src/utils/billCalendar.js), re-reading customers.billing_calendar_type.
//  - Rule 4 (new): PriceMatrixAgent.customerCatalogForOrder()'s billDate param.
//
// Self-cleaning: throwaway customers/products/categories/books/orders, removed in
// `finally` regardless of pass/fail. The one exception is case 10 (Hồng Hiền real
// data, customer_id=4) — that case is READ-ONLY (direct PriceBookService calls),
// no row is written against her real account.

const pool = require('../src/config/db');
const ProductAgent = require('../src/agents/ProductAgent');
const OrderAgent = require('../src/agents/OrderAgent');
const PriceMatrixAgent = require('../src/agents/PriceMatrixAgent');
const PriceBookService = require('../src/services/PriceBookService');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}

const cleanup = { orderIds: [], productIds: [], customerIds: [], priceCategoryIds: [], bookIds: [] };
const adminUser = () => ({ id: null, role: 'ADMIN' });
const billItem = (p, qty) => ({ product_id: p.id, product_name: p.name, unit: 'kg', quantity: qty });

async function makeProduct(mode, { stock = 0, categoryId }) {
  const tag = `S1D ${mode} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const salesFlow = mode === 'TRACK_STOCK' ? 'INVENTORY_SALE' : 'CARCASS_POS';
  await ProductAgent.addProduct({ name: tag, unit: 'kg', category_id: categoryId, inventory_mode: mode, sales_flow: salesFlow, stock_quantity: stock });
  const [[created]] = await pool.query(`SELECT * FROM products WHERE name=? LIMIT 1`, [tag]);
  cleanup.productIds.push(created.id);
  return created;
}
async function makeCustomer(label, calendarType = 'SOLAR') {
  const [ins] = await pool.query(
    `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type)
     VALUES(?,?,?,?,?,?,?,?)`,
    [`S1DTEST-${label}-${Date.now()}`, `S1D Test ${label}`, '0', 'test', 'PRIVATE_PRICE', 0, 0, calendarType]
  );
  cleanup.customerIds.push(ins.insertId);
  return ins.insertId;
}
async function setupCategory(customerId, categoryId) {
  const cpc = await PriceMatrixAgent.createCustomerPriceCategory(customerId, categoryId, {});
  cleanup.priceCategoryIds.push(cpc.id);
  return cpc;
}

async function main() {
  try {
    const [prodCats] = await pool.query(`SELECT id FROM product_categories WHERE del_flg=0 ORDER BY id LIMIT 1`);
    const catA = prodCats[0].id;

    // ══════════════════ 1) Price Book A (01/01) / B (15/01), bill dates ══════════════════
    {
      const customerId = await makeCustomer('C1', 'SOLAR');
      const cpc = await setupCategory(customerId, catA);
      const p = await makeProduct('NON_STOCK', { categoryId: catA });

      await PriceMatrixAgent.saveMatrix(customerId, [{ product_id: p.id, private_price: 10000, in_catalog: true }], null,
        { effective_from: '2025-01-01', effective_calendar_type: 'SOLAR' }, catA);
      await PriceMatrixAgent.saveMatrix(customerId, [{ product_id: p.id, private_price: 20000, in_catalog: true }], null,
        { effective_from: '2025-01-15', effective_calendar_type: 'SOLAR' }, catA);
      const [books] = await pool.query(`SELECT id, effective_from FROM customer_price_books WHERE customer_price_category_id=? ORDER BY effective_from`, [cpc.id]);
      books.forEach(b => cleanup.bookIds.push(b.id));
      const bookA = books.find(b => b.effective_from === '2025-01-01');
      const bookB = books.find(b => b.effective_from === '2025-01-15');

      const price14 = await PriceBookService.getEffectivePrice(customerId, p.id, '2025-01-14', pool, 'SOLAR', '');
      const price15 = await PriceBookService.getEffectivePrice(customerId, p.id, '2025-01-15', pool, 'SOLAR', '');
      const price20 = await PriceBookService.getEffectivePrice(customerId, p.id, '2025-01-20', pool, 'SOLAR', '');

      check('1. Bill 14/01 -> Book A', price14.price_book_id === bookA.id, `got ${price14.price_book_id}, expected ${bookA.id}`);
      check('1. Bill 15/01 -> Book B', price15.price_book_id === bookB.id, `got ${price15.price_book_id}, expected ${bookB.id}`);
      check('1. Bill after 15/01 -> Book B', price20.price_book_id === bookB.id, `got ${price20.price_book_id}, expected ${bookB.id}`);
    }

    // ══════════════════ 2) Rule 1 SQL evidence (static) ══════════════════
    {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'PriceBookService.js'), 'utf8');
      check('2. getEffectivePrice ORDER BY effective_from DESC (not created_at/id)', /ORDER BY b\.effective_from DESC,b\.id DESC/.test(src));
      check('2. getEffectivePricesForCategory ORDER BY effective_from DESC (window fn)', /ORDER BY b\.effective_from DESC, b\.id DESC/.test(src));
      check('2. No created_at ever used as an ORDER BY key for price resolution', !/ORDER BY[^;]*created_at/i.test(src));
    }

    // ══════════════════ 3) Later-created book, earlier effective date -> does not override ══════════════════
    {
      const customerId = await makeCustomer('C3', 'SOLAR');
      const cpc = await setupCategory(customerId, catA);
      const p = await makeProduct('NON_STOCK', { categoryId: catA });

      // Legitimate: book at 2025-02-01 (later).
      await PriceMatrixAgent.saveMatrix(customerId, [{ product_id: p.id, private_price: 50000, in_catalog: true }], null,
        { effective_from: '2025-02-01', effective_calendar_type: 'SOLAR' }, catA);
      const [[laterBook]] = await pool.query(
        `SELECT id FROM customer_price_books WHERE customer_price_category_id=? AND effective_from='2025-02-01'`, [cpc.id]);
      cleanup.bookIds.push(laterBook.id);

      // Simulate legacy/pre-guard data: a book inserted directly via SQL (bypassing
      // the Rule 2 guard entirely, exactly as Hồng Hiền's real book #126 exists in
      // production) with an EARLIER effective date but a LATER created_at.
      const [ins] = await pool.query(
        `INSERT INTO customer_price_books(customer_id,category_id,customer_price_category_id,book_name,effective_from,effective_calendar_type,status,created_at)
         VALUES(?,?,?,?,?,?,?,DATE_ADD(NOW(), INTERVAL 1 DAY))`,
        [customerId, catA, cpc.id, 'Legacy backdated (direct insert)', '2025-01-01', 'SOLAR', 'ACTIVE']
      );
      const earlierButNewerBook = ins.insertId;
      cleanup.bookIds.push(earlierButNewerBook);
      await pool.query(`INSERT INTO customer_price_book_items(price_book_id,customer_id,product_id,sale_price) VALUES(?,?,?,?)`,
        [earlierButNewerBook, customerId, p.id, 99999]);

      const price = await PriceBookService.getEffectivePrice(customerId, p.id, '2025-02-10', pool, 'SOLAR', '');
      check('3. Later-created book with earlier effective date does NOT override the later-effective book',
        price.price_book_id === laterBook.id, `got ${price.price_book_id}, expected ${laterBook.id} (not ${earlierButNewerBook})`);
      check('3. Resolved price is the later-effective book\'s price, not the backdated one', Number(price.sale_price) === 50000, price.sale_price);
    }

    // ══════════════════ 4) Attempt accidental backdated creation -> clear HTTP 400 ══════════════════
    {
      const customerId = await makeCustomer('C4', 'SOLAR');
      const cpc = await setupCategory(customerId, catA);
      const p = await makeProduct('NON_STOCK', { categoryId: catA });

      await PriceMatrixAgent.saveMatrix(customerId, [{ product_id: p.id, private_price: 30000, in_catalog: true }], null,
        { effective_from: '2025-03-15', effective_calendar_type: 'SOLAR' }, catA);
      const [[book]] = await pool.query(`SELECT id FROM customer_price_books WHERE customer_price_category_id=? AND effective_from='2025-03-15'`, [cpc.id]);
      cleanup.bookIds.push(book.id);

      let threw = null;
      try {
        await PriceMatrixAgent.saveMatrix(customerId, [{ product_id: p.id, private_price: 25000, in_catalog: true }], null,
          { effective_from: '2025-03-01', effective_calendar_type: 'SOLAR' }, catA); // earlier than 03-15
      } catch (e) { threw = e; }
      check('4. Accidental backdated creation: rejected HTTP 400', threw && threw.status === 400 && threw.code === 'PRICE_BOOK_BACKDATED', threw && threw.message);
      check('4. Exact business error text', threw && threw.message === 'Ngày hiệu lực mới đang sớm hơn bảng giá hiện hành.\nVui lòng kiểm tra lại hoặc sử dụng chức năng sửa dữ liệu lịch sử.', threw && threw.message);
      const [[stillOneBook]] = await pool.query(`SELECT COUNT(*) c FROM customer_price_books WHERE customer_price_category_id=?`, [cpc.id]);
      check('4. No new book row created by the rejected attempt', Number(stillOneBook.c) === 1, stillOneBook.c);
    }

    // ══════════════════ 5) Edit same effective-date record -> allowed ══════════════════
    {
      const customerId = await makeCustomer('C5', 'SOLAR');
      const cpc = await setupCategory(customerId, catA);
      const p = await makeProduct('NON_STOCK', { categoryId: catA });

      await PriceMatrixAgent.saveMatrix(customerId, [{ product_id: p.id, private_price: 40000, in_catalog: true }], null,
        { effective_from: '2025-04-01', effective_calendar_type: 'SOLAR' }, catA);
      const [[book1]] = await pool.query(`SELECT id FROM customer_price_books WHERE customer_price_category_id=? AND effective_from='2025-04-01'`, [cpc.id]);
      cleanup.bookIds.push(book1.id);

      let threw = null;
      try {
        await PriceMatrixAgent.saveMatrix(customerId, [{ product_id: p.id, private_price: 45000, in_catalog: true }], null,
          { effective_from: '2025-04-01', effective_calendar_type: 'SOLAR' }, catA); // SAME date -> edit, not backdate
      } catch (e) { threw = e; }
      check('5. Editing the SAME effective date: allowed, no rejection', !threw, threw && threw.message);
      const price = await PriceBookService.getEffectivePrice(customerId, p.id, '2025-04-01', pool, 'SOLAR', '');
      check('5. Edited price applied (45000)', Number(price.sale_price) === 45000, price.sale_price);
      const [[stillOneBook]] = await pool.query(`SELECT COUNT(*) c FROM customer_price_books WHERE customer_price_category_id=?`, [cpc.id]);
      check('5. Still exactly one book row (UPDATE, not a new row)', Number(stillOneBook.c) === 1, stillOneBook.c);
    }

    // ══════════════════ 6) LUNAR customer + SOLAR request -> normalized, never silently COMMON_PRICE ══════════════════
    {
      const customerId = await makeCustomer('C6', 'LUNAR');
      const cpc = await setupCategory(customerId, catA);
      const p = await makeProduct('NON_STOCK', { categoryId: catA });
      await PriceMatrixAgent.saveMatrix(customerId, [{ product_id: p.id, private_price: 60000, in_catalog: true }], null,
        { effective_lunar_date_text: '10/01/2025', effective_calendar_type: 'LUNAR' }, catA);
      const [books] = await pool.query(`SELECT id FROM customer_price_books WHERE customer_price_category_id=?`, [cpc.id]);
      books.forEach(b => cleanup.bookIds.push(b.id));

      // Deliberately WRONG payload: calendar_type='SOLAR' for a LUNAR customer, no lunar_date_text.
      const r = await OrderAgent.create({
        customer_id: customerId, order_date: '2025-02-15', calendar_type: 'SOLAR', items: [billItem(p, 1)]
      }, adminUser());
      cleanup.orderIds.push(r.order_id);
      const [[order]] = await pool.query(`SELECT calendar_type, lunar_date_text FROM orders WHERE id=?`, [r.order_id]);
      const [[item]] = await pool.query(`SELECT price_type, sale_price FROM order_items WHERE order_id=?`, [r.order_id]);
      check('6. LUNAR customer + SOLAR request payload: order normalized to calendar_type=LUNAR', order.calendar_type === 'LUNAR', order.calendar_type);
      check('6. lunar_date_text was derived (not blank)', !!order.lunar_date_text, order.lunar_date_text);
      check('6. Never silently fell back to COMMON_PRICE — resolved via PRICE_BOOK', item.price_type === 'PRICE_BOOK', item.price_type);
      check('6. Correct LUNAR price applied (60000, not a default/common price)', Number(item.sale_price) === 60000, item.sale_price);
    }

    // ══════════════════ 7) LUNAR customer + correct lunar bill date -> correct LUNAR Price Book ══════════════════
    {
      const customerId = await makeCustomer('C7', 'LUNAR');
      const cpc = await setupCategory(customerId, catA);
      const p = await makeProduct('NON_STOCK', { categoryId: catA });
      await PriceMatrixAgent.saveMatrix(customerId, [{ product_id: p.id, private_price: 70000, in_catalog: true }], null,
        { effective_lunar_date_text: '01/01/2025', effective_calendar_type: 'LUNAR' }, catA);
      const [books] = await pool.query(`SELECT id FROM customer_price_books WHERE customer_price_category_id=?`, [cpc.id]);
      books.forEach(b => cleanup.bookIds.push(b.id));

      const r = await OrderAgent.create({
        customer_id: customerId, order_date: '2025-02-01', calendar_type: 'LUNAR', lunar_date_text: '15/01/2025', items: [billItem(p, 1)]
      }, adminUser());
      cleanup.orderIds.push(r.order_id);
      const [[item]] = await pool.query(`SELECT price_type, sale_price, price_book_id FROM order_items WHERE order_id=?`, [r.order_id]);
      check('7. LUNAR customer, correct lunar bill date: resolves PRICE_BOOK', item.price_type === 'PRICE_BOOK', item.price_type);
      check('7. Correct LUNAR price (70000)', Number(item.sale_price) === 70000, item.sale_price);
    }

    // ══════════════════ 8) SOLAR customer -> correct SOLAR Price Book ══════════════════
    {
      const customerId = await makeCustomer('C8', 'SOLAR');
      const cpc = await setupCategory(customerId, catA);
      const p = await makeProduct('NON_STOCK', { categoryId: catA });
      await PriceMatrixAgent.saveMatrix(customerId, [{ product_id: p.id, private_price: 80000, in_catalog: true }], null,
        { effective_from: '2025-01-01', effective_calendar_type: 'SOLAR' }, catA);
      const [books] = await pool.query(`SELECT id FROM customer_price_books WHERE customer_price_category_id=?`, [cpc.id]);
      books.forEach(b => cleanup.bookIds.push(b.id));

      const r = await OrderAgent.create({ customer_id: customerId, order_date: '2025-02-01', items: [billItem(p, 1)] }, adminUser());
      cleanup.orderIds.push(r.order_id);
      const [[order]] = await pool.query(`SELECT calendar_type FROM orders WHERE id=?`, [r.order_id]);
      const [[item]] = await pool.query(`SELECT price_type, sale_price FROM order_items WHERE order_id=?`, [r.order_id]);
      check('8. SOLAR customer: order calendar_type=SOLAR', order.calendar_type === 'SOLAR', order.calendar_type);
      check('8. Correct SOLAR price (80000)', Number(item.sale_price) === 80000 && item.price_type === 'PRICE_BOOK', item);
    }

    // ══════════════════ 9) UI-loaded Price Book ID equals final order_items.price_book_id ══════════════════
    {
      const customerId = await makeCustomer('C9', 'SOLAR');
      const cpc = await setupCategory(customerId, catA);
      const p = await makeProduct('NON_STOCK', { categoryId: catA });
      await PriceMatrixAgent.saveMatrix(customerId, [{ product_id: p.id, private_price: 90000, in_catalog: true }], null,
        { effective_from: '2025-01-01', effective_calendar_type: 'SOLAR' }, catA);
      await PriceMatrixAgent.saveMatrix(customerId, [{ product_id: p.id, private_price: 95000, in_catalog: true }], null,
        { effective_from: '2025-06-01', effective_calendar_type: 'SOLAR' }, catA);
      const [books] = await pool.query(`SELECT id FROM customer_price_books WHERE customer_price_category_id=?`, [cpc.id]);
      books.forEach(b => cleanup.bookIds.push(b.id));

      const billDate = '2025-03-01'; // between the two books -> should resolve the first one
      const uiCatalog = await PriceMatrixAgent.customerCatalogForOrder(customerId, catA, 'NON_STOCK', billDate);
      const uiProduct = uiCatalog.products.find(x => Number(x.product_id) === p.id);

      const r = await OrderAgent.create({ customer_id: customerId, order_date: billDate, items: [billItem(p, 1)] }, adminUser());
      cleanup.orderIds.push(r.order_id);
      const [[item]] = await pool.query(`SELECT price_book_id, sale_price FROM order_items WHERE order_id=?`, [r.order_id]);

      check('9. UI catalog (billDate-aware) resolves the correct book price (90000, not 95000)', Number(uiProduct.sale_price) === 90000, uiProduct.sale_price);
      check('9. UI-loaded price_book_id equals final order_items.price_book_id', Number(uiProduct.price_book_id) === Number(item.price_book_id), `ui=${uiProduct.price_book_id} final=${item.price_book_id}`);
      check('9. Final sale_price matches (90000)', Number(item.sale_price) === 90000, item.sale_price);
    }

    // ══════════════════ 10) Hồng Hiền real case (READ-ONLY, no writes against her account) ══════════════════
    {
      const [[cust]] = await pool.query(`SELECT id, billing_calendar_type FROM customers WHERE name='Hồng Hiền' LIMIT 1`);
      if (!cust) {
        console.log('  [SKIP] 10. Hồng Hiền customer not found in this DB — skipping real-data case');
      } else {
        const [books] = await pool.query(
          `SELECT id, effective_lunar_date_text, effective_lunar_sort FROM customer_price_books WHERE customer_id=? ORDER BY effective_lunar_sort`,
          [cust.id]
        );
        const book126 = books.find(b => b.effective_lunar_date_text === '01/01/2026');
        const book7 = books.find(b => b.effective_lunar_date_text === '12/02/2026');
        if (!book126 || !book7) {
          console.log('  [SKIP] 10. Expected books #126 (01/01/2026) / #7 (12/02/2026) not found — real data may have changed since the audit');
        } else {
          const [[productRow]] = await pool.query(
            `SELECT product_id FROM customer_price_book_items WHERE price_book_id IN (?, ?) GROUP BY product_id HAVING COUNT(DISTINCT price_book_id)=2 LIMIT 1`,
            [book126.id, book7.id]
          );
          const productId = productRow.product_id;

          const beforeBoundary = await PriceBookService.getEffectivePrice(cust.id, productId, '2025-01-01', pool, 'LUNAR', '15/01/2026');
          const atBoundary = await PriceBookService.getEffectivePrice(cust.id, productId, '2025-01-01', pool, 'LUNAR', '12/02/2026');
          const afterBoundary = await PriceBookService.getEffectivePrice(cust.id, productId, '2025-01-01', pool, 'LUNAR', '01/03/2026');

          check('10. Hồng Hiền: bill before 12/02 ÂL (15/01 ÂL) -> book #126', Number(beforeBoundary.price_book_id) === Number(book126.id), `got ${beforeBoundary.price_book_id}, expected ${book126.id}`);
          check('10. Hồng Hiền: bill exactly 12/02 ÂL -> book #7', Number(atBoundary.price_book_id) === Number(book7.id), `got ${atBoundary.price_book_id}, expected ${book7.id}`);
          check('10. Hồng Hiền: bill after 12/02 ÂL (01/03 ÂL) -> book #7', Number(afterBoundary.price_book_id) === Number(book7.id), `got ${afterBoundary.price_book_id}, expected ${book7.id}`);
          check('10. Later created_at on #126 does not override #7 (real production data, confirmed)',
            Number(atBoundary.price_book_id) === Number(book7.id) && Number(afterBoundary.price_book_id) === Number(book7.id));
        }
      }
    }

    // ══════════════════ 11) Excel and AI use the same resolver ══════════════════
    {
      const createOrderSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', 'CreateOrder.jsx'), 'utf8');
      const importSharesCreate = /matchImportedRows/.test(createOrderSrc) && /api\.post\('\/orders'/.test(createOrderSrc) && /order_date:orderDate/.test(createOrderSrc);
      check('11a. Excel Import shares OrderAgent.create() AND now sends order_date on catalog load', importSharesCreate);

      const orderServiceSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'order.service.js'), 'utf8');
      const usesSharedPriceResolver = /PriceBookService\.getEffectivePrice\(/.test(orderServiceSrc);
      const usesFreshCustomerCalendar = /getFreshCustomer|customer\.billing_calendar_type/.test(orderServiceSrc);
      check('11b. AI Confirm path calls the same PriceBookService.getEffectivePrice() SQL resolver as OrderAgent.create()', usesSharedPriceResolver);
      check('11b. AI Confirm path already re-reads customer.billing_calendar_type as authoritative (verified correct independently, not modified)', usesFreshCustomerCalendar);
    }

    // ══════════════════ 12) Existing Bò Xô price regression ══════════════════
    {
      const [[beefCat]] = await pool.query(`SELECT id FROM product_categories WHERE name='Thịt bò' LIMIT 1`);
      if (beefCat) {
        // A throwaway NON_STOCK product in the real "Thịt bò" category — not an
        // existing real product, whose actual inventory_mode/allow_negative_stock
        // is unknown/irrelevant here. This regression is about the CARCASS_POS
        // price/sales_flow path staying correct, not about any specific real SKU.
        const beefProduct = await makeProduct('NON_STOCK', { categoryId: beefCat.id });
        const customerId = await makeCustomer('C12', 'SOLAR');
        await setupCategory(customerId, beefCat.id);
        await PriceMatrixAgent.saveMatrix(customerId, [{ product_id: beefProduct.id, private_price: 99000, in_catalog: true }], null,
          { effective_from: '2025-01-01', effective_calendar_type: 'SOLAR' }, beefCat.id);
        const [books] = await pool.query(`SELECT id FROM customer_price_books WHERE customer_id=?`, [customerId]);
        books.forEach(b => cleanup.bookIds.push(b.id));
        const r = await OrderAgent.create({ customer_id: customerId, order_date: '2025-06-01', items: [billItem(beefProduct, 1)] }, adminUser());
        cleanup.orderIds.push(r.order_id);
        const [[item]] = await pool.query(`SELECT sale_price, price_type FROM order_items WHERE order_id=?`, [r.order_id]);
        const [[order]] = await pool.query(`SELECT sales_flow FROM orders WHERE id=?`, [r.order_id]);
        check('12. Existing Bò Xô price regression: bill created and correctly priced', Number(item.sale_price) === 99000 && item.price_type === 'PRICE_BOOK');
        check('12. Mixed Bill architecture untouched: sales_flow still correctly derived CARCASS_POS', order.sales_flow === 'CARCASS_POS', order.sales_flow);
      }
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
    console.log('Cleanup done. (Hồng Hiền real data — customer_id, price books, orders — was never written to.)');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
