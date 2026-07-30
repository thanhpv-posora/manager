'use strict';
// Verifies "Fix Inventory Sale Order Creation with Legacy NULL Price Category
// Flow" (S1O): OrderAgent.assertItemsCategoryPerFlow() must resolve the
// EFFECTIVE sales_flow (category's own value, else inherited from
// customers.default_sales_flow via the centralized resolveEffectiveSalesFlow)
// instead of unconditionally rejecting every INVENTORY_SALE item priced
// through a legacy sales_flow=NULL Customer Price Category — the exact bug
// that threw PRICE_CATEGORY_NOT_CLASSIFIED_FOR_INVENTORY_SALE for a Hàng Kho
// customer at OrderAgent.create() time, even though Price Matrix/catalog
// loading already resolved the same customer/category correctly.
//
// The CATEGORY-CONFLICT rule (explicit category.sales_flow disagreeing with
// customers.default_sales_flow) is DELIBERATELY NOT enforced as a runtime
// order-creation block — confirmed with the user: CreateOrder.jsx's already-
// shipped "Unified Sales V1" dual-flow bill feature (assertItemsCategoryPerFlow's
// own flowCategorySets tracking "at most one category per flow") legitimately
// creates a SECOND Customer Price Category per customer whose explicit
// sales_flow is the OPPOSITE of that customer's own default_sales_flow — the
// exact same data shape a blind conflict block would reject. Only a read-only
// audit (PriceMatrixAgent.auditCustomerCategorySalesFlowConflicts(), reused
// here) surfaces such rows for review.
//
// Self-cleaning: all throwaway rows removed in `finally`, FK-safe order.

const pool = require('../src/config/db');
const CustomerAgent = require('../src/agents/CustomerAgent');
const ProductAgent = require('../src/agents/ProductAgent');
const OrderAgent = require('../src/agents/OrderAgent');
const PriceMatrixAgent = require('../src/agents/PriceMatrixAgent');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}

const user = { id: null, role: 'ADMIN' };
const today = new Date().toISOString().slice(0, 10);

