'use strict';
// S1G — Product Sales Domain Separation: verification.
//
// Proves products.sales_flow (which sales catalog/form a product belongs to)
// is now independent of products.inventory_mode (stock checking/movement/
// ledger/reversal), per the approved compatibility matrix:
//   CARCASS_POS    + NON_STOCK    -> allowed
//   INVENTORY_SALE + TRACK_STOCK  -> allowed
//   every other combination       -> rejected (HTTP 400)
//
// S1J: CARCASS_PART is retired as a current inventory_mode (products.inventory_mode
// is now a tightened ENUM('NON_STOCK','TRACK_STOCK')) — every case below that used
// to exercise CARCASS_POS+CARCASS_PART now uses CARCASS_POS+NON_STOCK, its sole
// current pairing.
//
// Self-cleaning: every customer/product/category/book/order created here is
// throwaway and removed in `finally`, regardless of pass/fail. No real
// customer data (Hồng Hiền or otherwise) is read or written by this script.

const pool = require('../src/config/db');
const ProductAgent = require('../src/agents/ProductAgent');
const OrderAgent = require('../src/agents/OrderAgent');
const PriceMatrixAgent = require('../src/agents/PriceMatrixAgent');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}
async function expectReject(fn, name, codeCheck) {
  try { await fn(); check(name, false, 'expected rejection, but it succeeded'); }
  catch (e) {
    const okStatus = (e.status === 400 || e.statusCode === 400);
    const okCode = codeCheck ? codeCheck(e.code) : true;
    check(name, okStatus && okCode, { status: e.status || e.statusCode, code: e.code, message: e.message });
  }
}

const cleanup = { orderIds: [], productIds: [], customerIds: [], priceCategoryIds: [], bookIds: [], productCategoryIds: [] };
const adminUser = () => ({ id: null, role: 'ADMIN' });
const billItem = (p, qty) => ({ product_id: p.id, product_name: p.name, unit: 'kg', quantity: qty });

