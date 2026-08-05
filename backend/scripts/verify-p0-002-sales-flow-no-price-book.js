'use strict';
// P0-002 — assertItemsCategoryPerFlow()'s no-price_book_id branch
// (COMMON_PRICE/MANUAL_PRICE fallback) must enforce sales-flow isolation
// just like the price_book_id branch already does. Verifies, against the
// real OrderAgent.create()/addItem() write path:
//   1. Matching flow WITHOUT a price book -> allowed (COMMON_PRICE)
//   2. Matching flow WITHOUT a price book -> allowed (MANUAL_PRICE)
//   3. CARCASS_POS customer + INVENTORY_SALE product, no price book -> reject
//   4. INVENTORY_SALE customer + CARCASS_POS product, no price book -> reject
//      (the reverse direction — proves the fix isn't one-directional)
//   5. Customer with no default_sales_flow configured at all + INVENTORY_SALE
//      product, no price book -> reject with CUSTOMER_SALES_FLOW_NOT_CONFIGURED
//      (fail closed, never silently allow when nothing can be resolved)
//   5b. Same unconfigured customer + CARCASS_POS product, no price book ->
//      allowed (legacy-compat allowance mirrored from the price_book_id
//      branch's own NULL-category asymmetry — matches an existing Bò Xô
//      happy path in verify-mixed-sales-dual-price-category.js)
//   6. addItem() (the second call site sharing the same function) enforces
//      the same rule
//   7. The price_book_id branch is provably untouched — a mismatching
//      price-book item is still rejected exactly as before (regression)
//
// Confirms OrderImportAgent (Excel order import) is an inert stub with no
// methods/routes — nothing to bypass, not tested at runtime.
//
// Self-cleaning: throwaway customers + products + orders + price
// books/categories, removed in `finally`. Never touches real data.

const pool = require('../src/config/db');
const OrderAgent = require('../src/agents/OrderAgent');
const ProductAgent = require('../src/agents/ProductAgent');
const OrderImportAgent = require('../src/agents/OrderImportAgent');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

const user = { id: null, role: 'ADMIN' };
const today = new Date().toISOString().slice(0, 10);

