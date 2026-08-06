'use strict';
// S9.2 FINAL Sales Return Foundation — verifies:
//   Create Return Request (POST /api/orders/:id/returns equivalent) and List
//   (GET equivalent) only. No inventory, no debt, no payment, no orders/order_items
//   mutation of any kind. sales_returns.status is the only source of return state
//   (no orders.return_status / order_items.returned_quantity cache column exists).
//   Kept from S9.2A: status/return_reason_code/disposition_type/quality_result are
//   VARCHAR not ENUM; no sales_return_dispositions table; source_stock_
//   transaction_id is NULL rather than guessed when an order has two lines for the
//   same product (Scenario 3b). Restored in S9.2 FINAL: sales_return_inspections
//   table and the sales_return_items disposition columns exist (schema only) —
//   this script asserts BOTH that they exist AND that S9.2's runtime never writes
//   to them, which is the actual CTO requirement, not just "table is present."
//
// Self-cleaning: throwaway customer + products + orders + returns, removed in `finally`.
//
// NOTE: this script was written but NOT executed against the configured database —
// backend/.env points at a remote host, not a confirmed disposable local sandbox.
// Run manually with `node scripts/verify-sales-return-foundation.js`
// from backend/ once a safe target DB is confirmed.

const pool = require('../src/config/db');
const OrderAgent = require('../src/agents/OrderAgent');
const ReturnAgent = require('../src/agents/ReturnAgent');
const ProductAgent = require('../src/agents/ProductAgent');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

