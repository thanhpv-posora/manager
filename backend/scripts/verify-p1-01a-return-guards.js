'use strict';
// P1-01A — CTO review correction verification: Sales Return Final-State
// Guard Correction (ReturnAgent.js complete()/reject()/inspect()).
//
// Covers the 8 scenarios the review explicitly asked for:
//   1. accepted total = 0            -> complete() rejected (RETURN_NOTHING_ACCEPTED)
//   2. accepted total > 0            -> reject() rejected (RETURN_HAS_ACCEPTED_QUANTITY)
//   3. incomplete classification     -> both complete() and reject() rejected (RETURN_INSPECTION_INCOMPLETE)
//   4. accepted = 0                  -> disposition optional (inspect() succeeds, persists null/0)
//   5. accepted > 0                  -> disposition required (inspect() rejects RETURN_INVALID_DISPOSITION)
//   6. inspection_note persisted separately from disposition_reason_note (distinct values, both readable back)
//   7. complete() with RESTOCK posts stock exactly once (and a retry after COMPLETED never double-posts)
//   8. reject() posts no stock, ever
//
// Same convention as scripts/verify-sales-return-foundation.js (S9.2): real
// pool, self-cleaning (throwaway customer/products/order/returns removed in
// `finally`), pass/fail counters, no external test framework (none exists in
// this repo). Follows that script's own explicit precedent of being written
// but NOT executed against the configured database here — backend/.env
// points at a remote host, not a confirmed disposable local sandbox (see PR
// report). Run manually with `node scripts/verify-p1-01a-return-guards.js`
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
async function expectError(name, code, fn) {
  try {
    await fn();
    check(name, false, 'expected to throw but succeeded');
  } catch (e) {
    check(name, e && e.code === code, { expected: code, got: e && e.code, message: e && e.message });
  }
}

async function makeProduct(qty) {
  const name = `P1-01A RETURN ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await ProductAgent.addProduct({
    name, unit: 'kg', inventory_mode: 'TRACK_STOCK', sales_flow: 'INVENTORY_SALE',
    stock_quantity: qty, allow_negative_stock: 0,
  });
  const [[created]] = await pool.query(`SELECT * FROM products WHERE name=? LIMIT 1`, [name]);
  return created;
}

async function stockOf(productId) {
  const [[row]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [productId]);
  return Number(row.stock_quantity);
}
async function salesReturnStockRowCount(returnId) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) cnt FROM stock_transactions WHERE reference_type='SALES_RETURN' AND reference_id=?`, [returnId]
  );
  return Number(row.cnt);
}