// A fresh throwaway product_categories row per call — never reuse a shared
// existing category, since two supposedly-independent test categories (e.g.
// one CARCASS_POS, one INVENTORY_SALE) must never collapse onto the same
// category_id, or setupCategory()'s "already exists" short-circuit would
// silently keep the first call's sales_flow classification for both.
async function makeCategory() {
  const [ins] = await pool.query(
    `INSERT INTO product_categories(name,sort_order,is_active,del_flg) VALUES(?,?,1,0)`,
    [`S1G TESTCAT ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, 999]
  );
  cleanup.productCategoryIds.push(ins.insertId);
  return ins.insertId;
}
async function makeCustomer(label) {
  const [ins] = await pool.query(
    `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type,partner_type)
     VALUES(?,?,?,?,?,?,?,?,2)`,
    [`S1GTEST-${label}-${Date.now()}`, `S1G Test ${label}`, '0', 'test', 'PRIVATE_PRICE', 0, 0, 'SOLAR']
  );
  cleanup.customerIds.push(ins.insertId);
  return ins.insertId;
}
// categoryId: pass an explicit one when this product must share a category
// with other products in the same test (e.g. two products priced together
// under one Price Category) — omitted creates a fresh throwaway category.
async function makeProduct(label, salesFlow, inventoryMode, { stock = 0, allowNegativeStock = 0, categoryId = null } = {}) {
  const tag = `S1G ${label} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const catId = categoryId || await makeCategory();
  await ProductAgent.addProduct({
    name: tag, unit: 'kg', category_id: catId, sales_flow: salesFlow, inventory_mode: inventoryMode,
    stock_quantity: stock, allow_negative_stock: allowNegativeStock
  });
  const [[created]] = await pool.query(`SELECT * FROM products WHERE name=? LIMIT 1`, [tag]);
  cleanup.productIds.push(created.id);
  return created;
}
// Directly inserts a row bypassing ProductAgent — simulates a genuine legacy
// product that predates S1G (sales_flow=NULL), which ProductAgent itself can
// no longer create since sales_flow is now mandatory on every new product.
async function makeLegacyProduct(label, inventoryMode, categoryId = null) {
  const tag = `S1G LEGACY ${label} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const catId = categoryId || await makeCategory();
  const [ins] = await pool.query(
    `INSERT INTO products(category_id,product_code,name,unit,default_sale_price,default_purchase_price,low_stock_threshold,is_active,del_flg,inventory_mode,allow_negative_stock,sales_flow)
     VALUES(?,?,?,?,?,?,?,1,0,?,0,NULL)`,
    [catId, `S1GLEG${Date.now()}`, tag, 'kg', 10000, 0, 5, inventoryMode]
  );
  cleanup.productIds.push(ins.insertId);
  const [[created]] = await pool.query(`SELECT * FROM products WHERE id=?`, [ins.insertId]);
  return created;
}
async function setupCategory(customerId, categoryId, salesFlow) {
  const cpc = await PriceMatrixAgent.createCustomerPriceCategory(customerId, categoryId, { sales_flow: salesFlow });
  cleanup.priceCategoryIds.push(cpc.id);
  return cpc;
}
// saveMatrix()/upsertBook() replace ALL items of the book version matching
// (category, effective_from) on every call — so pricing N products under the
// SAME category+date must be a single saveMatrix() call with all N items, never
// N separate calls (each of which would wipe out the previous call's items).
async function priceProducts(customerId, categoryId, productsWithPrices) {
  await PriceMatrixAgent.saveMatrix(
    customerId,
    productsWithPrices.map(([product, price]) => ({ product_id: product.id, private_price: price, in_catalog: true })),
    null, { effective_from: '2025-01-01', effective_calendar_type: 'SOLAR' }, categoryId
  );
  const [books] = await pool.query(`SELECT id FROM customer_price_books WHERE customer_id=? AND category_id=?`, [customerId, categoryId]);
  books.forEach(b => cleanup.bookIds.push(b.id));
}
async function priceProduct(customerId, categoryId, product, price) {
  return priceProducts(customerId, categoryId, [[product, price]]);
}

async function main() {
  try {
    // ══════════════════ 1-7: Product create-time compatibility matrix ══════════════════
    {
      // S1J: CARCASS_PART is retired — creating a CARCASS_POS product with it
      // must be rejected (VALID_INVENTORY_MODE_FILTERS no longer includes it),
      // not silently accepted as it was pre-S1J.
      await expectReject(
        () => ProductAgent.addProduct({ name: `S1G T1 ${Date.now()}`, unit: 'kg', sales_flow: 'CARCASS_POS', inventory_mode: 'CARCASS_PART' }),
        '1. New CARCASS_POS + CARCASS_PART (retired value): rejected',
        c => c === 'PRODUCT_INVENTORY_MODE_REQUIRED'
      );

      const p2 = await makeProduct('T2', 'CARCASS_POS', 'NON_STOCK');
      check('2. New CARCASS_POS + NON_STOCK: allowed', p2.sales_flow === 'CARCASS_POS' && p2.inventory_mode === 'NON_STOCK', p2);

      await expectReject(
        () => ProductAgent.addProduct({ name: `S1G T3 ${Date.now()}`, unit: 'kg', sales_flow: 'CARCASS_POS', inventory_mode: 'TRACK_STOCK' }),
        '3. New CARCASS_POS + TRACK_STOCK: rejected',
        c => c === 'PRODUCT_SALES_FLOW_INVENTORY_MODE_MISMATCH'
      );

      const p4 = await makeProduct('T4', 'INVENTORY_SALE', 'TRACK_STOCK');
      check('4. New INVENTORY_SALE + TRACK_STOCK: allowed', p4.sales_flow === 'INVENTORY_SALE' && p4.inventory_mode === 'TRACK_STOCK', p4);

      await expectReject(
        () => ProductAgent.addProduct({ name: `S1G T5 ${Date.now()}`, unit: 'kg', sales_flow: 'INVENTORY_SALE', inventory_mode: 'NON_STOCK' }),
        '5. INVENTORY_SALE + NON_STOCK: rejected',
        c => c === 'PRODUCT_SALES_FLOW_INVENTORY_MODE_MISMATCH'
      );

      await expectReject(
        () => ProductAgent.addProduct({ name: `S1G T6 ${Date.now()}`, unit: 'kg', sales_flow: 'INVENTORY_SALE', inventory_mode: 'CARCASS_PART' }),
        '6. INVENTORY_SALE + CARCASS_PART (retired value): rejected',
        // S1J: CARCASS_PART fails VALID_INVENTORY_MODE_FILTERS before combo
        // validation is ever reached — PRODUCT_INVENTORY_MODE_REQUIRED, not MISMATCH.
        c => c === 'PRODUCT_INVENTORY_MODE_REQUIRED'
      );

      await expectReject(
        () => ProductAgent.addProduct({ name: `S1G T7 ${Date.now()}`, unit: 'kg', inventory_mode: 'CARCASS_PART' }),
        '7. New Product without sales_flow: rejected',
        c => c === 'PRODUCT_SALES_FLOW_REQUIRED'
      );
    }

    // ══════════════════ 8: Legacy product with sales_flow=NULL ══════════════════
    let legacyCarcass, legacyCustomer, legacyCategoryId;
    {
      legacyCarcass = await makeLegacyProduct('T8', 'NON_STOCK');
      check('8a. Legacy product (sales_flow=NULL) remains readable', legacyCarcass.sales_flow === null, legacyCarcass);
      const [listed] = await pool.query(`SELECT id FROM products WHERE id=?`, [legacyCarcass.id]);
      check('8b. Legacy product still returned by a plain SELECT (read path unaffected)', listed.length === 1);

      legacyCustomer = await makeCustomer('T8');
      legacyCategoryId = await makeCategory();
      await setupCategory(legacyCustomer, legacyCategoryId, null);
      // Re-point the legacy product at this test category so it can be priced/ordered.
      await pool.query(`UPDATE products SET category_id=? WHERE id=?`, [legacyCategoryId, legacyCarcass.id]);
      await priceProduct(legacyCustomer, legacyCategoryId, legacyCarcass, 50000);

      let threw = null;
      try {
        await OrderAgent.create({ customer_id: legacyCustomer, order_date: '2025-06-01', items: [billItem(legacyCarcass, 1)] }, adminUser());
      } catch (e) { threw = e; }
      check('8c. Legacy product (sales_flow=NULL) cannot enter a NEW bill until classified',
        threw && (threw.status === 400 || threw.statusCode === 400) && threw.code === 'PRODUCT_SALES_FLOW_NOT_CLASSIFIED', threw && { code: threw.code, message: threw.message });
    }

    // ══════════════════ 9/11/12: CreateOrder catalog (CARCASS_POS) — synthetic Book #7/#126-shaped reconciliation ══════════════════
    {
      const customerId = await makeCustomer('T9');
      const categoryId = await makeCategory();
      await setupCategory(customerId, categoryId, 'CARCASS_POS');

      const carcassPart = await makeProduct('T9-carcass', 'CARCASS_POS', 'NON_STOCK', { categoryId });
      const legacyNonStock = await makeLegacyProduct('T9-legacy-nonstock', 'NON_STOCK', categoryId); // unclassified, category-compat
      const invSaleProduct = await makeProduct('T9-invsale', 'INVENTORY_SALE', 'TRACK_STOCK', { categoryId });

      await priceProducts(customerId, categoryId, [[carcassPart, 100000], [legacyNonStock, 80000]]);
      // invSaleProduct deliberately NOT priced under this CARCASS_POS category —
      // it belongs to a different flow entirely; the catalog filter must exclude
      // it outright regardless of price-book membership.

      const catalog = await PriceMatrixAgent.customerCatalogForOrder(customerId, categoryId, null, '2025-06-01', 'CARCASS_POS');
      const ids = catalog.products.map(p => Number(p.product_id));
      check('9a. CreateOrder catalog includes CARCASS_POS + NON_STOCK product', ids.includes(carcassPart.id), ids);
      check('9b. CreateOrder catalog includes approved legacy NON_STOCK (sales_flow=NULL) product', ids.includes(legacyNonStock.id), ids);
      check('9c. CreateOrder catalog excludes INVENTORY_SALE product', !ids.includes(invSaleProduct.id), ids);

      // 11/12: Book #7/#126-shaped reconciliation — warehouse products excluded regardless of price-book presence.
      check('11/12. Warehouse-flow product excluded from Bò Xô catalog reconciliation (mirrors Book #7/#126 expectation)', !ids.includes(invSaleProduct.id));
    }

    // ══════════════════ 10: InventorySales catalog (INVENTORY_SALE) ══════════════════
    {
      const customerId = await makeCustomer('T10');
      const categoryId = await makeCategory();
      await setupCategory(customerId, categoryId, 'INVENTORY_SALE');

      const trackStock = await makeProduct('T10-track', 'INVENTORY_SALE', 'TRACK_STOCK', { stock: 100, categoryId });
      const carcassProduct = await makeProduct('T10-carcass', 'CARCASS_POS', 'NON_STOCK', { categoryId });
      const legacyProduct = await makeLegacyProduct('T10-legacy', 'TRACK_STOCK', categoryId);

      await priceProduct(customerId, categoryId, trackStock, 20000);

      const catalog = await PriceMatrixAgent.customerCatalogForOrder(customerId, categoryId, 'TRACK_STOCK', '2025-06-01', 'INVENTORY_SALE');
      const ids = catalog.products.map(p => Number(p.product_id));
      check('10a. InventorySales catalog returns the INVENTORY_SALE+TRACK_STOCK product', ids.includes(trackStock.id), ids);
      check('10b. InventorySales catalog excludes a CARCASS_POS product', !ids.includes(carcassProduct.id), ids);
      check('10c. InventorySales catalog excludes a sales_flow=NULL legacy product (no legacy allowance for INVENTORY_SALE)', !ids.includes(legacyProduct.id), ids);
    }

    // ══════════════════ 13/14/15/16/17: bill behavior (CARCASS-only, INVENTORY-only, Mixed) ══════════════════
    {
      const customerId = await makeCustomer('T1317');
      const carcassCatId = await makeCategory();
      await setupCategory(customerId, carcassCatId, 'CARCASS_POS');
      const invCatId = await makeCategory();
      await setupCategory(customerId, invCatId, 'INVENTORY_SALE');

      const carcassProduct = await makeProduct('T13-carcass', 'CARCASS_POS', 'NON_STOCK', { categoryId: carcassCatId });
      await priceProduct(customerId, carcassCatId, carcassProduct, 90000);

      // ---- 13: CARCASS bill -> no stock movement ----
      {
        const [[before]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [carcassProduct.id]);
        const r = await OrderAgent.create({ customer_id: customerId, order_date: '2025-06-01', items: [billItem(carcassProduct, 3)] }, adminUser());
        cleanup.orderIds.push(r.order_id);
        const [[item]] = await pool.query(`SELECT sales_flow, inventory_mode, stock_checked FROM order_items WHERE order_id=?`, [r.order_id]);
        const [[after]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [carcassProduct.id]);
        check('13a. CARCASS bill: order_items.sales_flow = CARCASS_POS (from Product)', item.sales_flow === 'CARCASS_POS', item);
        check('13b. CARCASS bill: stock_checked=0 (no Inventory OUT)', Number(item.stock_checked) === 0, item);
        check('13c. CARCASS bill: stock_quantity unchanged', Number(before.stock_quantity) === Number(after.stock_quantity), { before, after });
      }

      // ---- 14: INVENTORY bill -> Inventory OUT and ledger correct ----
      const trackStock = await makeProduct('T14-track', 'INVENTORY_SALE', 'TRACK_STOCK', { stock: 50, categoryId: invCatId });
      await priceProduct(customerId, invCatId, trackStock, 15000);
      {
        const [[before]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [trackStock.id]);
        const r = await OrderAgent.create({ customer_id: customerId, order_date: '2025-06-01', items: [billItem(trackStock, 10)] }, adminUser());
        cleanup.orderIds.push(r.order_id);
        const [[item]] = await pool.query(`SELECT sales_flow, inventory_mode, stock_checked FROM order_items WHERE order_id=?`, [r.order_id]);
        const [[after]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [trackStock.id]);
        const [[ledger]] = await pool.query(`SELECT SUM(quantity) qty FROM stock_transactions WHERE product_id=? AND type='OUT' AND reference_type='SALE' AND reference_id=?`, [trackStock.id, r.order_id]);
        check('14a. INVENTORY bill: order_items.sales_flow = INVENTORY_SALE (from Product)', item.sales_flow === 'INVENTORY_SALE', item);
        check('14b. INVENTORY bill: stock_checked=1', Number(item.stock_checked) === 1, item);
        check('14c. INVENTORY bill: stock_quantity decremented by 10', Number(before.stock_quantity) - Number(after.stock_quantity) === 10, { before, after });
        check('14d. INVENTORY bill: stock_transactions OUT ledger row matches quantity', Number(ledger.qty) === 10, ledger);
      }

      // ---- 15: Mixed bill -> per-item sales_flow from Product, one Order/debt lifecycle ----
      const carcassProduct2 = await makeProduct('T15-carcass', 'CARCASS_POS', 'NON_STOCK', { categoryId: carcassCatId });
      await priceProduct(customerId, carcassCatId, carcassProduct2, 70000);
      const trackStock2 = await makeProduct('T15-track', 'INVENTORY_SALE', 'TRACK_STOCK', { stock: 30, categoryId: invCatId });
      await priceProduct(customerId, invCatId, trackStock2, 12000);
      let mixedOrderId;
      {
        const [[beforeCarcass]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [carcassProduct2.id]);
        const [[beforeTrack]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [trackStock2.id]);
        const r = await OrderAgent.create({
          customer_id: customerId, order_date: '2025-06-01',
          items: [billItem(carcassProduct2, 2), billItem(trackStock2, 5)]
        }, adminUser());
        mixedOrderId = r.order_id;
        cleanup.orderIds.push(r.order_id);
        const [items] = await pool.query(`SELECT product_id, sales_flow, stock_checked FROM order_items WHERE order_id=?`, [r.order_id]);
        const carcassLine = items.find(i => Number(i.product_id) === carcassProduct2.id);
        const trackLine = items.find(i => Number(i.product_id) === trackStock2.id);
        const [[order]] = await pool.query(`SELECT sales_flow FROM orders WHERE id=?`, [r.order_id]);
        const [[afterCarcass]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [carcassProduct2.id]);
        const [[afterTrack]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [trackStock2.id]);
        const [debtRows] = await pool.query(`SELECT COUNT(*) c FROM debt_transactions WHERE order_id=?`, [r.order_id]);
        check('15a. Mixed bill: order header sales_flow = MIXED', order.sales_flow === 'MIXED', order);
        check('15b. Mixed bill: carcass line sales_flow = CARCASS_POS, no stock deducted', carcassLine.sales_flow === 'CARCASS_POS' && Number(beforeCarcass.stock_quantity) === Number(afterCarcass.stock_quantity), { carcassLine, beforeCarcass, afterCarcass });
        check('15c. Mixed bill: warehouse line sales_flow = INVENTORY_SALE, stock deducted by 5', trackLine.sales_flow === 'INVENTORY_SALE' && Number(beforeTrack.stock_quantity) - Number(afterTrack.stock_quantity) === 5, { trackLine, beforeTrack, afterTrack });
        check('15d. Mixed bill: single Order lifecycle (one debt_transactions row for this order)', Number(debtRows[0].c) === 1, debtRows[0]);
      }

      // ---- 16: Insufficient inventory in Mixed bill -> whole transaction rolls back ----
      {
        const [[trackNow]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [trackStock2.id]);
        const overQty = Number(trackNow.stock_quantity) + 1000;
        const [[beforeOrders]] = await pool.query(`SELECT COUNT(*) c FROM orders WHERE customer_id=?`, [customerId]);
        let threw = null;
        try {
          await OrderAgent.create({
            customer_id: customerId, order_date: '2025-06-01',
            items: [billItem(carcassProduct2, 1), billItem(trackStock2, overQty)]
          }, adminUser());
        } catch (e) { threw = e; }
        const [[afterOrders]] = await pool.query(`SELECT COUNT(*) c FROM orders WHERE customer_id=?`, [customerId]);
        const [[trackAfter]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [trackStock2.id]);
        check('16a. Insufficient inventory in Mixed bill: rejected', !!threw, threw && threw.message);
        check('16b. Insufficient inventory in Mixed bill: no new Order row persisted (full rollback)', Number(afterOrders.c) === Number(beforeOrders.c), { before: beforeOrders.c, after: afterOrders.c });
        check('16c. Insufficient inventory in Mixed bill: stock_quantity unchanged (full rollback)', Number(trackAfter.stock_quantity) === Number(trackNow.stock_quantity), trackAfter);
      }

      // ---- 17: Cancel Mixed bill -> warehouse stock restored, carcass product unaffected ----
      {
        const [[beforeCarcass]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [carcassProduct2.id]);
        const [[beforeTrack]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [trackStock2.id]);
        await OrderAgent.cancel(mixedOrderId, { reason: 'S1G verify cleanup' }, adminUser());
        const [[afterCarcass]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [carcassProduct2.id]);
        const [[afterTrack]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [trackStock2.id]);
        check('17a. Cancel Mixed bill: warehouse stock restored (+5 back)', Number(afterTrack.stock_quantity) - Number(beforeTrack.stock_quantity) === 5, { beforeTrack, afterTrack });
        check('17b. Cancel Mixed bill: carcass product stock unaffected', Number(afterCarcass.stock_quantity) === Number(beforeCarcass.stock_quantity), { beforeCarcass, afterCarcass });
      }
    }

    // ══════════════════ 18: Product mode mutation — invalid combo rejected on edit ══════════════════
    {
      const p = await makeProduct('T18', 'CARCASS_POS', 'NON_STOCK');
      // S1J: both values individually valid, but not a valid pairing — properly
      // exercises PRODUCT_SALES_FLOW_INVENTORY_MODE_MISMATCH (was previously
      // tested with the now-retired CARCASS_PART value, which fails one step
      // earlier at PRODUCT_INVENTORY_MODE_REQUIRED — see test 6 above for that).
      await expectReject(
        () => ProductAgent.updateProduct(p.id, { name: p.name, category_id: p.category_id, sales_flow: 'INVENTORY_SALE', inventory_mode: 'NON_STOCK' }),
        '18. Product mode mutation: invalid sales_flow/inventory_mode combination rejected clearly',
        c => c === 'PRODUCT_SALES_FLOW_INVENTORY_MODE_MISMATCH'
      );
    }

    // ══════════════════ 19: Price Category mismatch — rejected ══════════════════
    {
      const customerId = await makeCustomer('T19');
      const categoryId = await makeCategory();
      await setupCategory(customerId, categoryId, 'INVENTORY_SALE');
      const carcassProduct = await makeProduct('T19-carcass', 'CARCASS_POS', 'NON_STOCK');
      await pool.query(`UPDATE products SET category_id=? WHERE id=?`, [categoryId, carcassProduct.id]);

      await expectReject(
        () => PriceMatrixAgent.saveMatrix(customerId, [{ product_id: carcassProduct.id, private_price: 50000, in_catalog: true }], null,
          { effective_from: '2025-01-01', effective_calendar_type: 'SOLAR' }, categoryId),
        '19. Price Category mismatch (CARCASS_POS product into INVENTORY_SALE category): rejected',
        c => c === 'PRICE_CATEGORY_SALES_FLOW_MISMATCH'
      );
    }

    // ══════════════════ 20: Existing Bò Xô price/effective-date regression ══════════════════
    {
      const customerId = await makeCustomer('T20');
      const categoryId = await makeCategory();
      await setupCategory(customerId, categoryId, 'CARCASS_POS');
      const p = await makeProduct('T20', 'CARCASS_POS', 'NON_STOCK', { categoryId });

      await PriceMatrixAgent.saveMatrix(customerId, [{ product_id: p.id, private_price: 10000, in_catalog: true }], null,
        { effective_from: '2025-01-01', effective_calendar_type: 'SOLAR' }, categoryId);
      await PriceMatrixAgent.saveMatrix(customerId, [{ product_id: p.id, private_price: 20000, in_catalog: true }], null,
        { effective_from: '2025-01-15', effective_calendar_type: 'SOLAR' }, categoryId);
      const [books] = await pool.query(`SELECT id, effective_from FROM customer_price_books WHERE customer_id=? AND category_id=? ORDER BY effective_from`, [customerId, categoryId]);
      books.forEach(b => cleanup.bookIds.push(b.id));
      const bookA = books.find(b => b.effective_from === '2025-01-01');
      const bookB = books.find(b => b.effective_from === '2025-01-15');

      const PriceBookService = require('../src/services/PriceBookService');
      const price14 = await PriceBookService.getEffectivePrice(customerId, p.id, '2025-01-14', pool, 'SOLAR', '');
      const price20 = await PriceBookService.getEffectivePrice(customerId, p.id, '2025-01-20', pool, 'SOLAR', '');
      check('20a. Bill 14/01 -> Book A (effective-date resolution unaffected by S1G)', price14.price_book_id === bookA.id, price14);
      check('20b. Bill after 15/01 -> Book B', price20.price_book_id === bookB.id, price20);

      const r = await OrderAgent.create({ customer_id: customerId, order_date: '2025-01-20', items: [billItem(p, 1)] }, adminUser());
      cleanup.orderIds.push(r.order_id);
      const [[item]] = await pool.query(`SELECT sale_price, price_type, sales_flow FROM order_items WHERE order_id=?`, [r.order_id]);
      check('20c. Existing Bò Xô price regression: correct price (20000) and PRICE_BOOK type', Number(item.sale_price) === 20000 && item.price_type === 'PRICE_BOOK', item);
      check('20d. Existing Bò Xô price regression: order_items.sales_flow persisted correctly', item.sales_flow === 'CARCASS_POS', item);
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
      await pool.query(`DELETE FROM customer_product_catalogs WHERE product_id=?`, [id]).catch(() => {});
      await pool.query(`DELETE FROM price_change_logs WHERE product_id=?`, [id]).catch(() => {});
      await pool.query(`DELETE FROM products WHERE id=?`, [id]).catch(() => {});
    }
    for (const categoryId of cleanup.productCategoryIds) {
      await pool.query(`DELETE FROM product_categories WHERE id=?`, [categoryId]).catch(() => {});
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
    console.log('Cleanup done. No real customer data (Hồng Hiền or otherwise) was read or written.');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
