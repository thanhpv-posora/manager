'use strict';
// P0-001 — OrderAgent.updateItem() must never drive stock negative when a
// line's quantity is increased, and must reject with a stable business
// error before any write when there isn't enough stock. Verifies (against
// the real end-to-end route: OrderAgent.updateItem()):
//   1. Sufficient stock + increase -> succeeds, exact stock OUT
//   2. Insufficient stock -> INSUFFICIENT_STOCK, no item/stock/ledger change
//   3. Quantity decrease -> exact stock returned
//   4. Concurrent competing increases -> at most one consumes remaining stock
//   5. Retry (same edit re-submitted) does not duplicate movement
//   6. NON_STOCK / affect_stock=false behavior unchanged
//   7. The frozen order_items.stock_checked fact is honored even if the
//      product's mode is reconfigured after the sale (root-cause fix, not
//      just a lock+check band-aid on the live-settings-derived path)
//
// Self-cleaning: throwaway customer + products + orders, removed in `finally`.

const pool = require('../src/config/db');
const OrderAgent = require('../src/agents/OrderAgent');
const ProductAgent = require('../src/agents/ProductAgent');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

const user = { id: null, role: 'ADMIN' };
const today = new Date().toISOString().slice(0, 10);

async function makeProduct(mode, qty, allowNeg = 0) {
  const name = `P0-001 QTY GUARD ${mode} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const salesFlow = mode === 'TRACK_STOCK' ? 'INVENTORY_SALE' : 'CARCASS_POS';
  await ProductAgent.addProduct({ name, unit: 'kg', inventory_mode: mode, sales_flow: salesFlow, stock_quantity: mode === 'TRACK_STOCK' ? qty : 0, allow_negative_stock: allowNeg });
  const [[created]] = await pool.query(`SELECT * FROM products WHERE name=? LIMIT 1`, [name]);
  return created;
}

async function stockOf(productId) {
  const [[row]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [productId]);
  return Number(row.stock_quantity);
}

async function itemRow(orderId) {
  const [[row]] = await pool.query(`SELECT * FROM order_items WHERE order_id=? LIMIT 1`, [orderId]);
  return row;
}

async function adjustmentRows(productId, orderId) {
  const [rows] = await pool.query(
    `SELECT * FROM stock_transactions WHERE product_id=? AND type IN ('ADJUSTMENT_INCREASE','ADJUSTMENT_DECREASE') ORDER BY id ASC`,
    [productId]
  );
  return rows;
}

async function main() {
  const productIds = [];
  const orderIds = [];
  let customerId = null;
  let carcassCustomerId = null;

  try {
    // default_sales_flow=INVENTORY_SALE: this script's scenarios are almost
    // all TRACK_STOCK/INVENTORY_SALE products bought with manual_price:true
    // and no price book — P0-002's sales-flow enforcement on that same write
    // path now requires a resolvable customer flow for INVENTORY_SALE items
    // (fail closed otherwise), so the test customer needs one set, same as
    // any real INVENTORY_SALE customer would have.
    const [custIns] = await pool.query(
      `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type,default_sales_flow)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      [`P001-CUST-${Date.now()}`, 'P0-001 Qty Guard Test Customer', '0', 'test', 'PRIVATE_PRICE', 0, 0, 'SOLAR', 'INVENTORY_SALE']
    );
    customerId = custIns.insertId;

    // Scenario 6 below buys a NON_STOCK/CARCASS_POS product — under P0-002's
    // sales-flow enforcement that would mismatch against the INVENTORY_SALE
    // customer above, so it gets its own CARCASS_POS-flow customer. Unrelated
    // to what scenario 6 actually tests (NON_STOCK balance behavior), purely
    // a flow-compatible counterpart.
    const [carcassCustIns] = await pool.query(
      `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type,default_sales_flow)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      [`P001-CUST-CARCASS-${Date.now()}`, 'P0-001 Qty Guard Test Customer (CARCASS_POS)', '0', 'test', 'PRIVATE_PRICE', 0, 0, 'SOLAR', 'CARCASS_POS']
    );
    carcassCustomerId = carcassCustIns.insertId;

    // ══════════════════ 1: sufficient stock + increase -> succeeds, exact stock OUT ══════════════════
    let p1, o1;
    {
      const p = await makeProduct('TRACK_STOCK', 20);
      productIds.push(p.id);
      const r = await OrderAgent.create({
        customer_id: customerId, order_date: today,
        items: [{ product_id: p.id, product_name: 'x', unit: 'kg', quantity: 5, sale_price: 20000, manual_price: true }],
      }, user);
      orderIds.push(r.order_id);
      p1 = p; o1 = r.order_id;
      check('1: stock deducted on create (20 -> 15)', await stockOf(p.id) === 15, await stockOf(p.id));

      const item = await itemRow(o1);
      await OrderAgent.updateItem(o1, item.id, { quantity: 12, sale_price: 20000 }, user); // +7
      check('1: increase succeeds, stock deducted by exact delta (15 -> 8)', await stockOf(p.id) === 8, await stockOf(p.id));
      const adjRows = await adjustmentRows(p.id, o1);
      check('1: exactly one ADJUSTMENT_DECREASE row, quantity=7, affect_stock=1', adjRows.length === 1 && adjRows[0].type === 'ADJUSTMENT_DECREASE' && Number(adjRows[0].quantity) === 7 && Number(adjRows[0].affect_stock) === 1, adjRows);
      const updatedItem = await itemRow(o1);
      check('1: order_items.quantity updated to 12', Number(updatedItem.quantity) === 12, updatedItem.quantity);
    }

    // ══════════════════ 2: insufficient stock -> INSUFFICIENT_STOCK, no partial write ══════════════════
    {
      const p = await makeProduct('TRACK_STOCK', 10);
      productIds.push(p.id);
      const r = await OrderAgent.create({
        customer_id: customerId, order_date: today,
        items: [{ product_id: p.id, product_name: 'y', unit: 'kg', quantity: 3, sale_price: 15000, manual_price: true }],
      }, user);
      orderIds.push(r.order_id);
      check('2 setup: stock after create (10 -> 7)', await stockOf(p.id) === 7, await stockOf(p.id));

      const item = await itemRow(r.order_id);
      const rowsBefore = await adjustmentRows(p.id, r.order_id);
      let threw = null;
      try {
        await OrderAgent.updateItem(r.order_id, item.id, { quantity: 3 + 999, sale_price: 15000 }, user); // delta=999 >> balance=7
      } catch (e) { threw = e; }
      check('2: throws with code INSUFFICIENT_STOCK', !!threw && threw.code === 'INSUFFICIENT_STOCK', threw && { message: threw.message, code: threw.code });
      check('2: exact required message', threw && threw.message === 'Không đủ tồn kho để tăng số lượng mặt hàng trong bill.', threw && threw.message);
      check('2: order_items.quantity NOT partially updated (still 3)', Number((await itemRow(r.order_id)).quantity) === 3, (await itemRow(r.order_id)).quantity);
      check('2: stock unchanged (still 7)', await stockOf(p.id) === 7, await stockOf(p.id));
      check('2: no new ledger row written', (await adjustmentRows(p.id, r.order_id)).length === rowsBefore.length, { before: rowsBefore.length, after: (await adjustmentRows(p.id, r.order_id)).length });
    }

    // ══════════════════ 3: quantity decrease -> exact stock returned ══════════════════
    {
      const p = await makeProduct('TRACK_STOCK', 20);
      productIds.push(p.id);
      const r = await OrderAgent.create({
        customer_id: customerId, order_date: today,
        items: [{ product_id: p.id, product_name: 'z', unit: 'kg', quantity: 10, sale_price: 10000, manual_price: true }],
      }, user);
      orderIds.push(r.order_id);
      check('3 setup: stock after create (20 -> 10)', await stockOf(p.id) === 10, await stockOf(p.id));

      const item = await itemRow(r.order_id);
      await OrderAgent.updateItem(r.order_id, item.id, { quantity: 4, sale_price: 10000 }, user); // -6
      check('3: decrease returns exact delta (10 -> 16)', await stockOf(p.id) === 16, await stockOf(p.id));
      const adjRows = await adjustmentRows(p.id, r.order_id);
      check('3: exactly one ADJUSTMENT_INCREASE row, quantity=6', adjRows.length === 1 && adjRows[0].type === 'ADJUSTMENT_INCREASE' && Number(adjRows[0].quantity) === 6, adjRows);
    }

    // ══════════════════ 4: concurrent competing increases -> at most one consumes remaining stock ══════════════════
    {
      const p = await makeProduct('TRACK_STOCK', 20);
      productIds.push(p.id);
      const r1 = await OrderAgent.create({
        customer_id: customerId, order_date: today,
        items: [{ product_id: p.id, product_name: 'race-a', unit: 'kg', quantity: 2, sale_price: 5000, manual_price: true }],
      }, user);
      const r2 = await OrderAgent.create({
        customer_id: customerId, order_date: today,
        items: [{ product_id: p.id, product_name: 'race-b', unit: 'kg', quantity: 2, sale_price: 5000, manual_price: true }],
      }, user);
      orderIds.push(r1.order_id, r2.order_id);
      check('4 setup: stock after two creates (20 -> 16)', await stockOf(p.id) === 16, await stockOf(p.id));

      const item1 = await itemRow(r1.order_id);
      const item2 = await itemRow(r2.order_id);
      // Each order tries to grab +10 (10+10=20 > 16 remaining) — only one can succeed.
      const results = await Promise.allSettled([
        OrderAgent.updateItem(r1.order_id, item1.id, { quantity: 12, sale_price: 5000 }, user), // wants +10
        OrderAgent.updateItem(r2.order_id, item2.id, { quantity: 12, sale_price: 5000 }, user), // wants +10
      ]);
      const fulfilled = results.filter(x => x.status === 'fulfilled');
      const rejected = results.filter(x => x.status === 'rejected');
      check('4: exactly one of the two concurrent increases succeeded', fulfilled.length === 1, results.map(x => x.status));
      check('4: exactly one was rejected (insufficient stock)', rejected.length === 1 && rejected[0].reason.code === 'INSUFFICIENT_STOCK', rejected.map(x => x.reason && x.reason.message));
      check('4: stock reflects exactly one +10 consumption (16 -> 6), never negative', await stockOf(p.id) === 6, await stockOf(p.id));
    }

    // ══════════════════ 5: retry does not duplicate movement ══════════════════
    {
      const p = await makeProduct('TRACK_STOCK', 20);
      productIds.push(p.id);
      const r = await OrderAgent.create({
        customer_id: customerId, order_date: today,
        items: [{ product_id: p.id, product_name: 'retry', unit: 'kg', quantity: 5, sale_price: 8000, manual_price: true }],
      }, user);
      orderIds.push(r.order_id);
      const item = await itemRow(r.order_id);

      await OrderAgent.updateItem(r.order_id, item.id, { quantity: 9, sale_price: 8000 }, user); // +4
      const afterFirst = await stockOf(p.id);
      const rowsAfterFirst = await adjustmentRows(p.id, r.order_id);

      // Client retries the SAME edit (e.g. after a timeout) — updateItem()
      // re-reads the CURRENT order_items.quantity (already 9) fresh under
      // FOR UPDATE each call, so delta = 9-9 = 0 -> naturally a no-op, no new
      // ledger row, by construction (no separate idempotency-key needed).
      await OrderAgent.updateItem(r.order_id, item.id, { quantity: 9, sale_price: 8000 }, user);
      check('5: retry (same target quantity) does not change stock further', await stockOf(p.id) === afterFirst, { afterFirst, afterRetry: await stockOf(p.id) });
      check('5: retry does not write a duplicate ledger row', (await adjustmentRows(p.id, r.order_id)).length === rowsAfterFirst.length, { before: rowsAfterFirst.length, after: (await adjustmentRows(p.id, r.order_id)).length });
    }

    // ══════════════════ 6: NON_STOCK / affect_stock=false unchanged ══════════════════
    {
      const p = await makeProduct('NON_STOCK', 0);
      productIds.push(p.id);
      const r = await OrderAgent.create({
        customer_id: carcassCustomerId, order_date: today,
        items: [{ product_id: p.id, product_name: 'boxo', unit: 'kg', quantity: 3, sale_price: 6000, manual_price: true }],
      }, user);
      orderIds.push(r.order_id);
      check('6 setup: NON_STOCK balance unaffected by create (still 0)', await stockOf(p.id) === 0, await stockOf(p.id));

      const item = await itemRow(r.order_id);
      await OrderAgent.updateItem(r.order_id, item.id, { quantity: 50, sale_price: 6000 }, user); // huge increase, must not throw or touch balance
      check('6: large NON_STOCK increase does not throw and balance stays 0', await stockOf(p.id) === 0, await stockOf(p.id));
      check('6: no ADJUSTMENT ledger row written for a NON_STOCK line', (await adjustmentRows(p.id, r.order_id)).length === 0, await adjustmentRows(p.id, r.order_id));
    }

    // ══════════════════ 7: frozen stock_checked fact honored despite later product reconfiguration ══════════════════
    {
      const p = await makeProduct('TRACK_STOCK', 20);
      productIds.push(p.id);
      const r = await OrderAgent.create({
        customer_id: customerId, order_date: today,
        items: [{ product_id: p.id, product_name: 'reconfig', unit: 'kg', quantity: 5, sale_price: 7000, manual_price: true }],
      }, user);
      orderIds.push(r.order_id);
      check('7 setup: stock deducted at sale time (20 -> 15)', await stockOf(p.id) === 15, await stockOf(p.id));

      // Product reconfigured to NON_STOCK AFTER the sale — the line's own
      // frozen stock_checked=1 must still govern the edit, not today's mode.
      await pool.query(`UPDATE products SET inventory_mode='NON_STOCK' WHERE id=?`, [p.id]);
      const item = await itemRow(r.order_id);
      check('7: order_items retains its ORIGINAL frozen stock_checked=1 despite product now NON_STOCK', Number(item.stock_checked) === 1, item.stock_checked);

      await OrderAgent.updateItem(r.order_id, item.id, { quantity: 8, sale_price: 7000 }, user); // +3
      check('7: increase still deducts real stock (15 -> 12) — frozen fact honored, not today\'s NON_STOCK setting', await stockOf(p.id) === 12, await stockOf(p.id));
    }

  } finally {
    for (const oid of orderIds) {
      await pool.query(`DELETE FROM order_items WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM debt_transactions WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM orders WHERE id=?`, [oid]).catch(() => {});
    }
    for (const id of productIds) {
      await pool.query(`DELETE FROM stock_transactions WHERE product_id=?`, [id]).catch(() => {});
      await pool.query(`DELETE FROM products WHERE id=?`, [id]).catch(() => {});
    }
    if (customerId) {
      await pool.query(`DELETE FROM debt_transactions WHERE customer_id=?`, [customerId]).catch(() => {});
      await pool.query(`DELETE FROM customers WHERE id=?`, [customerId]).catch(() => {});
    }
    if (carcassCustomerId) {
      await pool.query(`DELETE FROM debt_transactions WHERE customer_id=?`, [carcassCustomerId]).catch(() => {});
      await pool.query(`DELETE FROM customers WHERE id=?`, [carcassCustomerId]).catch(() => {});
    }
    console.log('Cleanup done.');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
