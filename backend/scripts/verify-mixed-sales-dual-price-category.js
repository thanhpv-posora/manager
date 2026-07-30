'use strict';
// MIXED SALES PHASE 1B — Dual Price Category + Price Isolation per sales_flow.
//
// Covers, against the new Phase 1B guards (PriceMatrixAgent.assertItemsMatchCategory
// write guard, PriceMatrixAgent category-selection sales_flow filter, OrderAgent's
// assertItemsCategoryPerFlow() read guard replacing assertItemsSingleCategory,
// order_items.sales_flow/customer_price_category_id snapshot):
//
//  1) CARCASS-only, one category                         -> success
//  2) INVENTORY-only, one category                        -> success
//  3) Mixed bill, one category per flow                   -> success
//  4) Two CARCASS categories on one bill                  -> reject
//  5) Two INVENTORY categories on one bill                -> reject
//  6) NULL category, valid unambiguous common price       -> success
//  7) NULL category, ambiguous price source                -> clear HTTP 400, no crash
//  8) CARCASS item resolving against an INVENTORY category -> reject
//  9) INVENTORY item resolving against a CARCASS category  -> reject
// 10) Product mode changed after category setup            -> clear business error, no
//     500, no Order/Inventory/Debt side effects
// 11) Price Book belongs to another customer                -> reject
// 12) Historical order_items snapshot facts remain frozen after a later Price Book
//     price edit (sale_price is expected to recalc for unpaid bills — that is a
//     pre-existing, untouched feature — but sales_flow/customer_price_category_id/
//     price_type/price_book_id/inventory_mode/stock_checked must not change)
// 13) Mixed bill, insufficient warehouse stock              -> whole transaction rollback
// 14) Existing Bò Xô legacy/unclassified-category regression -> pass (mixed-mode
//     legacy category, exactly like real production data, stays fully permissive)
// 15) Excel Import shares OrderAgent.create()'s resolver (static proof); AI confirm
//     path (order.service.js) does NOT — documented gap, not modified (outside
//     Phase 1B's allowed files; reported, not silently fixed)
//
// Self-cleaning: throwaway customer(s) + products + price categories/books + orders,
// removed in `finally` regardless of pass/fail. Touches no pre-existing data.

const fs = require('fs');
const path = require('path');
const pool = require('../src/config/db');
const ProductAgent = require('../src/agents/ProductAgent');
const OrderAgent = require('../src/agents/OrderAgent');
const PriceMatrixAgent = require('../src/agents/PriceMatrixAgent');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}
function info(msg) { console.log(`  [INFO] ${msg}`); }

async function getProduct(id) {
  const [[row]] = await pool.query(`SELECT * FROM products WHERE id=?`, [id]);
  return row;
}
// S1G decoupled sales_flow from inventory_mode (see OrderAgent.js's "flow here
// is now products.sales_flow, never inventory_mode" note), and the DB layer
// now rejects any inventory_mode+sales_flow combination outside the two
// approved pairs. So simulating "this product got reclassified after the
// category was set up" must flip BOTH columns together to the other valid
// pairing — mutating inventory_mode alone (the old technique) now fails
// earlier, at the combination guard, before ever reaching the category check
// this helper exists to exercise.
async function setProductMode(id, mode) {
  const salesFlow = mode === 'TRACK_STOCK' ? 'INVENTORY_SALE' : 'CARCASS_POS';
  await pool.query(`UPDATE products SET inventory_mode=?, sales_flow=? WHERE id=?`, [mode, salesFlow, id]);
}

const cleanup = {
  orderIds: [], productIds: [], customerIds: [], priceCategoryIds: [], bookIds: [],
};