async function main() {
  const productIds = [];
  const orderIds = [];
  const returnIds = [];
  let customerId = null;
  const admin = { id: null, role: 'ADMIN' };
  const today = new Date().toISOString().slice(0, 10);

  try {
    const [custIns] = await pool.query(
      `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type,default_sales_flow)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      [`P101A-CUST-${Date.now()}`, 'P1-01A Return Guard Test Customer', '0', 'test', 'PRIVATE_PRICE', 0, 0, 'SOLAR', 'INVENTORY_SALE']
    );
    customerId = custIns.insertId;

    const pA = await makeProduct(100);
    const pB = await makeProduct(100);
    productIds.push(pA.id, pB.id);

    const orderResult = await OrderAgent.create({
      customer_id: customerId, order_date: today,
      items: [
        { product_id: pA.id, product_name: 'A', unit: 'kg', quantity: 10, sale_price: 50000, manual_price: true },
        { product_id: pB.id, product_name: 'B', unit: 'kg', quantity: 10, sale_price: 40000, manual_price: true },
      ],
    }, admin);
    const orderId = orderResult.order_id;
    orderIds.push(orderId);

    const [orderItems] = await pool.query(`SELECT * FROM order_items WHERE order_id=? ORDER BY id ASC`, [orderId]);
    const itemA = orderItems[0], itemB = orderItems[1];

    // ══════════════════ Scenario A: incomplete classification (item 3), then
    // fully-classified-but-nothing-accepted (item 1 + item 8) ══════════════════
    {
      const created = await ReturnAgent.create(orderId, {
        return_reason_code: 'QUALITY_COMPLAINT', items: [{ order_item_id: itemA.id, quantity_requested: 4 }],
      }, admin);
      const returnId = created.return_id;
      returnIds.push(returnId);
      const lineId = created.items[0].id;

      await ReturnAgent.receive(returnId, { items: [{ return_item_id: lineId, received_qty: 4 }] }, admin);

      // Partial classification: accepted 1 + rejected 1 = 2, but received = 4.
      await ReturnAgent.inspect(returnId, {
        items: [{ return_item_id: lineId, accepted_qty: 1, rejected_qty: 1, disposition: 'RESTOCK' }],
      }, admin);

      // Item 3: incomplete classification blocks BOTH terminal actions.
      await expectError('Item 3a: complete() rejects incomplete classification', 'RETURN_INSPECTION_INCOMPLETE',
        () => ReturnAgent.complete(returnId, admin));
      await expectError('Item 3b: reject() rejects incomplete classification', 'RETURN_INSPECTION_INCOMPLETE',
        () => ReturnAgent.reject(returnId, { reason: 'x' }, admin));

      // Fully classify with nothing accepted (0 + 4 = 4 = received).
      await ReturnAgent.inspect(returnId, {
        items: [{ return_item_id: lineId, accepted_qty: 0, rejected_qty: 4 }], // no disposition sent — item 4
      }, admin);

      const [[lineAfter]] = await pool.query(`SELECT disposition_type, return_to_stock_qty, non_sellable_qty FROM sales_return_items WHERE id=?`, [lineId]);
      check('Item 4: accepted_qty=0 persists disposition_type=NULL', lineAfter.disposition_type === null, lineAfter.disposition_type);
      check('Item 4: accepted_qty=0 persists return_to_stock_qty=0', Number(lineAfter.return_to_stock_qty) === 0, lineAfter.return_to_stock_qty);
      check('Item 4: accepted_qty=0 persists non_sellable_qty=0', Number(lineAfter.non_sellable_qty) === 0, lineAfter.non_sellable_qty);

      // Item 1: total accepted = 0 -> complete() must be rejected.
      await expectError('Item 1: complete() rejects when total accepted = 0', 'RETURN_NOTHING_ACCEPTED',
        () => ReturnAgent.complete(returnId, admin));

      const stockBefore = await stockOf(pA.id);
      const result = await ReturnAgent.reject(returnId, { reason: 'nothing accepted' }, admin);
      check('reject() succeeds when total accepted = 0 and fully classified', result.status === 'REJECTED', result.status);

      // Item 8: reject() never posts stock.
      check('Item 8: reject() posts zero SALES_RETURN stock rows', await salesReturnStockRowCount(returnId) === 0, await salesReturnStockRowCount(returnId));
      check('Item 8: reject() leaves product stock_quantity unchanged', await stockOf(pA.id) === stockBefore, { before: stockBefore, after: await stockOf(pA.id) });
    }

    // ══════════════════ Scenario B: disposition required when accepted > 0
    // (item 5), inspection_note vs disposition_reason_note (item 6), Complete
    // guard + single stock post + idempotent retry (items 2, 7) ══════════════════
    {
      const created = await ReturnAgent.create(orderId, {
        return_reason_code: 'QUALITY_COMPLAINT', items: [{ order_item_id: itemB.id, quantity_requested: 3 }],
      }, admin);
      const returnId = created.return_id;
      returnIds.push(returnId);
      const lineId = created.items[0].id;

      await ReturnAgent.receive(returnId, { items: [{ return_item_id: lineId, received_qty: 3 }] }, admin);

      // Item 5: accepted_qty > 0 without a valid disposition must be rejected.
      await expectError('Item 5: inspect() rejects missing disposition when accepted_qty > 0', 'RETURN_INVALID_DISPOSITION',
        () => ReturnAgent.inspect(returnId, { items: [{ return_item_id: lineId, accepted_qty: 3, rejected_qty: 0 }] }, admin));

      // Item 6: inspection_note and disposition_reason_note are distinct fields.
      await ReturnAgent.inspect(returnId, {
        items: [{
          return_item_id: lineId, accepted_qty: 3, rejected_qty: 0, disposition: 'RESTOCK',
          inspection_note: 'INSPECTION-NOTE-VALUE', disposition_reason_note: 'DISPOSITION-REASON-VALUE',
        }],
      }, admin);

      const [[inspRow]] = await pool.query(
        `SELECT inspection_note FROM sales_return_inspections WHERE return_item_id=? ORDER BY id DESC LIMIT 1`, [lineId]
      );
      const [[itemRow]] = await pool.query(`SELECT disposition_reason_note FROM sales_return_items WHERE id=?`, [lineId]);
      check('Item 6: sales_return_inspections.inspection_note stores the inspection-event note', inspRow.inspection_note === 'INSPECTION-NOTE-VALUE', inspRow.inspection_note);
      check('Item 6: sales_return_items.disposition_reason_note stores the disposition note (distinct value)', itemRow.disposition_reason_note === 'DISPOSITION-REASON-VALUE', itemRow.disposition_reason_note);
      check('Item 6: the two note fields are NOT the same value (no conflation)', inspRow.inspection_note !== itemRow.disposition_reason_note, { inspection_note: inspRow.inspection_note, disposition_reason_note: itemRow.disposition_reason_note });

      // Item 2: total accepted > 0 -> reject() must be rejected.
      await expectError('Item 2: reject() rejects when total accepted > 0', 'RETURN_HAS_ACCEPTED_QUANTITY',
        () => ReturnAgent.reject(returnId, { reason: 'should not be allowed' }, admin));

      const stockBefore = await stockOf(pB.id);
      const completeResult = await ReturnAgent.complete(returnId, admin);
      check('complete() succeeds when total accepted > 0 and fully classified', completeResult.status === 'COMPLETED', completeResult.status);

      // Item 7: exactly one SALES_RETURN stock row, stock incremented by the
      // RESTOCK qty (3), and product.stock_quantity moved by exactly that much.
      check('Item 7: complete() posts exactly one SALES_RETURN stock row', await salesReturnStockRowCount(returnId) === 1, await salesReturnStockRowCount(returnId));
      check('Item 7: product stock_quantity increased by exactly the RESTOCK qty', await stockOf(pB.id) === stockBefore + 3, { before: stockBefore, after: await stockOf(pB.id) });

      // Item 7 (idempotency): retrying complete() on an already-COMPLETED
      // return must not create a second stock row.
      await expectError('Item 7: complete() retry after COMPLETED is rejected (RETURN_INVALID_STATE)', 'RETURN_INVALID_STATE',
        () => ReturnAgent.complete(returnId, admin));
      check('Item 7: retry did not create a second SALES_RETURN stock row', await salesReturnStockRowCount(returnId) === 1, await salesReturnStockRowCount(returnId));
      check('Item 7: retry did not move stock_quantity a second time', await stockOf(pB.id) === stockBefore + 3, { before: stockBefore, after: await stockOf(pB.id) });
    }

  } finally {
    console.log('\nCleaning up...');
    for (const rid of returnIds) {
      await pool.query(`DELETE FROM sales_return_inspections WHERE return_item_id IN (SELECT id FROM sales_return_items WHERE return_id=?)`, [rid]).catch(() => {});
      await pool.query(`DELETE FROM sales_return_items WHERE return_id=?`, [rid]).catch(() => {});
      await pool.query(`DELETE FROM stock_transactions WHERE reference_type='SALES_RETURN' AND reference_id=?`, [rid]).catch(() => {});
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
    if (customerId) {
      await pool.query(`DELETE FROM debt_transactions WHERE customer_id=?`, [customerId]).catch(() => {});
      await pool.query(`DELETE FROM customer_product_catalogs WHERE customer_id=?`, [customerId]).catch(() => {});
      await pool.query(`DELETE FROM customer_product_prices WHERE customer_id=?`, [customerId]).catch(() => {});
      await pool.query(`DELETE FROM customers WHERE id=?`, [customerId]).catch(() => {});
    }
    console.log('Cleanup done.');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