async function makeProduct(mode, qty) {
  const name = `S9.2 RETURN ${mode} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const salesFlow = mode === 'TRACK_STOCK' ? 'INVENTORY_SALE' : 'CARCASS_POS';
  await ProductAgent.addProduct({
    name, unit: 'kg', inventory_mode: mode, sales_flow: salesFlow,
    stock_quantity: mode === 'TRACK_STOCK' ? qty : 0, allow_negative_stock: 0,
  });
  const [[created]] = await pool.query(`SELECT * FROM products WHERE name=? LIMIT 1`, [name]);
  return created;
}

async function snapshot(table, where, params) {
  const [rows] = await pool.query(`SELECT * FROM ${table} WHERE ${where}`, params);
  return rows;
}

function assertUnchanged(stepName, before, after) {
  check(`${stepName}: row count unchanged (${before.length} -> ${after.length})`, before.length === after.length, { before: before.length, after: after.length });
  const afterById = new Map(after.map(r => [r.id, r]));
  let unchanged = true, badId = null;
  for (const b of before) {
    const a = afterById.get(b.id);
    if (!a) { unchanged = false; badId = b.id; break; }
    for (const k of Object.keys(b)) {
      if (String(a[k]) !== String(b[k])) { unchanged = false; badId = b.id; break; }
    }
    if (!unchanged) break;
  }
  check(`${stepName}: no existing row was modified`, unchanged, badId !== null ? { changedId: badId } : undefined);
}

async function main() {
  const productIds = [];
  const orderIds = [];
  const returnIds = [];
  let customerId = null;
  let otherCustomerId = null;
  const admin = { id: null, role: 'ADMIN' };
  const today = new Date().toISOString().slice(0, 10);

  try {
    const [custIns] = await pool.query(
      `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type,default_sales_flow)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      [`S92-CUST-${Date.now()}`, 'S9.2 Return Test Customer', '0', 'test', 'PRIVATE_PRICE', 0, 0, 'SOLAR', 'INVENTORY_SALE']
    );
    customerId = custIns.insertId;

    const [otherIns] = await pool.query(
      `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type,default_sales_flow)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      [`S92-CUST-OTHER-${Date.now()}`, 'S9.2 Other Customer', '0', 'test', 'PRIVATE_PRICE', 0, 0, 'SOLAR', 'INVENTORY_SALE']
    );
    otherCustomerId = otherIns.insertId;

    // ══════════════════ Blue/green + story-boundary guards (S9.2A) ══════════════════
    {
      const [[a]] = await pool.query(
        `SELECT COUNT(*) cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND COLUMN_NAME='return_status'`
      );
      check('Guard: orders.return_status was NOT added (CTO directive — no duplicated truth)', Number(a.cnt) === 0, a.cnt);
      const [[b]] = await pool.query(
        `SELECT COUNT(*) cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='order_items' AND COLUMN_NAME='returned_quantity'`
      );
      check('Guard: order_items.returned_quantity was NOT added (CTO directive)', Number(b.cnt) === 0, b.cnt);
      const [[c]] = await pool.query(
        `SELECT COUNT(*) cnt FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sales_return_dispositions'`
      );
      check('Guard: sales_return_dispositions table was NOT created (disposition lives on sales_return_items — kept from S9.2A)', Number(c.cnt) === 0, c.cnt);

      // S9.2 FINAL Change #1: sales_return_inspections is RESTORED (schema only).
      const [[d]] = await pool.query(
        `SELECT COUNT(*) cnt FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sales_return_inspections'`
      );
      check('S9.2 FINAL #1: sales_return_inspections table exists', Number(d.cnt) === 1, d.cnt);
      for (const col of ['accepted_qty', 'rejected_qty', 'quality_result', 'inspection_note', 'inspector_id', 'inspected_at', 'is_final']) {
        const [[row]] = await pool.query(
          `SELECT COUNT(*) cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sales_return_inspections' AND COLUMN_NAME=?`, [col]
        );
        check(`S9.2 FINAL #1: sales_return_inspections.${col} column exists`, Number(row.cnt) === 1, row.cnt);
      }

      // S9.2 FINAL Change #2: sales_return_items future/disposition columns RESTORED.
      for (const col of ['quantity_received', 'disposition_type', 'return_to_stock_qty', 'non_sellable_qty', 'decided_by', 'decided_at', 'disposition_reason_note']) {
        const [[row]] = await pool.query(
          `SELECT COUNT(*) cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sales_return_items' AND COLUMN_NAME=?`, [col]
        );
        check(`S9.2 FINAL #2: sales_return_items.${col} column exists`, Number(row.cnt) === 1, row.cnt);
      }

      // Kept from S9.2A: VARCHAR everywhere, never ENUM — including the two
      // columns just restored (disposition_type, quality_result).
      for (const col of ['status', 'return_reason_code']) {
        const [[row]] = await pool.query(
          `SELECT DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sales_returns' AND COLUMN_NAME=?`, [col]
        );
        check(`Guard (kept from S9.2A #1): sales_returns.${col} is VARCHAR, not ENUM`, row && row.DATA_TYPE === 'varchar', row && row.DATA_TYPE);
      }
      {
        const [[row]] = await pool.query(
          `SELECT DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sales_return_items' AND COLUMN_NAME='disposition_type'`
        );
        check('Restored column is VARCHAR, not ENUM (kept S9.2A #1 principle): sales_return_items.disposition_type', row && row.DATA_TYPE === 'varchar', row && row.DATA_TYPE);
      }
      {
        const [[row]] = await pool.query(
          `SELECT DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sales_return_inspections' AND COLUMN_NAME='quality_result'`
        );
        check('Restored column is VARCHAR, not ENUM (kept S9.2A #1 principle): sales_return_inspections.quality_result', row && row.DATA_TYPE === 'varchar', row && row.DATA_TYPE);
      }
      for (const t of ['sales_returns', 'sales_return_items', 'sales_return_inspections']) {
        const [[row]] = await pool.query(`SELECT COUNT(*) cnt FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?`, [t]);
        check(`Schema: ${t} table exists`, Number(row.cnt) === 1, row.cnt);
      }
    }

    // ══════════════════ Setup: one order with two lines ══════════════════
    let orderId, itemA, itemB, p1, p2;
    {
      p1 = await makeProduct('TRACK_STOCK', 100);
      p2 = await makeProduct('TRACK_STOCK', 50);
      productIds.push(p1.id, p2.id);

      const r = await OrderAgent.create({
        customer_id: customerId, order_date: today,
        items: [
          { product_id: p1.id, product_name: 'x', unit: 'kg', quantity: 10, sale_price: 50000, manual_price: true },
          { product_id: p2.id, product_name: 'y', unit: 'kg', quantity: 5, sale_price: 30000, manual_price: true },
        ],
      }, admin);
      orderId = r.order_id;
      orderIds.push(orderId);

      const [items] = await pool.query(`SELECT * FROM order_items WHERE order_id=? ORDER BY id ASC`, [orderId]);
      itemA = items[0]; itemB = items[1];
    }

    const ordersBefore = await snapshot('orders', 'id=?', [orderId]);
    const orderItemsBefore = await snapshot('order_items', 'order_id=?', [orderId]);
    const stockTxBefore = await snapshot('stock_transactions', 'product_id IN (?,?)', [p1.id, p2.id]);
    // Scoped to THIS order, not the whole customer: Scenarios 3b and 4 below
    // each create their own order for the same customer between this snapshot
    // and the S7 comparison, so a customer-wide count legitimately grows and
    // never measured what S7 asserts. Every other S7 snapshot is already
    // order-scoped; this one now matches them.
    const debtTxBefore = await snapshot('debt_transactions', 'order_id=?', [orderId]);
    const [[stockQtyBefore1]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [p1.id]);
    const [[stockQtyBefore2]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [p2.id]);

    // ══════════════════ Scenario 1: happy-path create ══════════════════
    let firstReturnId, firstReturnCode;
    {
      const idemKey = `S92-TEST-${Date.now()}-1`;
      const result = await ReturnAgent.create(orderId, {
        return_reason_code: 'QUALITY_COMPLAINT',
        return_reason_note: 'S9.2 test',
        idempotency_key: idemKey,
        items: [{ order_item_id: itemA.id, quantity_requested: 3 }],
      }, admin);
      returnIds.push(result.return_id);
      firstReturnId = result.return_id;
      firstReturnCode = result.return_code;

      check('S1: create() returns REQUESTED status', result.status === 'REQUESTED', result.status);
      check('S1: return_code generated with RET prefix', /^RET/.test(result.return_code || ''), result.return_code);
      check('S1: one sales_return_items row returned', Array.isArray(result.items) && result.items.length === 1, result.items);

      const [[line]] = await pool.query(`SELECT * FROM sales_return_items WHERE return_id=?`, [result.return_id]);
      check('S1: frozen_unit_price copied from order_items.sale_price', Number(line.frozen_unit_price) === Number(itemA.sale_price), line.frozen_unit_price);
      check('S1: frozen_unit copied from order_items.unit', line.frozen_unit === itemA.unit, line.frozen_unit);
      check('S1: quantity_requested = 3', Number(line.quantity_requested) === 3, line.quantity_requested);

      const [[originalOut]] = await pool.query(
        `SELECT id FROM stock_transactions WHERE reference_type='SALE' AND reference_id=? AND product_id=?`, [orderId, p1.id]
      );
      check('S1: source_stock_transaction_id links to the original OUT row', Number(line.source_stock_transaction_id) === Number(originalOut.id), { line: line.source_stock_transaction_id, original: originalOut.id });
    }

    // ══════════════════ Scenario 2: idempotency replay ══════════════════
    {
      const idemKey = `S92-TEST-${Date.now()}-2`;
      const first = await ReturnAgent.create(orderId, {
        return_reason_code: 'OTHER', idempotency_key: idemKey,
        items: [{ order_item_id: itemB.id, quantity_requested: 1 }],
      }, admin);
      returnIds.push(first.return_id);
      const second = await ReturnAgent.create(orderId, {
        return_reason_code: 'OTHER', idempotency_key: idemKey,
        items: [{ order_item_id: itemB.id, quantity_requested: 1 }],
      }, admin);
      check('S2: retry with same idempotency_key returns the same return_id', second.return_id === first.return_id, { first: first.return_id, second: second.return_id });
      const [[cnt]] = await pool.query(`SELECT COUNT(*) cnt FROM sales_returns WHERE idempotency_key=?`, [idemKey]);
      check('S2: exactly one sales_returns row exists for this idempotency_key', Number(cnt.cnt) === 1, cnt.cnt);
    }

    // ══════════════════ Scenario 3: remaining-quantity guard ══════════════════
    {
      // itemA.quantity = 10, already requested 3 in Scenario 1 -> remaining = 7
      let threw = null;
      try {
        await ReturnAgent.create(orderId, {
          return_reason_code: 'OTHER',
          items: [{ order_item_id: itemA.id, quantity_requested: 8 }],
        }, admin);
      } catch (e) { threw = e; }
      check('S3: requesting 8 when only 7 remain is rejected', !!threw && threw.code === 'RETURN_QTY_EXCEEDS_REMAINING', threw && threw.message);

      const okResult = await ReturnAgent.create(orderId, {
        return_reason_code: 'OTHER',
        items: [{ order_item_id: itemA.id, quantity_requested: 7 }],
      }, admin);
      returnIds.push(okResult.return_id);
      check('S3: requesting exactly the remaining 7 succeeds', okResult.status === 'REQUESTED', okResult);

      let threwAgain = null;
      try {
        await ReturnAgent.create(orderId, {
          return_reason_code: 'OTHER',
          items: [{ order_item_id: itemA.id, quantity_requested: 0.5 }],
        }, admin);
      } catch (e) { threwAgain = e; }
      check('S3: line is now fully claimed (10/10) — any further request rejected', !!threwAgain && threwAgain.code === 'RETURN_QTY_EXCEEDS_REMAINING', threwAgain && threwAgain.message);
    }

    // ══════════════════ Scenario 3b: ambiguous source_stock_transaction_id (S9.2A Decision #3) ══════════════════
    // Two order_items for the SAME product in the SAME order -> two indistinguishable
    // 'SALE' OUT rows (reference_id is the order id, not the order_item id). Proves
    // the fix does not guess: source_stock_transaction_id must be NULL for both lines.
    {
      const pDup = await makeProduct('TRACK_STOCK', 30);
      productIds.push(pDup.id);
      const r = await OrderAgent.create({
        customer_id: customerId, order_date: today,
        items: [
          { product_id: pDup.id, product_name: 'dup', unit: 'kg', quantity: 6, sale_price: 20000, manual_price: true },
          { product_id: pDup.id, product_name: 'dup', unit: 'kg', quantity: 4, sale_price: 20000, manual_price: true },
        ],
      }, admin);
      orderIds.push(r.order_id);

      const [dupItems] = await pool.query(`SELECT * FROM order_items WHERE order_id=? ORDER BY id ASC`, [r.order_id]);
      check('S3b: setup — order has two lines for the same product', dupItems.length === 2 && dupItems[0].product_id === dupItems[1].product_id, dupItems.map(i => i.product_id));
      const [dupOutRows] = await pool.query(`SELECT id FROM stock_transactions WHERE reference_type='SALE' AND reference_id=? AND product_id=?`, [r.order_id, pDup.id]);
      check('S3b: setup — two indistinguishable OUT rows exist for that product+order', dupOutRows.length === 2, dupOutRows);

      const result = await ReturnAgent.create(r.order_id, {
        return_reason_code: 'OTHER',
        items: [{ order_item_id: dupItems[0].id, quantity_requested: 1 }],
      }, admin);
      returnIds.push(result.return_id);
      const [[dupLine]] = await pool.query(`SELECT source_stock_transaction_id FROM sales_return_items WHERE return_id=?`, [result.return_id]);
      check('S3b: source_stock_transaction_id is NULL when ambiguous (never guesses)', dupLine.source_stock_transaction_id === null, dupLine.source_stock_transaction_id);
    }

    // ══════════════════ Scenario 4: order-state guards ══════════════════
    {
      const p = await makeProduct('TRACK_STOCK', 20);
      productIds.push(p.id);
      const r = await OrderAgent.create({
        customer_id: customerId, order_date: today,
        items: [{ product_id: p.id, product_name: 'z', unit: 'kg', quantity: 4, sale_price: 10000, manual_price: true }],
      }, admin);
      orderIds.push(r.order_id);
      await OrderAgent.cancel(r.order_id, { reason: 'S9.2 test cancel for guard' }, admin);

      const [[cancelledItem]] = await pool.query(`SELECT id FROM order_items WHERE order_id=?`, [r.order_id]);

      let threw = null;
      try {
        await ReturnAgent.create(r.order_id, {
          return_reason_code: 'OTHER',
          items: [{ order_item_id: cancelledItem.id, quantity_requested: 1 }],
        }, admin);
      } catch (e) { threw = e; }
      check('S4: cannot create a return against a CANCELLED order', !!threw && threw.code === 'ORDER_CANCELLED', threw && threw.message);

      const [[cancelledOrder]] = await pool.query(`SELECT status FROM orders WHERE id=?`, [r.order_id]);
      check('S4: OrderAgent.cancel() itself still works unmodified (no S9.2 regression)', cancelledOrder.status === 'CANCELLED', cancelledOrder.status);
    }

    // ══════════════════ Scenario 5: customer scope ══════════════════
    {
      const customerUserWrongTree = { id: null, role: 'CUSTOMER', customer_id: otherCustomerId };
      let threw = null;
      try {
        await ReturnAgent.create(orderId, {
          return_reason_code: 'OTHER',
          items: [{ order_item_id: itemB.id, quantity_requested: 1 }],
        }, customerUserWrongTree);
      } catch (e) { threw = e; }
      check('S5: a CUSTOMER outside the bill\'s tree is rejected (403)', !!threw && threw.status === 403, threw && threw.message);

      let threwList = null;
      try { await ReturnAgent.list(orderId, customerUserWrongTree); } catch (e) { threwList = e; }
      check('S5: list() enforces the same scope check', !!threwList && threwList.status === 403, threwList && threwList.message);

      const customerUserOwnTree = { id: null, role: 'CUSTOMER', customer_id: customerId };
      const ok = await ReturnAgent.list(orderId, customerUserOwnTree);
      check('S5: the bill\'s own customer can list its returns', Array.isArray(ok.returns) && ok.returns.length > 0, ok.returns.length);
    }

    // ══════════════════ Scenario 6: GET shape ══════════════════
    {
      const result = await ReturnAgent.list(orderId, admin);
      check('S6: list() returns order_id', result.order_id === orderId, result.order_id);
      check('S6: list() returns all returns created above', result.returns.length === 3, result.returns.length);
      const first = result.returns.find(r => r.id === firstReturnId);
      check('S6: each return includes its items array', !!first && Array.isArray(first.items) && first.items.length === 1, first);
      check('S6: each item includes an (empty) inspections array', !!first && Array.isArray(first.items[0].inspections) && first.items[0].inspections.length === 0, first && first.items[0]);
    }

    // ══════════════════ Scenario 7: full immutability check ══════════════════
    {
      const ordersAfter = await snapshot('orders', 'id=?', [orderId]);
      const orderItemsAfter = await snapshot('order_items', 'order_id=?', [orderId]);
      const stockTxAfter = await snapshot('stock_transactions', 'product_id IN (?,?)', [p1.id, p2.id]);
      const debtTxAfter = await snapshot('debt_transactions', 'order_id=?', [orderId]);
      const [[stockQtyAfter1]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [p1.id]);
      const [[stockQtyAfter2]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [p2.id]);

      assertUnchanged('S7 orders row', ordersBefore, ordersAfter);
      assertUnchanged('S7 order_items rows', orderItemsBefore, orderItemsAfter);
      assertUnchanged('S7 stock_transactions rows', stockTxBefore, stockTxAfter);
      assertUnchanged('S7 debt_transactions rows', debtTxBefore, debtTxAfter);
      check('S7: products.stock_quantity for line A untouched', Number(stockQtyAfter1.stock_quantity) === Number(stockQtyBefore1.stock_quantity), { before: stockQtyBefore1.stock_quantity, after: stockQtyAfter1.stock_quantity });
      check('S7: products.stock_quantity for line B untouched', Number(stockQtyAfter2.stock_quantity) === Number(stockQtyBefore2.stock_quantity), { before: stockQtyBefore2.stock_quantity, after: stockQtyAfter2.stock_quantity });
    }

    // ══════════════════ Scenario 8: restored schema exists but is genuinely unwritten (S9.2 FINAL) ══════════════════
    // This is the actual CTO requirement — not just "the columns/table exist" but
    // "no runtime writes them." Checks every sales_return_items row created by
    // this script and confirms every restored column is still at its schema
    // default, and that sales_return_inspections has zero rows anywhere for any
    // return_item created in this run.
    {
      const returnItemPlaceholders = returnIds.map(() => '?').join(',');
      const [allTestItems] = await pool.query(
        `SELECT * FROM sales_return_items WHERE return_id IN (${returnItemPlaceholders})`, returnIds
      );
      check('S8: setup — at least one sales_return_items row exists to check', allTestItems.length > 0, allTestItems.length);

      const untouched = allTestItems.every(it =>
        Number(it.quantity_received) === 0 &&
        it.disposition_type === null &&
        Number(it.return_to_stock_qty) === 0 &&
        Number(it.non_sellable_qty) === 0 &&
        it.decided_by === null &&
        it.decided_at === null &&
        it.disposition_reason_note === null
      );
      check('S8: every restored sales_return_items column is still at its schema default (never written by ReturnAgent)', untouched, allTestItems.filter(it => !(
        Number(it.quantity_received) === 0 && it.disposition_type === null && Number(it.return_to_stock_qty) === 0 &&
        Number(it.non_sellable_qty) === 0 && it.decided_by === null && it.decided_at === null && it.disposition_reason_note === null
      )));

      const testItemIds = allTestItems.map(it => it.id);
      const itemPlaceholders = testItemIds.map(() => '?').join(',');
      const [insRows] = await pool.query(
        `SELECT COUNT(*) cnt FROM sales_return_inspections WHERE return_item_id IN (${itemPlaceholders || 'NULL'})`,
        testItemIds
      );
      check('S8: sales_return_inspections has zero rows for any return item created in this run (table exists, nothing writes it)', Number(insRows[0].cnt) === 0, insRows[0].cnt);
    }

  } finally {
    console.log('\nCleaning up...');
    for (const rid of returnIds) {
      // sales_return_inspections is restored (S9.2 FINAL #1) but should always be
      // empty — deleted defensively in case a future story's manual testing left rows.
      await pool.query(`DELETE FROM sales_return_inspections WHERE return_item_id IN (SELECT id FROM sales_return_items WHERE return_id=?)`, [rid]).catch(() => {});
      await pool.query(`DELETE FROM sales_return_items WHERE return_id=?`, [rid]).catch(() => {});
      await pool.query(`DELETE FROM sales_returns WHERE id=?`, [rid]).catch(() => {});
    }
    for (const oid of orderIds) {
      await pool.query(`DELETE FROM order_items WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM debt_transactions WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM orders WHERE id=?`, [oid]).catch(() => {});
    }
    for (const id of productIds) {
      await pool.query(`DELETE FROM stock_transactions WHERE product_id=?`, [id]).catch(() => {});
      await pool.query(`DELETE FROM products WHERE id=?`, [id]).catch(() => {});
    }
    for (const cid of [customerId, otherCustomerId]) {
      if (!cid) continue;
      await pool.query(`DELETE FROM debt_transactions WHERE customer_id=?`, [cid]).catch(() => {});
      await pool.query(`DELETE FROM customer_product_catalogs WHERE customer_id=?`, [cid]).catch(() => {});
      await pool.query(`DELETE FROM customer_product_prices WHERE customer_id=?`, [cid]).catch(() => {});
      await pool.query(`DELETE FROM customers WHERE id=?`, [cid]).catch(() => {});
    }
    console.log('Cleanup done.');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