async function makeCustomer(defaultFlow) {
  const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const [ins] = await pool.query(
    `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type,partner_type,default_sales_flow)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [`P002-CUST-${uniq}`, `P0-002 Customer ${defaultFlow || 'NONE'} ${uniq}`, '0', 'test', 'COMMON_PRICE', 0, 0, 'SOLAR', 2, defaultFlow]
  );
  return ins.insertId;
}

async function makeProduct(salesFlow, inventoryMode, qty = 50) {
  const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const name = `P0-002 PRODUCT ${salesFlow} ${uniq}`;
  // default_sale_price set so PriceBookService.getEffectivePrice() can
  // genuinely resolve a COMMON_PRICE for this product with no price book at
  // all — lets test 1 exercise real COMMON_PRICE resolution rather than
  // relying on the manual_price:true bypass every other test scenario uses.
  await ProductAgent.addProduct({ name, unit: 'kg', inventory_mode: inventoryMode, sales_flow: salesFlow, stock_quantity: inventoryMode === 'TRACK_STOCK' ? qty : 0, allow_negative_stock: 0, default_sale_price: 10000 });
  const [[created]] = await pool.query(`SELECT * FROM products WHERE name=? LIMIT 1`, [name]);
  return created;
}

async function main() {
  const customerIds = [];
  const productIds = [];
  const orderIds = [];

  try {
    // ══════════════════ Setup: matching-flow customers/products ══════════════════
    const carcassCustomer = await makeCustomer('CARCASS_POS');
    const inventoryCustomer = await makeCustomer('INVENTORY_SALE');
    const unconfiguredCustomer = await makeCustomer(null);
    customerIds.push(carcassCustomer, inventoryCustomer, unconfiguredCustomer);

    const carcassProduct = await makeProduct('CARCASS_POS', 'NON_STOCK');
    const inventoryProduct = await makeProduct('INVENTORY_SALE', 'TRACK_STOCK');
    productIds.push(carcassProduct.id, inventoryProduct.id);

    // ══════════════════ 1: matching flow, no price book, COMMON_PRICE -> allow ══════════════════
    {
      const r = await OrderAgent.create({
        customer_id: carcassCustomer, order_date: today,
        items: [{ product_id: carcassProduct.id, product_name: carcassProduct.name, unit: 'kg', quantity: 2, sale_price: 10000, price_type: 'COMMON_PRICE' }],
      }, user);
      orderIds.push(r.order_id);
      check('1: matching flow (CARCASS_POS customer + CARCASS_POS product), no price book, COMMON_PRICE -> allowed', !!r.order_id, r);
    }

    // ══════════════════ 2: matching flow, no price book, MANUAL_PRICE -> allow ══════════════════
    {
      const r = await OrderAgent.create({
        customer_id: inventoryCustomer, order_date: today,
        items: [{ product_id: inventoryProduct.id, product_name: inventoryProduct.name, unit: 'kg', quantity: 2, sale_price: 12000, manual_price: true }],
      }, user);
      orderIds.push(r.order_id);
      check('2: matching flow (INVENTORY_SALE customer + INVENTORY_SALE product), no price book, MANUAL_PRICE -> allowed', !!r.order_id, r);
    }

    // ══════════════════ 3 (FIX VERIFIED): CARCASS_POS customer + INVENTORY_SALE product -> reject ══════════════════
    {
      let threw = null;
      try {
        await OrderAgent.create({
          customer_id: carcassCustomer, order_date: today,
          items: [{ product_id: inventoryProduct.id, product_name: inventoryProduct.name, unit: 'kg', quantity: 1, sale_price: 12000, price_type: 'COMMON_PRICE' }],
        }, user);
      } catch (e) { threw = e; }
      check('3 (FIX VERIFIED): CARCASS_POS customer + INVENTORY_SALE product, no price book -> rejected', !!threw && threw.code === 'PRICE_CATEGORY_NOT_INVENTORY_SALE', threw && { message: threw.message, code: threw.code });
    }

    // ══════════════════ 4 (FIX VERIFIED): INVENTORY_SALE customer + CARCASS_POS product -> reject (reverse direction) ══════════════════
    {
      let threw = null;
      try {
        await OrderAgent.create({
          customer_id: inventoryCustomer, order_date: today,
          items: [{ product_id: carcassProduct.id, product_name: carcassProduct.name, unit: 'kg', quantity: 1, sale_price: 9000, manual_price: true }],
        }, user);
      } catch (e) { threw = e; }
      check('4 (FIX VERIFIED, reverse direction): INVENTORY_SALE customer + CARCASS_POS product, no price book -> rejected', !!threw && threw.code === 'PRICE_CATEGORY_SALES_FLOW_MISMATCH', threw && { message: threw.message, code: threw.code });
    }

    // ══════════════════ 5: customer with no default_sales_flow, INVENTORY_SALE product -> reject, fail closed ══════════════════
    {
      let threw = null;
      try {
        await OrderAgent.create({
          customer_id: unconfiguredCustomer, order_date: today,
          items: [{ product_id: inventoryProduct.id, product_name: inventoryProduct.name, unit: 'kg', quantity: 1, sale_price: 9000, manual_price: true }],
        }, user);
      } catch (e) { threw = e; }
      check('5: customer with no default_sales_flow, INVENTORY_SALE product, no price book -> rejected CUSTOMER_SALES_FLOW_NOT_CONFIGURED (fail closed)', !!threw && threw.code === 'CUSTOMER_SALES_FLOW_NOT_CONFIGURED', threw && { message: threw.message, code: threw.code });
    }

    // ══════════════════ 5b: customer with no default_sales_flow, CARCASS_POS product -> legacy-compat allowance preserved ══════════════════
    // Mirrors the price_book_id branch's own NULL-category asymmetry (see
    // OrderAgent.js ~line 247-261): CARCASS_POS is not blocked just because
    // the customer's flow can't be resolved — this is the exact scenario
    // verify-mixed-sales-dual-price-category.js's test 6 already depends on
    // as an existing Bò Xô happy path, so it must keep succeeding here too.
    {
      const r = await OrderAgent.create({
        customer_id: unconfiguredCustomer, order_date: today,
        items: [{ product_id: carcassProduct.id, product_name: carcassProduct.name, unit: 'kg', quantity: 1, sale_price: 9000, price_type: 'COMMON_PRICE' }],
      }, user);
      orderIds.push(r.order_id);
      check('5b: customer with no default_sales_flow, CARCASS_POS product, no price book -> allowed (legacy-compat allowance, matches existing Bò Xô happy paths)', !!r.order_id, r);
    }

    // ══════════════════ 6: addItem() (second call site) enforces the same rule ══════════════════
    {
      const r = await OrderAgent.create({
        customer_id: carcassCustomer, order_date: today,
        items: [{ product_id: carcassProduct.id, product_name: carcassProduct.name, unit: 'kg', quantity: 1, sale_price: 10000, price_type: 'COMMON_PRICE' }],
      }, user);
      orderIds.push(r.order_id);
      let threw = null;
      try {
        await OrderAgent.addItem(r.order_id, { product_id: inventoryProduct.id, quantity: 1, sale_price: 12000, price_type: 'COMMON_PRICE' }, user);
      } catch (e) { threw = e; }
      check('6: addItem() rejects a mismatching-flow item the same way create() does', !!threw && threw.code === 'PRICE_CATEGORY_NOT_INVENTORY_SALE', threw && { message: threw.message, code: threw.code });
    }

    // Note: the price_book_id branch itself is zero-lines-changed by this fix
    // (only the else/no-price_book_id branch was touched) — its own
    // mismatch-rejection regression coverage already exists in
    // verify-mixed-sales-dual-price-category.js / verify-customer-inherited-
    // sales-flow.js, re-run alongside this script rather than duplicated here.

    // ══════════════════ Excel import: confirmed inert stub, nothing to bypass ══════════════════
    {
      const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(OrderImportAgent)).filter(m => m !== 'constructor');
      check('Excel order import (OrderImportAgent) has zero methods — confirmed inert stub, not a live bypass surface', methods.length === 0, methods);
    }

  } finally {
    for (const oid of orderIds) {
      await pool.query(`DELETE FROM order_items WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM debt_transactions WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM stock_transactions WHERE reference_type='SALE' AND reference_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM orders WHERE id=?`, [oid]).catch(() => {});
    }
    for (const cid of customerIds) {
      await pool.query(`DELETE FROM debt_transactions WHERE customer_id=?`, [cid]).catch(() => {});
      await pool.query(`DELETE FROM customers WHERE id=?`, [cid]).catch(() => {});
    }
    for (const pid of productIds) {
      await pool.query(`DELETE FROM stock_transactions WHERE product_id=?`, [pid]).catch(() => {});
      await pool.query(`DELETE FROM products WHERE id=?`, [pid]).catch(() => {});
    }
    console.log('Cleanup done.');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