async function main() {
  const productIds = [];
  const customerIds = [];
  const orderIds = [];
  const bookIds = [];
  const cpcIds = [];
  let categoryId = null;

  try {
    const [[cat]] = await pool.query(`SELECT id FROM product_categories LIMIT 1`);
    categoryId = cat.id;

    async function makeCustomer(name, defaultFlow) {
      const res = await CustomerAgent.create({ name: `VERIFY IOLC ${name} ${Date.now()}-${Math.random().toString(36).slice(2,6)}`, partner_type: 0, default_sales_flow: defaultFlow }, user);
      const [[row]] = await pool.query(`SELECT id FROM customers WHERE customer_code=?`, [res.customer_code]);
      customerIds.push(row.id);
      return row.id;
    }
    async function makeProduct(name, salesFlow) {
      const mode = salesFlow === 'INVENTORY_SALE' ? 'TRACK_STOCK' : 'NON_STOCK';
      await ProductAgent.addProduct({ name: `VERIFY IOLC ${name} ${Date.now()}-${Math.random().toString(36).slice(2,6)}`, unit: 'kg', category_id: categoryId, inventory_mode: mode, sales_flow: salesFlow, stock_quantity: mode === 'TRACK_STOCK' ? 1000 : 0 });
      const [[p]] = await pool.query(`SELECT id FROM products WHERE name LIKE 'VERIFY IOLC ${name} %' ORDER BY id DESC LIMIT 1`);
      productIds.push(p.id);
      return p.id;
    }
    async function makeCpc(customerId, salesFlow) {
      const [r] = await pool.query(`INSERT INTO customer_price_categories (customer_id, category_id, is_default, display_order, sales_flow) VALUES (?,?,1,1,?)`, [customerId, categoryId, salesFlow]);
      cpcIds.push(r.insertId);
      return r.insertId;
    }
    async function makeBook(customerId, cpcId, productId, price) {
      const [b] = await pool.query(
        `INSERT INTO customer_price_books (customer_id, category_id, customer_price_category_id, book_name, effective_from, effective_calendar_type, status) VALUES (?,?,?,?,?,'SOLAR','ACTIVE')`,
        [customerId, categoryId, cpcId, 'VERIFY IOLC book', today]
      );
      bookIds.push(b.insertId);
      await pool.query(`INSERT INTO customer_price_book_items (price_book_id, customer_id, product_id, sale_price) VALUES (?,?,?,?)`, [b.insertId, customerId, productId, price]);
      return b.insertId;
    }

    const pInv = await makeProduct('Inv', 'INVENTORY_SALE');
    const pCarcass = await makeProduct('Carcass', 'CARCASS_POS');

    // ── Acceptance 1: THE REPORTED BUG — Inventory customer, legacy NULL category ──
    const custReported = await makeCustomer('Reported', 'INVENTORY_SALE');
    const cpcReported = await makeCpc(custReported, null);
    await makeBook(custReported, cpcReported, pInv, 125000);
    let orderReported = null, orderReportedThrew = null;
    try {
      orderReported = await OrderAgent.create({ customer_id: custReported, order_date: today, items: [{ product_id: pInv, product_name: 'Inv', unit: 'kg', quantity: 3 }] }, user);
    } catch (e) { orderReportedThrew = e; }
    check('Acceptance 1: bill saves successfully (no PRICE_CATEGORY_NOT_CLASSIFIED_FOR_INVENTORY_SALE)', !orderReportedThrew && !!orderReported, orderReportedThrew && `${orderReportedThrew.code}: ${orderReportedThrew.message}`);
    if (orderReported) {
      orderIds.push(orderReported.order_id);
      const [[savedItem]] = await pool.query(`SELECT sale_price, price_book_id FROM order_items WHERE order_id=?`, [orderReported.order_id]);
      check('Acceptance 1: correct customer-specific price preserved (125000, not default)', Number(savedItem.sale_price) === 125000, savedItem.sale_price);
      check('Acceptance 1: price_book_id traceability preserved (not bypassed to a different category)', Number(savedItem.price_book_id) === bookIds[bookIds.length - 1]);
      const [[orderRow]] = await pool.query(`SELECT total_amount FROM orders WHERE id=?`, [orderReported.order_id]);
      check('Acceptance 1: order total correct (3 x 125000 = 375000)', Number(orderRow.total_amount) === 375000, orderRow.total_amount);
    }

    // ── Acceptance 2: explicit Inventory Sale category (existing behavior preserved) ──
    const custExplicit = await makeCustomer('Explicit', 'INVENTORY_SALE');
    const cpcExplicit = await makeCpc(custExplicit, 'INVENTORY_SALE');
    await makeBook(custExplicit, cpcExplicit, pInv, 130000);
    const orderExplicit = await OrderAgent.create({ customer_id: custExplicit, order_date: today, items: [{ product_id: pInv, product_name: 'Inv', unit: 'kg', quantity: 2 }] }, user);
    orderIds.push(orderExplicit.order_id);
    check('Acceptance 2: explicit matching category still saves', !!orderExplicit.order_id);

    // ── Acceptance 3: Bò xô legacy category ──────────────────────────────────
    const custCarcassLegacy = await makeCustomer('CarcassLegacy', 'CARCASS_POS');
    const cpcCarcassLegacy = await makeCpc(custCarcassLegacy, null);
    await makeBook(custCarcassLegacy, cpcCarcassLegacy, pCarcass, 60000);
    const orderCarcass = await OrderAgent.create({ customer_id: custCarcassLegacy, order_date: today, items: [{ product_id: pCarcass, product_name: 'Carcass', unit: 'kg', quantity: 4 }] }, user);
    orderIds.push(orderCarcass.order_id);
    check('Acceptance 3: Bò xô legacy-NULL category bill still saves (unchanged pre-existing Legacy Model behavior)', !!orderCarcass.order_id);

    // ── Acceptance 4 / conflict audit (NOT a runtime block — see file header) ──
    const custConflict = await makeCustomer('Conflict', 'INVENTORY_SALE');
    const cpcConflict = await makeCpc(custConflict, 'CARCASS_POS');
    const conflicts = await PriceMatrixAgent.auditCustomerCategorySalesFlowConflicts();
    check('Acceptance 4: the conflicting row (customer=INVENTORY_SALE, category=CARCASS_POS) is detected by the audit for CTO review', conflicts.some(c => c.customer_price_category_id === cpcConflict));

    // ── Acceptance 5: missing both flows ─────────────────────────────────────
    const custMissing = await makeCustomer('Missing', 'CARCASS_POS');
    await pool.query(`UPDATE customers SET default_sales_flow=NULL WHERE id=?`, [custMissing]);
    const cpcMissing = await makeCpc(custMissing, null);
    await makeBook(custMissing, cpcMissing, pInv, 100000);
    let missingThrew = null;
    try { await OrderAgent.create({ customer_id: custMissing, order_date: today, items: [{ product_id: pInv, product_name: 'Inv', unit: 'kg', quantity: 1 }] }, user); } catch (e) { missingThrew = e; }
    check('Acceptance 5: CUSTOMER_SALES_FLOW_NOT_CONFIGURED thrown, no order persisted', !!missingThrew && missingThrew.code === 'CUSTOMER_SALES_FLOW_NOT_CONFIGURED', missingThrew && missingThrew.message);
    const [[missingOrderCount]] = await pool.query(`SELECT COUNT(*) cnt FROM orders WHERE customer_id=?`, [custMissing]);
    check('Acceptance 5: no order row persisted for the rejected attempt', Number(missingOrderCount.cnt) === 0);

    // ── Acceptance 6/7: manipulated request — directly plant a mismatched line
    // item into an existing price book (simulating an attacker manipulating the
    // request/DB to smuggle an incompatible product through a resolved
    // category's price_book_id) and confirm the sales-flow guard — not just
    // the unrelated PRODUCT_NOT_IN_PRICE_BOOK check — still rejects it. ──────
    await pool.query(`INSERT INTO customer_price_book_items (price_book_id, customer_id, product_id, sale_price) VALUES (?,?,?,?)`, [bookIds[0], custReported, pCarcass, 999]);
    let injected6 = null;
    try {
      await OrderAgent.create({
        customer_id: custReported, order_date: today,
        items: [{ product_id: pCarcass, product_name: 'Carcass', unit: 'kg', quantity: 1, price_book_id: bookIds[0] }],
      }, user);
    } catch (e) { injected6 = e; }
    check('Acceptance 6: injecting a CARCASS_POS product under an INVENTORY_SALE-resolved category is rejected', !!injected6, injected6 && `${injected6.code}: ${injected6.message}`);

    await pool.query(`INSERT INTO customer_price_book_items (price_book_id, customer_id, product_id, sale_price) VALUES (?,?,?,?)`, [bookIds[2], custCarcassLegacy, pInv, 999]);
    let injected7 = null;
    try {
      await OrderAgent.create({
        customer_id: custCarcassLegacy, order_date: today,
        items: [{ product_id: pInv, product_name: 'Inv', unit: 'kg', quantity: 1, price_book_id: bookIds[2] }],
      }, user);
    } catch (e) { injected7 = e; }
    check('Acceptance 7: injecting an INVENTORY_SALE product under a CARCASS_POS category is rejected', !!injected7, injected7 && `${injected7.code}: ${injected7.message}`);

    // ── Regression: quantity/total/debt still computed normally on a successful order ──
    const [[debtRow]] = await pool.query(`SELECT debt_amount, payment_status FROM orders WHERE id=?`, [orderReported.order_id]);
    check('Regression: debt_amount = total (unpaid bill)', Number(debtRow.debt_amount) === 375000, debtRow.debt_amount);
    check('Regression: payment_status = UNPAID', debtRow.payment_status === 'UNPAID');
    const [[stockRow]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [pInv]);
    check('Regression: TRACK_STOCK inventory movement applied (1000 - 3 - 2 = 995)', Number(stockRow.stock_quantity) === 995, stockRow.stock_quantity);

  } finally {
    for (const id of orderIds) {
      try { await OrderAgent.cancel(id, { reason: 'verify cleanup' }, user); } catch (e) {}
      await pool.query(`DELETE FROM order_items WHERE order_id=?`, [id]);
      await pool.query(`DELETE FROM debt_transactions WHERE order_id=?`, [id]).catch(() => {});
      await pool.query(`DELETE FROM orders WHERE id=?`, [id]);
    }
    for (const id of bookIds) {
      await pool.query(`DELETE FROM customer_price_book_items WHERE price_book_id=?`, [id]);
      await pool.query(`DELETE FROM customer_price_books WHERE id=?`, [id]);
    }
    for (const id of productIds) await pool.query(`DELETE FROM stock_transactions WHERE product_id=?`, [id]).catch(() => {});
    for (const id of productIds) await pool.query(`DELETE FROM products WHERE id=?`, [id]);
    for (const id of customerIds) {
      await pool.query(`DELETE FROM customer_price_categories WHERE customer_id=?`, [id]);
      await pool.query(`DELETE FROM customer_product_catalogs WHERE customer_id=?`, [id]);
      await pool.query(`DELETE FROM customer_product_prices WHERE customer_id=?`, [id]);
      await pool.query(`DELETE FROM price_change_logs WHERE customer_id=?`, [id]);
      await pool.query(`DELETE FROM customers WHERE id=?`, [id]);
    }
    console.log('Cleanup done.');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
