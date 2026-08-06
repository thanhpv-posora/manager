/**
 * Verifies a CUSTOMER cannot change the prices they are charged.
 *
 * assertCustomerScope() blocks cross-customer access but deliberately passes a
 * CUSTOMER acting on their OWN customer_id. Every Price Matrix write route was
 * auth(['ADMIN','STAFF','CUSTOMER']), so a customer could rewrite or delete
 * their own price book — the one that decides what they pay. Confirmed before
 * the fix: PUT /price-matrix/books/:id returned 200 and moved the price from
 * 500,000 to 0; DELETE returned 200.
 *
 * Self-cleaning: creates its own customer / category / product / price book and
 * removes them in `finally`. Requires the API running on PORT (default 4000).
 *
 * Run: node scripts/verify-price-write-authz.js
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const pool = require('../src/config/db');
const ProductAgent = require('../src/agents/ProductAgent');
const PriceMatrixAgent = require('../src/agents/PriceMatrixAgent');

const BASE = 'http://127.0.0.1:' + (process.env.PORT || 4000);
const tok = (role, customerId) =>
  jwt.sign({ id: 999002, username: 'pwauthz-' + role, role, customer_id: customerId },
    process.env.JWT_SECRET, { expiresIn: '10m' });

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log('  [PASS] ' + msg); }
  else { fail++; console.log('  [FAIL] ' + msg + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
};

async function call(method, path, role, customerId, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (role) headers.Authorization = 'Bearer ' + tok(role, customerId);
  const res = await fetch(BASE + path, {
    method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  return res.status;
}

async function main() {
  let customerId = null, productId = null, cpcId = null, catId = null, bookId = null;
  try {
    const [cat] = await pool.query(
      `INSERT INTO product_categories(name,sort_order,is_active,del_flg) VALUES(?,?,1,0)`,
      [`PWAUTHZ CAT ${Date.now()}`, 999]);
    catId = cat.insertId;

    const [c] = await pool.query(
      `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type,default_sales_flow)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      [`PWAUTHZ-${Date.now()}`, 'Price Authz Test Customer', '0', 'test', 'PRIVATE_PRICE', 0, 0, 'SOLAR', 'INVENTORY_SALE']);
    customerId = c.insertId;

    const tag = `PWAUTHZ PROD ${Date.now()}`;
    await ProductAgent.addProduct({
      name: tag, unit: 'kg', category_id: catId,
      sales_flow: 'INVENTORY_SALE', inventory_mode: 'TRACK_STOCK', stock_quantity: 10,
    });
    const [[p]] = await pool.query(`SELECT id FROM products WHERE name=? LIMIT 1`, [tag]);
    productId = p.id;

    const cpc = await PriceMatrixAgent.createCustomerPriceCategory(customerId, catId, { sales_flow: 'INVENTORY_SALE' });
    cpcId = cpc.id;
    await PriceMatrixAgent.saveMatrix(customerId,
      [{ product_id: productId, private_price: 500000, in_catalog: true }],
      null, { effective_from: '2024-01-01', effective_calendar_type: 'SOLAR' }, catId);
    const [books] = await pool.query(
      `SELECT id FROM customer_price_books WHERE customer_price_category_id=?`, [cpcId]);
    bookId = books[0].id;

    console.log('=== a CUSTOMER cannot change the prices they are charged ===\n');

    const WRITES = [
      ['PUT',    `/api/price-matrix/books/${bookId}`,                 'rewrite own price book',   { items: [{ product_id: productId, sale_price: 1, in_catalog: true }] }],
      ['DELETE', `/api/price-matrix/books/${bookId}`,                 'delete own price book',    {}],
      ['POST',   `/api/price-matrix/books/${bookId}/copy`,            'copy own price book',      {}],
      ['POST',   `/api/price-matrix/${customerId}/categories`,        'create own price category',{ category_id: catId }],
      ['PUT',    `/api/price-matrix/categories/${cpcId}`,             'change own category flow', { sales_flow: 'CARCASS_POS' }],
      ['PUT',    `/api/price-matrix/categories/${cpcId}/default`,     'set own default category', {}],
      ['DELETE', `/api/price-matrix/categories/${cpcId}`,             'delete own price category',{}],
      ['PUT',    `/api/price-matrix/${customerId}`,                   'save own matrix',          { items: [] }],
      ['POST',   `/api/price-matrix/${customerId}/save-all-safe`,     'save-all own matrix',      { items: [] }],
      ['POST',   `/api/price-matrix/${customerId}/catalog`,           'write own catalog',        { product_ids: [productId] }],
      ['PUT',    `/api/price-matrix/${customerId}/catalog/reorder`,   'reorder own catalog',      { product_ids: [productId] }],
      ['PUT',    `/api/price-matrix/${customerId}/categories/reorder`,'reorder own categories',   { ids: [cpcId] }],
      ['POST',   `/api/price-matrix/copy`,                            'copy matrix between customers', { from_customer_id: customerId, to_customer_id: customerId }],
      ['PUT',    `/api/products/customer-prices/${customerId}/${productId}`, 'set own product price', { sale_price: 1, effective_from: '2030-01-01' }],
    ];

    console.log('-- CUSTOMER (own data) -> 403 on every price write --');
    for (const [method, path, label, body] of WRITES) {
      const s = await call(method, path, 'CUSTOMER', customerId, body);
      ok(s === 403, `${label}: 403`, s);
    }

    console.log('\n-- the price survived every attempt --');
    {
      const [[row]] = await pool.query(
        `SELECT sale_price FROM customer_price_book_items WHERE price_book_id=? AND product_id=?`,
        [bookId, productId]);
      ok(row && Number(row.sale_price) === 500000,
        'price book still holds the shop-set price (500,000)', row && row.sale_price);
      // customer_price_books soft-deletes via `status`, not del_flg.
      const [[book]] = await pool.query(`SELECT status FROM customer_price_books WHERE id=?`, [bookId]);
      ok(book && String(book.status || '').toUpperCase() !== 'DELETED',
        'price book was not deleted by the customer', book);
      const [[cpcRow]] = await pool.query(`SELECT COUNT(*) cnt FROM customer_price_categories WHERE id=?`, [cpcId]);
      ok(Number(cpcRow.cnt) === 1, 'price category was not deleted by the customer');
    }

    console.log('\n-- unauthenticated -> 401 --');
    for (const [method, path, label, body] of WRITES.slice(0, 4)) {
      const s = await call(method, path, null, null, body);
      ok(s === 401, `${label}: no token -> 401`, s);
    }

    console.log('\n-- STAFF still has full write access (shop workflow intact) --');
    {
      const s = await call('PUT', `/api/price-matrix/books/${bookId}`, 'STAFF', null,
        { items: [{ product_id: productId, sale_price: 500000, in_catalog: true }] });
      ok(s === 200, 'STAFF can still update a price book', s);
    }

    console.log('\n-- CUSTOMER reads still work (portal unaffected) --');
    {
      const reads = [
        ['GET', `/api/price-matrix/${customerId}/categories`, 'read own categories'],
        // category_id is a required query param on these two — without it both
        // STAFF and CUSTOMER get an identical 400 ("Thiếu danh mục hàng hóa"),
        // which is a validation error, not an authorization one.
        ['GET', `/api/price-matrix/${customerId}/books?category_id=${catId}`, 'read own books'],
        ['GET', `/api/price-matrix/books/${bookId}`, 'read own book'],
        ['GET', `/api/price-matrix/${customerId}?category_id=${catId}`, 'read own matrix'],
      ];
      for (const [method, path, label] of reads) {
        const s = await call(method, path, 'CUSTOMER', customerId);
        ok(s === 200, `${label}: 200`, s);
      }
      const s = await call('POST', `/api/price-matrix/${customerId}/effective-prices`, 'CUSTOMER', customerId,
        { product_ids: [productId], order_date: '2026-01-01' });
      ok(s === 200, 'effective-prices lookup still works for CUSTOMER', s);
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } finally {
    if (productId) {
      await pool.query(`DELETE FROM customer_price_book_items WHERE product_id=?`, [productId]).catch(() => {});
      await pool.query(`DELETE FROM products WHERE id=?`, [productId]).catch(() => {});
    }
    if (cpcId) {
      await pool.query(`DELETE FROM customer_price_books WHERE customer_price_category_id=?`, [cpcId]).catch(() => {});
      await pool.query(`DELETE FROM customer_price_categories WHERE id=?`, [cpcId]).catch(() => {});
    }
    if (customerId) {
      await pool.query(`DELETE FROM customer_product_prices WHERE customer_id=?`, [customerId]).catch(() => {});
      await pool.query(`DELETE FROM customer_product_catalogs WHERE customer_id=?`, [customerId]).catch(() => {});
      await pool.query(`DELETE FROM price_change_logs WHERE customer_id=?`, [customerId]).catch(() => {});
      await pool.query(`DELETE FROM customers WHERE id=?`, [customerId]).catch(() => {});
    }
    if (catId) await pool.query(`DELETE FROM product_categories WHERE id=?`, [catId]).catch(() => {});
    console.log('Cleanup done.');
    await pool.end();
  }
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => { console.error('FATAL', e); try { await pool.end(); } catch {} process.exit(1); });