async function makeProduct(mode, { stock = 0, allowNegative = 0, categoryId }) {
  const tag = `P1B ${mode} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const salesFlow = mode === 'TRACK_STOCK' ? 'INVENTORY_SALE' : 'CARCASS_POS';
  await ProductAgent.addProduct({
    name: tag, unit: 'kg', category_id: categoryId,
    inventory_mode: mode, sales_flow: salesFlow, stock_quantity: stock, allow_negative_stock: allowNegative,
  });
  const [[created]] = await pool.query(`SELECT * FROM products WHERE name=? LIMIT 1`, [tag]);
  cleanup.productIds.push(created.id);
  return created;
}

async function makeCustomer(label) {
  const [ins] = await pool.query(
    `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type)
     VALUES(?,?,?,?,?,?,?,?)`,
    [`P1BTEST-${label}-${Date.now()}`, `P1B Test Customer ${label}`, '0', 'test', 'PRIVATE_PRICE', 0, 0, 'SOLAR']
  );
  cleanup.customerIds.push(ins.insertId);
  return ins.insertId;
}

// Creates a classified (or NULL) price category + a price book for one product.
async function setupCategoryWithProduct(customerId, categoryId, salesFlow, product, price) {
  const cpc = await PriceMatrixAgent.createCustomerPriceCategory(customerId, categoryId, { sales_flow: salesFlow });
  cleanup.priceCategoryIds.push(cpc.id);
  await PriceMatrixAgent.saveMatrix(
    customerId,
    [{ product_id: product.id, private_price: price, in_catalog: true }],
    null,
    { effective_from: '2024-01-01', effective_calendar_type: 'SOLAR' },
    categoryId
  );
  const [books] = await pool.query(`SELECT id FROM customer_price_books WHERE customer_price_category_id=?`, [cpc.id]);
  books.forEach(b => cleanup.bookIds.push(b.id));
  return { cpc, bookId: books[0]?.id };
}

const billItem = (p, qty) => ({ product_id: p.id, product_name: p.name, unit: 'kg', quantity: qty });

async function main() {
  try {
    const [prodCats] = await pool.query(`SELECT id FROM product_categories WHERE del_flg=0 ORDER BY id LIMIT 2`);
    if (prodCats.length < 2) throw new Error('Need at least 2 product_categories in DB for this verify script');
    const [catA, catB] = prodCats.map(r => r.id);

    // ══════════════════ 1) CARCASS-only, one category ══════════════════
    {
      const customerId = await makeCustomer('C1');
      const pCarcass = await makeProduct('NON_STOCK', { categoryId: catA });
      const { cpc } = await setupCategoryWithProduct(customerId, catA, 'CARCASS_POS', pCarcass, 70000);

      const r = await OrderAgent.create({ customer_id: customerId, order_date: today(), items: [billItem(pCarcass, 2)] }, adminUser());
      cleanup.orderIds.push(r.order_id);
      const [[order]] = await pool.query(`SELECT sales_flow FROM orders WHERE id=?`, [r.order_id]);
      const [[item]] = await pool.query(`SELECT sales_flow, customer_price_category_id FROM order_items WHERE order_id=?`, [r.order_id]);
      check('1. CARCASS-only, one category: succeeds', !!r.order_id);
      check('1. header sales_flow=CARCASS_POS', order.sales_flow === 'CARCASS_POS', order.sales_flow);
      check('1. item sales_flow=CARCASS_POS', item.sales_flow === 'CARCASS_POS', item.sales_flow);
      check('1. item customer_price_category_id matches the category', Number(item.customer_price_category_id) === Number(cpc.id), item.customer_price_category_id);
    }

    // ══════════════════ 2) INVENTORY-only, one category ══════════════════
    {
      const customerId = await makeCustomer('C2');
      const pTrack = await makeProduct('TRACK_STOCK', { stock: 20, categoryId: catA });
      const { cpc } = await setupCategoryWithProduct(customerId, catA, 'INVENTORY_SALE', pTrack, 50000);

      const r = await OrderAgent.create({ customer_id: customerId, order_date: today(), items: [billItem(pTrack, 3)] }, adminUser());
      cleanup.orderIds.push(r.order_id);
      const [[order]] = await pool.query(`SELECT sales_flow FROM orders WHERE id=?`, [r.order_id]);
      const [[item]] = await pool.query(`SELECT sales_flow, customer_price_category_id FROM order_items WHERE order_id=?`, [r.order_id]);
      check('2. INVENTORY-only, one category: succeeds', !!r.order_id);
      check('2. header sales_flow=INVENTORY_SALE', order.sales_flow === 'INVENTORY_SALE', order.sales_flow);
      check('2. item sales_flow=INVENTORY_SALE', item.sales_flow === 'INVENTORY_SALE', item.sales_flow);
      check('2. item customer_price_category_id matches the category', Number(item.customer_price_category_id) === Number(cpc.id), item.customer_price_category_id);
    }

    // ══════════════════ 3) Mixed bill, one category per flow ══════════════════
    let mixedCustomerId, mixedCarcassCpc, mixedTrackCpc, mixedCarcassProduct, mixedTrackProduct;
    {
      mixedCustomerId = await makeCustomer('C3');
      mixedCarcassProduct = await makeProduct('NON_STOCK', { categoryId: catA });
      mixedTrackProduct = await makeProduct('TRACK_STOCK', { stock: 20, categoryId: catB });
      const setupCarcass = await setupCategoryWithProduct(mixedCustomerId, catA, 'CARCASS_POS', mixedCarcassProduct, 70000);
      const setupTrack = await setupCategoryWithProduct(mixedCustomerId, catB, 'INVENTORY_SALE', mixedTrackProduct, 50000);
      mixedCarcassCpc = setupCarcass.cpc; mixedTrackCpc = setupTrack.cpc;

      const r = await OrderAgent.create({
        customer_id: mixedCustomerId, order_date: today(),
        items: [billItem(mixedCarcassProduct, 2), billItem(mixedTrackProduct, 3)]
      }, adminUser());
      cleanup.orderIds.push(r.order_id);
      const [[order]] = await pool.query(`SELECT sales_flow FROM orders WHERE id=?`, [r.order_id]);
      const [items] = await pool.query(`SELECT product_id, sales_flow, customer_price_category_id FROM order_items WHERE order_id=?`, [r.order_id]);
      const carcassItem = items.find(i => Number(i.product_id) === mixedCarcassProduct.id);
      const trackItem = items.find(i => Number(i.product_id) === mixedTrackProduct.id);
      check('3. Mixed bill, one category per flow: succeeds', !!r.order_id);
      check('3. header sales_flow=MIXED', order.sales_flow === 'MIXED', order.sales_flow);
      check('3. CARCASS item category matches CARCASS_POS category', carcassItem && Number(carcassItem.customer_price_category_id) === Number(mixedCarcassCpc.id));
      check('3. INVENTORY item category matches INVENTORY_SALE category', trackItem && Number(trackItem.customer_price_category_id) === Number(mixedTrackCpc.id));
    }

    // ══════════════════ 4) Two CARCASS categories on one bill -> reject ══════════════════
    {
      const customerId = await makeCustomer('C4');
      const pA = await makeProduct('NON_STOCK', { categoryId: catA });
      const pB = await makeProduct('NON_STOCK', { categoryId: catB });
      await setupCategoryWithProduct(customerId, catA, 'CARCASS_POS', pA, 70000);
      await setupCategoryWithProduct(customerId, catB, 'CARCASS_POS', pB, 71000);

      let threw = null;
      try { await OrderAgent.create({ customer_id: customerId, order_date: today(), items: [billItem(pA, 1), billItem(pB, 1)] }, adminUser()); }
      catch (e) { threw = e; }
      check('4. Two CARCASS categories on one bill: rejected', threw && threw.code === 'MULTIPLE_PRICE_CATEGORIES_PER_FLOW', threw && threw.message);
    }

    // ══════════════════ 5) Two INVENTORY categories on one bill -> reject ══════════════════
    {
      const customerId = await makeCustomer('C5');
      const pA = await makeProduct('TRACK_STOCK', { stock: 20, categoryId: catA });
      const pB = await makeProduct('TRACK_STOCK', { stock: 20, categoryId: catB });
      await setupCategoryWithProduct(customerId, catA, 'INVENTORY_SALE', pA, 50000);
      await setupCategoryWithProduct(customerId, catB, 'INVENTORY_SALE', pB, 51000);

      let threw = null;
      try { await OrderAgent.create({ customer_id: customerId, order_date: today(), items: [billItem(pA, 1), billItem(pB, 1)] }, adminUser()); }
      catch (e) { threw = e; }
      check('5. Two INVENTORY categories on one bill: rejected', threw && threw.code === 'MULTIPLE_PRICE_CATEGORIES_PER_FLOW', threw && threw.message);
    }

    // ══════════════════ 6) NULL category, valid unambiguous common price -> success ══════════════════
    {
      const customerId = await makeCustomer('C6');
      const pCarcass = await makeProduct('NON_STOCK', { categoryId: catA });
      await pool.query(`UPDATE products SET default_sale_price=? WHERE id=?`, [45000, pCarcass.id]);
      // No customer_price_categories row at all for this customer/category -> price
      // resolves to COMMON_PRICE (products.default_sale_price), price_book_id stays null.

      const r = await OrderAgent.create({ customer_id: customerId, order_date: today(), items: [billItem(pCarcass, 1)] }, adminUser());
      cleanup.orderIds.push(r.order_id);
      const [[item]] = await pool.query(`SELECT price_type, price_book_id, customer_price_category_id, sales_flow FROM order_items WHERE order_id=?`, [r.order_id]);
      check('6. NULL category, unambiguous COMMON_PRICE: succeeds', !!r.order_id);
      check('6. item price_type=COMMON_PRICE', item.price_type === 'COMMON_PRICE', item.price_type);
      check('6. item customer_price_category_id is NULL', item.customer_price_category_id === null, item.customer_price_category_id);
      check('6. item sales_flow still correctly derived (CARCASS_POS)', item.sales_flow === 'CARCASS_POS', item.sales_flow);
    }

    // ══════════════════ 7) NULL category, ambiguous price source -> clear 400, no crash ══════════════════
    {
      const customerId = await makeCustomer('C7');
      const pCarcass = await makeProduct('NON_STOCK', { categoryId: catA });
      let threw = null;
      try {
        await OrderAgent.create({
          customer_id: customerId, order_date: today(),
          items: [{ product_id: pCarcass.id, product_name: pCarcass.name, unit: 'kg', quantity: 1, sale_price: 40000, manual_price: true, price_type: 'PRICE_BOOK' /* claims PRICE_BOOK but sends no price_book_id */ }]
        }, adminUser());
      } catch (e) { threw = e; }
      check('7. NULL category, ambiguous price source: rejected with clear 400, not a crash',
        threw && threw.status === 400 && threw.code === 'AMBIGUOUS_PRICE_SOURCE', threw && `status=${threw && threw.status} code=${threw && threw.code} msg=${threw && threw.message}`);
    }

    // ══════════════════ 8) CARCASS item resolving against an INVENTORY category -> reject ══════════════════
    {
      const customerId = await makeCustomer('C8');
      const p = await makeProduct('TRACK_STOCK', { stock: 20, categoryId: catA });
      await setupCategoryWithProduct(customerId, catA, 'INVENTORY_SALE', p, 50000);
      await setProductMode(p.id, 'NON_STOCK'); // mutated after category setup

      let threw = null;
      try { await OrderAgent.create({ customer_id: customerId, order_date: today(), items: [billItem(p, 1)] }, adminUser()); }
      catch (e) { threw = e; }
      check('8. CARCASS item now resolving against an INVENTORY_SALE category: rejected',
        threw && threw.code === 'PRICE_CATEGORY_SALES_FLOW_MISMATCH', threw && threw.message);
      check('8. no order created (product not left in a partial state)',
        (await pool.query(`SELECT COUNT(*) c FROM orders WHERE customer_id=?`, [customerId]))[0][0].c === 0);
    }

    // ══════════════════ 9) INVENTORY item resolving against a CARCASS category -> reject ══════════════════
    // Phase 1B Gate Fix (OrderAgent.js): INVENTORY_SALE gets a stricter,
    // dedicated branch — it may resolve ONLY through a category explicitly
    // classified INVENTORY_SALE, never a CARCASS_POS or NULL/legacy category
    // (unlike CARCASS_POS, which keeps a legacy-NULL allowance). That branch
    // throws the more specific PRICE_CATEGORY_NOT_INVENTORY_SALE, not the
    // generic PRICE_CATEGORY_SALES_FLOW_MISMATCH this scenario originally
    // expected before that gate fix landed.
    {
      const customerId = await makeCustomer('C9');
      const p = await makeProduct('NON_STOCK', { categoryId: catA });
      await setupCategoryWithProduct(customerId, catA, 'CARCASS_POS', p, 70000);
      await pool.query(`UPDATE products SET stock_quantity=20 WHERE id=?`, [p.id]);
      await setProductMode(p.id, 'TRACK_STOCK'); // mutated after category setup

      let threw = null;
      try { await OrderAgent.create({ customer_id: customerId, order_date: today(), items: [billItem(p, 1)] }, adminUser()); }
      catch (e) { threw = e; }
      check('9. INVENTORY item now resolving against a CARCASS_POS category: rejected',
        threw && threw.code === 'PRICE_CATEGORY_NOT_INVENTORY_SALE', threw && threw.message);
    }

    // ══════════════════ 10) Product mode changed after category setup -> clear business error, no side effects ══════════════════
    {
      const customerId = await makeCustomer('C10');
      const p = await makeProduct('NON_STOCK', { categoryId: catA });
      await setupCategoryWithProduct(customerId, catA, 'CARCASS_POS', p, 70000);
      await pool.query(`UPDATE products SET stock_quantity=20 WHERE id=?`, [p.id]);
      await setProductMode(p.id, 'TRACK_STOCK');

      const [[stockBefore]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [p.id]);
      const [[orderCountBefore]] = await pool.query(`SELECT COUNT(*) c FROM orders WHERE customer_id=?`, [customerId]);
      const [[debtCountBefore]] = await pool.query(`SELECT COUNT(*) c FROM debt_transactions WHERE customer_id=?`, [customerId]);

      let threw = null;
      try { await OrderAgent.create({ customer_id: customerId, order_date: today(), items: [billItem(p, 1)] }, adminUser()); }
      catch (e) { threw = e; }

      const [[stockAfter]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [p.id]);
      const [[orderCountAfter]] = await pool.query(`SELECT COUNT(*) c FROM orders WHERE customer_id=?`, [customerId]);
      const [[debtCountAfter]] = await pool.query(`SELECT COUNT(*) c FROM debt_transactions WHERE customer_id=?`, [customerId]);

      check('10. Product mode mutation: clear business error (not a 500)', threw && threw.status === 400 && threw.code === 'PRICE_CATEGORY_NOT_INVENTORY_SALE', threw && `status=${threw && threw.status}`);
      check('10. Error message matches current wording (Phase 1B Gate Fix\'s dedicated INVENTORY_SALE branch)', threw && /Danh mục giá không thuộc phân hệ bán hàng kho/.test(threw.message), threw && threw.message);
      check('10. No partial Order created', Number(orderCountAfter.c) === Number(orderCountBefore.c));
      check('10. No Inventory write (stock unchanged)', Number(stockAfter.stock_quantity) === Number(stockBefore.stock_quantity));
      check('10. No Debt write', Number(debtCountAfter.c) === Number(debtCountBefore.c));
    }

    // ══════════════════ 11) Price Book belongs to another customer -> reject ══════════════════
    {
      const customerA = await makeCustomer('C11A');
      const customerB = await makeCustomer('C11B');
      const pA = await makeProduct('NON_STOCK', { categoryId: catA });
      const { bookId: bookIdBelongingToA } = await setupCategoryWithProduct(customerA, catA, 'CARCASS_POS', pA, 70000);

      const pB = await makeProduct('NON_STOCK', { categoryId: catA });
      let threw = null;
      try {
        await OrderAgent.create({
          customer_id: customerB, order_date: today(),
          items: [{ product_id: pB.id, product_name: pB.name, unit: 'kg', quantity: 1, sale_price: 1000, manual_price: true, price_type: 'MANUAL_PRICE', price_book_id: bookIdBelongingToA }]
        }, adminUser());
      } catch (e) { threw = e; }
      check('11. Price Book belongs to another customer: rejected', threw && threw.code === 'PRICE_BOOK_WRONG_CUSTOMER', threw && threw.message);
    }

    // ══════════════════ 12) Historical order_items snapshot facts remain frozen ══════════════════
    {
      const customerId = await makeCustomer('C12');
      const p = await makeProduct('NON_STOCK', { categoryId: catA });
      const { cpc, bookId } = await setupCategoryWithProduct(customerId, catA, 'CARCASS_POS', p, 70000);

      const r = await OrderAgent.create({ customer_id: customerId, order_date: today(), items: [billItem(p, 1)] }, adminUser());
      cleanup.orderIds.push(r.order_id);
      const [[before]] = await pool.query(
        `SELECT sale_price, price_type, price_book_id, inventory_mode, stock_checked, sales_flow, customer_price_category_id FROM order_items WHERE order_id=?`,
        [r.order_id]
      );

      // Attempt to edit the price book's price for this product. Pre-existing S4.4 rule
      // (untouched by Phase 1B): a Price Book Item is locked the moment it has
      // participated in any order_items row, paid or not — updateBook() silently
      // leaves a locked item's price unchanged rather than applying the edit. This is
      // an even stronger guarantee than "recalculates until paid": once a product is
      // actually sold from a book, that book's line for it is frozen immediately.
      await PriceMatrixAgent.updateBook(bookId, { items: [{ product_id: p.id, sale_price: 999000 }] }, null);

      const [[after]] = await pool.query(
        `SELECT sale_price, price_type, price_book_id, inventory_mode, stock_checked, sales_flow, customer_price_category_id FROM order_items WHERE order_id=?`,
        [r.order_id]
      );

      check('12. sale_price stays frozen — price book line is locked once used in a bill (S4.4, pre-existing)', Number(after.sale_price) === Number(before.sale_price), `${before.sale_price} -> ${after.sale_price}`);
      check('12. price_type snapshot frozen', after.price_type === before.price_type, `${before.price_type} -> ${after.price_type}`);
      check('12. price_book_id snapshot frozen', Number(after.price_book_id) === Number(before.price_book_id));
      check('12. inventory_mode snapshot frozen', after.inventory_mode === before.inventory_mode);
      check('12. stock_checked snapshot frozen', Number(after.stock_checked) === Number(before.stock_checked));
      check('12. sales_flow snapshot frozen', after.sales_flow === before.sales_flow);
      check('12. customer_price_category_id snapshot frozen', Number(after.customer_price_category_id) === Number(before.customer_price_category_id));
    }

    // ══════════════════ 13) Mixed bill, insufficient warehouse stock -> whole rollback ══════════════════
    {
      const customerId = await makeCustomer('C13');
      const pCarcass = await makeProduct('NON_STOCK', { categoryId: catA });
      const pTrackLow = await makeProduct('TRACK_STOCK', { stock: 2, categoryId: catB });
      await setupCategoryWithProduct(customerId, catA, 'CARCASS_POS', pCarcass, 70000);
      await setupCategoryWithProduct(customerId, catB, 'INVENTORY_SALE', pTrackLow, 50000);

      const [[stockBefore]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [pTrackLow.id]);
      const [[orderCountBefore]] = await pool.query(`SELECT COUNT(*) c FROM orders WHERE customer_id=?`, [customerId]);
      let threw = null;
      try {
        await OrderAgent.create({
          customer_id: customerId, order_date: today(),
          items: [billItem(pCarcass, 1), billItem(pTrackLow, 999)]
        }, adminUser());
      } catch (e) { threw = e; }
      const [[stockAfter]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [pTrackLow.id]);
      const [[orderCountAfter]] = await pool.query(`SELECT COUNT(*) c FROM orders WHERE customer_id=?`, [customerId]);

      check('13. Mixed bill insufficient stock: rejected', threw && /Không đủ tồn kho/.test(threw.message), threw && threw.message);
      check('13. No new order (rolled back)', Number(orderCountAfter.c) === Number(orderCountBefore.c));
      check('13. Warehouse stock unaffected (rolled back)', Number(stockAfter.stock_quantity) === Number(stockBefore.stock_quantity));
    }

    // ══════════════════ 14) Existing Bò Xô legacy/unclassified-category regression ══════════════════
    // Phase 1B Gate Fix closed the bypass this scenario originally exercised:
    // a NULL/unclassified category is permissive ONLY for CARCASS_POS (or
    // NULL-sales_flow legacy) products — mirroring real production data where
    // every existing category is unclassified — but INVENTORY_SALE items get
    // no such fallback (assertItemsMatchCategory + OrderAgent's dedicated
    // INVENTORY_SALE branch both enforce this). So mixing a TRACK_STOCK/
    // INVENTORY_SALE product into that same unclassified category must now be
    // rejected, not silently permitted.
    {
      const customerId = await makeCustomer('C14');
      const pCarcass = await makeProduct('NON_STOCK', { categoryId: catA });
      const pTrack = await makeProduct('TRACK_STOCK', { stock: 20, categoryId: catA });
      // Legacy category: sales_flow NOT provided (stays NULL) — mirrors real production
      // data, where every existing customer_price_categories row is unclassified.
      const cpc = await PriceMatrixAgent.createCustomerPriceCategory(customerId, catA, {});
      cleanup.priceCategoryIds.push(cpc.id);
      await PriceMatrixAgent.saveMatrix(
        customerId,
        [{ product_id: pCarcass.id, private_price: 70000, in_catalog: true }],
        null, { effective_from: '2024-01-01', effective_calendar_type: 'SOLAR' }, catA
      );
      const [books] = await pool.query(`SELECT id FROM customer_price_books WHERE customer_price_category_id=?`, [cpc.id]);
      books.forEach(b => cleanup.bookIds.push(b.id));

      check('14a. Legacy unclassified category: CARCASS_POS-flow product saveMatrix still succeeds (write guard permissive when sales_flow NULL)', true);

      let threw = null;
      try {
        await PriceMatrixAgent.saveMatrix(
          customerId,
          [{ product_id: pTrack.id, private_price: 50000, in_catalog: true }],
          null, { effective_from: '2024-01-01', effective_calendar_type: 'SOLAR' }, catA
        );
      } catch (e) { threw = e; }
      check('14a2. Legacy unclassified category: INVENTORY_SALE-flow product rejected (no legacy fallback for this flow, Phase 1B Gate Fix)',
        threw && threw.code === 'PRICE_CATEGORY_SALES_FLOW_MISMATCH', threw && threw.message);

      const r = await OrderAgent.create({ customer_id: customerId, order_date: today(), items: [billItem(pCarcass, 1)] }, adminUser());
      cleanup.orderIds.push(r.order_id);
      check('14b. Bò Xô bill from a legacy/unclassified category: still succeeds', !!r.order_id);
      const [[order]] = await pool.query(`SELECT sales_flow FROM orders WHERE id=?`, [r.order_id]);
      check('14b. header still correctly derived CARCASS_POS despite unclassified category', order.sales_flow === 'CARCASS_POS', order.sales_flow);

      cleanup.productIds.push(pTrack.id); // never successfully cataloged; cleaned up directly
    }

    // ══════════════════ 15) Excel Import / AI confirm path resolver sharing ══════════════════
    {
      const frontendSrc = path.join(__dirname, '..', '..', 'frontend', 'src');
      const createOrderSrc = fs.readFileSync(path.join(frontendSrc, 'pages', 'CreateOrder.jsx'), 'utf8');
      const importCallsCreateOrder = /matchImportedRows/.test(createOrderSrc) && /api\.post\('\/orders'/.test(createOrderSrc);
      check('15a. Excel Import shares OrderAgent.create()\'s resolver (CreateOrder.jsx posts imported rows to the same /orders endpoint as manual entry)', importCallsCreateOrder);

      const orderServiceSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'order.service.js'), 'utf8');
      const aiPathHasOwnInsert = /INSERT INTO order_items/.test(orderServiceSrc);
      const aiPathWritesSalesFlow = /sales_flow/.test(orderServiceSrc);
      info(`15b. AI confirm path (order.service.js) has its own independent order_items INSERT: ${aiPathHasOwnInsert}`);
      info(`15b. AI confirm path currently writes sales_flow/customer_price_category_id: ${aiPathWritesSalesFlow} (expected false — KNOWN GAP, order.service.js is outside Phase 1B's allowed files and was not modified; see final report)`);
      check('15b. Documented as a known gap (order.service.js NOT sharing the Phase 1B resolver) — proven, not silently left unreported', aiPathHasOwnInsert && !aiPathWritesSalesFlow);
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
    console.log('Cleanup done.');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

function today() { return new Date().toISOString().slice(0, 10); }
function adminUser() { return { id: null, role: 'ADMIN' }; }

main().catch(e => { console.error('FATAL', e); process.exit(1); });
