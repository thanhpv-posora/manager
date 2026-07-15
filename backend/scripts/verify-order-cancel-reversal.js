'use strict';
// S8.2 Order Cancel + Reversal — verifies:
//   Cancellation is status-change + append-only compensating ledger events only.
//   orders/order_items/stock_transactions/debt_transactions rows are NEVER deleted.
//   Inventory reversal follows order_items.inventory_mode/stock_checked (historical
//   facts frozen at sale time), never the product's CURRENT inventory_mode.
//   Bò Xô / CARCASS_PART / NON_STOCK lines never get an affect_stock=1 reversal.
//   Debt reversal is one compensating ADJUSTMENT_DECREASE row (S8.1A convention).
//   Guards reject: not-found, already-cancelled, payment_allocations, legacy direct
//   payment, paid_amount>0, locked, empty reason — before any write happens.
//   Concurrency: SELECT...FOR UPDATE serializes two simultaneous cancel() calls —
//   exactly one reversal is ever posted.
//
// Self-cleaning: throwaway customer + products + orders + payments, removed in `finally`.

const pool = require('../src/config/db');
const OrderAgent = require('../src/agents/OrderAgent');
const PaymentAgent = require('../src/agents/PaymentAgent');
const CustomerAgent = require('../src/agents/CustomerAgent');
const ProductAgent = require('../src/agents/ProductAgent');
const StockLedgerAgent = require('../src/agents/StockLedgerAgent');
const { getCustomerDebt } = require('../src/services/debt.service');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

async function makeProduct(mode, qty, allowNeg = 0) {
  const name = `S8.2 CANCEL ${mode} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await ProductAgent.addProduct({
    name, unit: 'kg', inventory_mode: mode, stock_quantity: mode === 'TRACK_STOCK' ? qty : 0, allow_negative_stock: allowNeg,
  });
  const [[created]] = await pool.query(`SELECT * FROM products WHERE name=? LIMIT 1`, [name]);
  if (mode === 'TRACK_STOCK' && qty > 0 && Number(created.stock_quantity) !== qty) {
    // addProduct's initial IN silently no-ops for non-TRACK_STOCK; for TRACK_STOCK it
    // should have applied — defensive check only, not expected to fire.
  }
  return created;
}

async function stockOf(productId) {
  const [[row]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [productId]);
  return Number(row.stock_quantity);
}

async function orderRow(orderId) {
  const [[row]] = await pool.query(`SELECT * FROM orders WHERE id=?`, [orderId]);
  return row;
}

async function debtLedgerSum(customerId) {
  const [[row]] = await pool.query(
    `SELECT COALESCE(SUM(CASE
       WHEN type IN ('SALE','ADJUSTMENT_INCREASE') THEN amount
       WHEN type IN ('PAYMENT','ADJUSTMENT_DECREASE') THEN -amount
       ELSE 0 END),0) signed_sum
     FROM debt_transactions WHERE customer_id=?`,
    [customerId]
  );
  return Number(row.signed_sum);
}

async function debtRowsForOrder(orderId) {
  const [rows] = await pool.query(`SELECT id,type,amount,order_id,customer_id FROM debt_transactions WHERE order_id=? ORDER BY id ASC`, [orderId]);
  return rows;
}

async function stockRowsForProduct(productId) {
  const [rows] = await pool.query(`SELECT id,type,quantity,reference_type,reference_id,affect_stock FROM stock_transactions WHERE product_id=? ORDER BY id ASC`, [productId]);
  return rows;
}

function assertAppendOnly(stepName, prevRows, currRows) {
  check(`${stepName}: row count never decreases (${prevRows.length} -> ${currRows.length})`, currRows.length >= prevRows.length, { prev: prevRows.length, curr: currRows.length });
  const currById = new Map(currRows.map(r => [r.id, r]));
  let unchanged = true, badId = null;
  for (const p of prevRows) {
    const c = currById.get(p.id);
    if (!c) { unchanged = false; badId = p.id; break; }
    for (const k of Object.keys(p)) {
      if (String(c[k]) !== String(p[k])) { unchanged = false; badId = p.id; break; }
    }
    if (!unchanged) break;
  }
  check(`${stepName}: no previously-posted row was deleted or rewritten`, unchanged, badId !== null ? { changedOrMissingId: badId } : undefined);
}

async function main() {
  const productIds = [];
  const orderIds = [];
  const paymentIds = [];
  const reconciliationExemptIds = new Set(); // test-only forced stock_quantity, not a ledger-driven value
  let customerId = null;
  const user = { id: null, role: 'ADMIN' };
  const today = new Date().toISOString().slice(0, 10);

  try {
    const [custIns] = await pool.query(
      `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type)
       VALUES(?,?,?,?,?,?,?,?)`,
      [`S82-CUST-${Date.now()}`, 'S8.2 Cancel Test Customer', '0', 'test', 'PRIVATE_PRICE', 0, 0, 'SOLAR']
    );
    customerId = custIns.insertId;

    // ══════════════════════ Scenario 1: cancel unpaid TRACK_STOCK order ══════════════════════
    let s1OrderId;
    {
      const p = await makeProduct('TRACK_STOCK', 100);
      productIds.push(p.id);
      const r = await OrderAgent.create({
        customer_id: customerId, order_date: today,
        items: [{ product_id: p.id, product_name: 'x', unit: 'kg', quantity: 10, sale_price: 50000, manual_price: true }],
      }, user);
      orderIds.push(r.order_id);
      s1OrderId = r.order_id;

      check('S1: stock deducted on create (100 -> 90)', await stockOf(p.id) === 90, await stockOf(p.id));
      check('S1: order debt = 500,000 on creation', (await orderRow(r.order_id)).debt_amount == 500000, (await orderRow(r.order_id)).debt_amount);
      check('S1: debt ledger sum = 500,000', await debtLedgerSum(customerId) === 500000, await debtLedgerSum(customerId));

      const stockBefore = await stockRowsForProduct(p.id);
      const debtBefore = await debtRowsForOrder(r.order_id);

      const result = await OrderAgent.cancel(r.order_id, { reason: 'S8.2 test cancel' }, user);
      check('S1: cancel() returns success message', !!result && result.order_id === r.order_id, result);

      const o = await orderRow(r.order_id);
      check('S1: order status = CANCELLED', o.status === 'CANCELLED', o.status);
      check('S1: order debt_amount = 0 after compensation', Number(o.debt_amount) === 0, o.debt_amount);
      check('S1: order total_amount unchanged (historical)', Number(o.total_amount) === 500000, o.total_amount);
      check('S1: cancelled_at/cancelled_by/cancel_reason persisted', !!o.cancelled_at && o.cancel_reason === 'S8.2 test cancel', { cancelled_at: o.cancelled_at, cancel_reason: o.cancel_reason });

      check('S1: stock restored exactly once (90 -> 100)', await stockOf(p.id) === 100, await stockOf(p.id));

      const stockAfter = await stockRowsForProduct(p.id);
      check('S1: reversal ledger row appended (ADJUSTMENT_INCREASE, ref SALE/orderId, affect_stock=1)',
        stockAfter.some(x => x.type === 'ADJUSTMENT_INCREASE' && x.reference_type === 'SALE' && Number(x.reference_id) === r.order_id && Number(x.quantity) === 10 && Number(x.affect_stock) === 1),
        stockAfter);
      assertAppendOnly('S1 stock ledger', stockBefore, stockAfter);

      check('S1: debt compensation appended (ADJUSTMENT_DECREASE 500,000 for this order)',
        (await debtRowsForOrder(r.order_id)).some(x => x.type === 'ADJUSTMENT_DECREASE' && Number(x.amount) === 500000),
        await debtRowsForOrder(r.order_id));
      assertAppendOnly('S1 debt ledger', debtBefore, await debtRowsForOrder(r.order_id));

      check('S1: customer debt ledger sum reduced to 0', await debtLedgerSum(customerId) === 0, await debtLedgerSum(customerId));

      const recon = await StockLedgerAgent.reconciliation({ product_id: p.id });
      check('S1: reconciliation OK after cancel', recon.items[0].status === 'OK', JSON.stringify(recon.items[0]));

      const custRows = await CustomerAgent.list(user);
      const custRow = custRows.find(c => Number(c.id) === Number(customerId));
      check('S1: CustomerAgent.list() current_debt = 0 after cancel', !!custRow && Number(custRow.current_debt) === 0, custRow && custRow.current_debt);

      const aiRows = await getCustomerDebt('S8.2 Cancel Test Customer');
      const aiRow = aiRows.find(c => Number(c.id) === Number(customerId));
      check('S1: AI debt lookup = 0 after cancel', !!aiRow && Number(aiRow.debt_amount) === 0, aiRow && aiRow.debt_amount);
    }

    // ══════════════════════ Scenario 2: cancel CARCASS_PART order (Bò Xô) ══════════════════════
    {
      const p = await makeProduct('CARCASS_PART', 0);
      productIds.push(p.id);
      const r = await OrderAgent.create({
        customer_id: customerId, order_date: today,
        items: [{ product_id: p.id, product_name: 'boxo', unit: 'kg', quantity: 5, sale_price: 80000, manual_price: true }],
      }, user);
      orderIds.push(r.order_id);
      check('S2: CARCASS_PART stock_quantity unchanged on create', await stockOf(p.id) === 0, await stockOf(p.id));
      const [[item]] = await pool.query(`SELECT stock_checked FROM order_items WHERE order_id=?`, [r.order_id]);
      check('S2: order_items.stock_checked=0 recorded for CARCASS_PART line', Number(item.stock_checked) === 0, item.stock_checked);

      await OrderAgent.cancel(r.order_id, { reason: 'S8.2 boxo cancel' }, user);
      check('S2: CARCASS_PART stock_quantity still unchanged after cancel', await stockOf(p.id) === 0, await stockOf(p.id));
      const stockAfter = await stockRowsForProduct(p.id);
      check('S2: no affect_stock=1 reversal row created for CARCASS_PART line', !stockAfter.some(x => Number(x.affect_stock) === 1), stockAfter);
      check('S2: order status = CANCELLED', (await orderRow(r.order_id)).status === 'CANCELLED');
    }

    // ══════════════════════ Scenario 3: cancel NON_STOCK order ══════════════════════
    {
      const p = await makeProduct('NON_STOCK', 0);
      productIds.push(p.id);
      const r = await OrderAgent.create({
        customer_id: customerId, order_date: today,
        items: [{ product_id: p.id, product_name: 'service', unit: 'kg', quantity: 2, sale_price: 30000, manual_price: true }],
      }, user);
      orderIds.push(r.order_id);
      await OrderAgent.cancel(r.order_id, { reason: 'S8.2 nonstock cancel' }, user);
      check('S3: NON_STOCK stock_quantity unchanged after cancel', await stockOf(p.id) === 0, await stockOf(p.id));
      check('S3: order status = CANCELLED', (await orderRow(r.order_id)).status === 'CANCELLED');
    }

    // ══════════════════════ Scenario 4: cancel mixed-mode order (same category) ══════════════════════
    {
      const [[cat]] = await pool.query(`SELECT id FROM product_categories LIMIT 1`);
      const pTrack = await makeProduct('TRACK_STOCK', 40);
      const pCarcass = await makeProduct('CARCASS_PART', 0);
      productIds.push(pTrack.id, pCarcass.id);
      await pool.query(`UPDATE products SET category_id=? WHERE id IN (?,?)`, [cat.id, pTrack.id, pCarcass.id]);

      const r = await OrderAgent.create({
        customer_id: customerId, order_date: today,
        items: [
          { product_id: pTrack.id, product_name: 'trackline', unit: 'kg', quantity: 6, sale_price: 40000, manual_price: true },
          { product_id: pCarcass.id, product_name: 'boxoline', unit: 'kg', quantity: 3, sale_price: 60000, manual_price: true },
        ],
      }, user);
      orderIds.push(r.order_id);
      check('S4: TRACK_STOCK line deducted (40 -> 34)', await stockOf(pTrack.id) === 34, await stockOf(pTrack.id));
      check('S4: CARCASS_PART line unaffected (0)', await stockOf(pCarcass.id) === 0, await stockOf(pCarcass.id));

      await OrderAgent.cancel(r.order_id, { reason: 'S8.2 mixed cancel' }, user);
      check('S4: TRACK_STOCK line restored (34 -> 40)', await stockOf(pTrack.id) === 40, await stockOf(pTrack.id));
      check('S4: CARCASS_PART line still unaffected (0) after cancel', await stockOf(pCarcass.id) === 0, await stockOf(pCarcass.id));
    }

    // ══════════════════════ Scenario 5: cancel already-cancelled order ══════════════════════
    {
      const before = await debtRowsForOrder(s1OrderId);
      const [[prod]] = await pool.query(`SELECT product_id FROM order_items WHERE order_id=? LIMIT 1`, [s1OrderId]);
      const stockBefore = await stockRowsForProduct(prod.product_id);
      let threw = null;
      try { await OrderAgent.cancel(s1OrderId, { reason: 'second attempt' }, user); } catch (e) { threw = e; }
      check('S5: cancelling an already-cancelled order is rejected', !!threw, threw && threw.message);
      check('S5: no second debt reversal posted', (await debtRowsForOrder(s1OrderId)).length === before.length, { before: before.length, after: (await debtRowsForOrder(s1OrderId)).length });
      check('S5: no second stock reversal posted', (await stockRowsForProduct(prod.product_id)).length === stockBefore.length, { before: stockBefore.length, after: (await stockRowsForProduct(prod.product_id)).length });
    }

    // ══════════════════════ Scenario 6: two concurrent cancel requests ══════════════════════
    {
      const p = await makeProduct('TRACK_STOCK', 60);
      productIds.push(p.id);
      const r = await OrderAgent.create({
        customer_id: customerId, order_date: today,
        items: [{ product_id: p.id, product_name: 'concurrent', unit: 'kg', quantity: 8, sale_price: 25000, manual_price: true }],
      }, user);
      orderIds.push(r.order_id);
      check('S6: stock deducted before concurrent cancel (60 -> 52)', await stockOf(p.id) === 52, await stockOf(p.id));

      const results = await Promise.allSettled([
        OrderAgent.cancel(r.order_id, { reason: 'concurrent A' }, user),
        OrderAgent.cancel(r.order_id, { reason: 'concurrent B' }, user),
      ]);
      const fulfilled = results.filter(x => x.status === 'fulfilled');
      const rejected = results.filter(x => x.status === 'rejected');
      check('S6: exactly one of the two concurrent cancels succeeded', fulfilled.length === 1, results.map(x => x.status));
      check('S6: exactly one of the two concurrent cancels was rejected', rejected.length === 1, results.map(x => x.status));
      check('S6: stock restored exactly once, not twice (52 -> 60)', await stockOf(p.id) === 60, await stockOf(p.id));
      const revRows = (await stockRowsForProduct(p.id)).filter(x => x.type === 'ADJUSTMENT_INCREASE' && Number(x.reference_id) === r.order_id);
      check('S6: exactly one reversal stock row for this order', revRows.length === 1, revRows);
      const debtRevRows = (await debtRowsForOrder(r.order_id)).filter(x => x.type === 'ADJUSTMENT_DECREASE');
      check('S6: exactly one debt reversal row for this order', debtRevRows.length === 1, debtRevRows);
    }

    // ══════════════════════ Scenario 7: payment guard (3 independent paths) ══════════════════════
    {
      // 7a: payment_allocations row exists.
      const p = await makeProduct('TRACK_STOCK', 30);
      productIds.push(p.id);
      const r = await OrderAgent.create({
        customer_id: customerId, order_date: today,
        items: [{ product_id: p.id, product_name: 'alloc', unit: 'kg', quantity: 4, sale_price: 20000, manual_price: true }],
      }, user);
      orderIds.push(r.order_id);
      const [payIns] = await pool.query(
        `INSERT INTO payments(payment_code,customer_id,order_id,payment_date,payment_method,amount,cash_amount,bank_amount,created_by)
         VALUES(?,?,?,?,?,?,?,?,?)`,
        [`S82PAY-${Date.now()}`, customerId, r.order_id, today, 'CASH', 20000, 20000, 0, null]
      );
      paymentIds.push(payIns.insertId);
      await pool.query(
        `INSERT INTO payment_allocations(payment_id,order_id,customer_id,amount,allocation_type) VALUES(?,?,?,?,?)`,
        [payIns.insertId, r.order_id, customerId, 20000, 'DIRECT']
      );
      const beforeStock = await stockOf(p.id);
      const beforeOrder = await orderRow(r.order_id);
      let threw7a = null;
      try { await OrderAgent.cancel(r.order_id, { reason: 'blocked by allocation' }, user); } catch (e) { threw7a = e; }
      check('S7a: order with payment_allocations is rejected', !!threw7a, threw7a && threw7a.message);
      check('S7a: no stock change on rejected cancel', await stockOf(p.id) === beforeStock, await stockOf(p.id));
      check('S7a: no status/debt change on rejected cancel', (await orderRow(r.order_id)).status === beforeOrder.status && Number((await orderRow(r.order_id)).debt_amount) === Number(beforeOrder.debt_amount));

      // 7b: legacy direct payment (payments.order_id set, no allocation row).
      const p2 = await makeProduct('TRACK_STOCK', 30);
      productIds.push(p2.id);
      const r2 = await OrderAgent.create({
        customer_id: customerId, order_date: today,
        items: [{ product_id: p2.id, product_name: 'direct', unit: 'kg', quantity: 4, sale_price: 20000, manual_price: true }],
      }, user);
      orderIds.push(r2.order_id);
      const [payIns2] = await pool.query(
        `INSERT INTO payments(payment_code,customer_id,order_id,payment_date,payment_method,amount,cash_amount,bank_amount,created_by)
         VALUES(?,?,?,?,?,?,?,?,?)`,
        [`S82PAY2-${Date.now()}`, customerId, r2.order_id, today, 'CASH', 15000, 15000, 0, null]
      );
      paymentIds.push(payIns2.insertId);
      let threw7b = null;
      try { await OrderAgent.cancel(r2.order_id, { reason: 'blocked by legacy direct payment' }, user); } catch (e) { threw7b = e; }
      check('S7b: order with a legacy direct payment (no allocation) is rejected', !!threw7b, threw7b && threw7b.message);
      check('S7b: no stock change on rejected cancel', await stockOf(p2.id) === 26, await stockOf(p2.id));

      // 7c: orders.paid_amount > 0 directly (defense-in-depth, no payment row at all).
      const p3 = await makeProduct('TRACK_STOCK', 30);
      productIds.push(p3.id);
      const r3 = await OrderAgent.create({
        customer_id: customerId, order_date: today,
        items: [{ product_id: p3.id, product_name: 'paidflag', unit: 'kg', quantity: 4, sale_price: 20000, manual_price: true }],
      }, user);
      orderIds.push(r3.order_id);
      await pool.query(`UPDATE orders SET paid_amount=? WHERE id=?`, [10000, r3.order_id]);
      let threw7c = null;
      try { await OrderAgent.cancel(r3.order_id, { reason: 'blocked by paid_amount' }, user); } catch (e) { threw7c = e; }
      check('S7c: order with paid_amount>0 is rejected even with no payment rows', !!threw7c, threw7c && threw7c.message);
      await pool.query(`UPDATE orders SET paid_amount=0 WHERE id=?`, [r3.order_id]); // reset so cleanup's cancel-less delete is consistent
    }

    // ══════════════════════ Scenario 8: locked order ══════════════════════
    {
      const p = await makeProduct('TRACK_STOCK', 30);
      productIds.push(p.id);
      const r = await OrderAgent.create({
        customer_id: customerId, order_date: today,
        items: [{ product_id: p.id, product_name: 'locked', unit: 'kg', quantity: 3, sale_price: 15000, manual_price: true }],
      }, user);
      orderIds.push(r.order_id);
      await OrderAgent.lock(r.order_id, {}, user);
      let threw = null;
      try { await OrderAgent.cancel(r.order_id, { reason: 'blocked by lock' }, user); } catch (e) { threw = e; }
      check('S8: locked order cancel is rejected (no admin-override path exists yet, so ADMIN is blocked too)', !!threw, threw && threw.message);
      check('S8: order remains DELIVERED (not CANCELLED) after rejected attempt', (await orderRow(r.order_id)).status !== 'CANCELLED', (await orderRow(r.order_id)).status);
      check('S8: stock unchanged after rejected attempt', await stockOf(p.id) === 27, await stockOf(p.id));
    }

    // ══════════════════════ Scenario 9: missing cancellation reason ══════════════════════
    {
      const p = await makeProduct('TRACK_STOCK', 30);
      productIds.push(p.id);
      const r = await OrderAgent.create({
        customer_id: customerId, order_date: today,
        items: [{ product_id: p.id, product_name: 'noreason', unit: 'kg', quantity: 2, sale_price: 10000, manual_price: true }],
      }, user);
      orderIds.push(r.order_id);
      let threw = null;
      try { await OrderAgent.cancel(r.order_id, { reason: '' }, user); } catch (e) { threw = e; }
      check('S9: empty reason is rejected', !!threw, threw && threw.message);
      let threw2 = null;
      try { await OrderAgent.cancel(r.order_id, {}, user); } catch (e) { threw2 = e; }
      check('S9: missing reason field is rejected', !!threw2, threw2 && threw2.message);
      check('S9: order untouched, still DELIVERED', (await orderRow(r.order_id)).status === 'DELIVERED', (await orderRow(r.order_id)).status);
      check('S9: stock untouched', await stockOf(p.id) === 28, await stockOf(p.id));
      // Clean up this one properly since it was never cancelled.
      await OrderAgent.cancel(r.order_id, { reason: 'cleanup' }, user);
    }

    // ══════════════════════ Scenario 10: inventory_mode changed AFTER the sale ══════════════════════
    {
      // 10a: was TRACK_STOCK at sale time (stock_checked=1), later reconfigured to CARCASS_PART.
      // Reversal must still follow the historical stock_checked=1 fact and restore stock.
      const p = await makeProduct('TRACK_STOCK', 50);
      productIds.push(p.id);
      const r = await OrderAgent.create({
        customer_id: customerId, order_date: today,
        items: [{ product_id: p.id, product_name: 'modeflip', unit: 'kg', quantity: 5, sale_price: 12000, manual_price: true }],
      }, user);
      orderIds.push(r.order_id);
      check('S10a: stock deducted at sale time (50 -> 45)', await stockOf(p.id) === 45, await stockOf(p.id));
      await pool.query(`UPDATE products SET inventory_mode='CARCASS_PART' WHERE id=?`, [p.id]);
      const [[item]] = await pool.query(`SELECT inventory_mode, stock_checked FROM order_items WHERE order_id=?`, [r.order_id]);
      check('S10a: order_items retains its ORIGINAL frozen inventory_mode/stock_checked despite product being reconfigured', Number(item.stock_checked) === 1, item);

      await OrderAgent.cancel(r.order_id, { reason: 'S8.2 mode-flip cancel' }, user);
      check('S10a: reversal follows the HISTORICAL fact (stock_checked=1) — stock restored despite product now being CARCASS_PART (45 -> 50)', await stockOf(p.id) === 50, await stockOf(p.id));

      // 10b: was CARCASS_PART at sale time (stock_checked=0), later reconfigured to TRACK_STOCK.
      // Reversal must NOT touch stock, even though the product looks like TRACK_STOCK now.
      const p2 = await makeProduct('CARCASS_PART', 0);
      productIds.push(p2.id);
      const r2 = await OrderAgent.create({
        customer_id: customerId, order_date: today,
        items: [{ product_id: p2.id, product_name: 'modeflip2', unit: 'kg', quantity: 5, sale_price: 12000, manual_price: true }],
      }, user);
      orderIds.push(r2.order_id);
      // Forcing stock_quantity here directly (no matching ledger row) is a test-only
      // artifact to simulate "product now looks TRACK_STOCK with some stock" — it
      // deliberately makes this product's ledger/cache reconciliation meaningless,
      // so it is excluded from the Scenario 12 reconciliation sweep below.
      await pool.query(`UPDATE products SET inventory_mode='TRACK_STOCK', stock_quantity=20 WHERE id=?`, [p2.id]);
      reconciliationExemptIds.add(p2.id);
      await OrderAgent.cancel(r2.order_id, { reason: 'S8.2 mode-flip cancel 2' }, user);
      check('S10b: reversal follows the HISTORICAL fact (stock_checked=0) — stock stays untouched (20) despite product now being TRACK_STOCK', await stockOf(p2.id) === 20, await stockOf(p2.id));
    }

    // ══════════════════════ Scenario 11: ledger append-only, re-verified end to end ══════════════════════
    {
      const [[saleRow]] = await pool.query(`SELECT amount, type FROM debt_transactions WHERE order_id=? AND type='SALE'`, [s1OrderId]);
      check('S11: S1 original SALE debt row is still exactly 500,000 (never rewritten)', saleRow && Number(saleRow.amount) === 500000 && saleRow.type === 'SALE', saleRow);
      const [[prod]] = await pool.query(`SELECT product_id FROM order_items WHERE order_id=? LIMIT 1`, [s1OrderId]);
      const [[outRow]] = await pool.query(`SELECT type, quantity FROM stock_transactions WHERE product_id=? AND reference_id=? AND type='OUT' LIMIT 1`, [prod.product_id, s1OrderId]);
      check('S11: S1 original OUT stock row is still exactly 10 (never rewritten)', outRow && Number(outRow.quantity) === 10 && outRow.type === 'OUT', outRow);
    }

    // ══════════════════════ Scenario 12: reconciliation across every TRACK_STOCK product used ══════════════════════
    {
      const reconciliationIds = productIds.filter(id => !reconciliationExemptIds.has(id));
      const [trackProducts] = await pool.query(
        `SELECT id FROM products WHERE id IN (?) AND inventory_mode='TRACK_STOCK'`, [reconciliationIds.length ? reconciliationIds : [0]]
      );
      let allOk = true;
      const bad = [];
      for (const p of trackProducts) {
        const recon = await StockLedgerAgent.reconciliation({ product_id: p.id });
        if (!recon.items.length || recon.items[0].status !== 'OK') { allOk = false; bad.push(recon.items[0]); }
      }
      check('S12: reconciliation OK for every TRACK_STOCK product touched by this script', allOk, bad);
    }

    // ══════════════════════ Scenario 13: customer debt + AI debt consistency after all cancellations ══════════════════════
    {
      const [[sumRow]] = await pool.query(
        `SELECT COALESCE(SUM(debt_amount),0) total FROM orders WHERE customer_id=? AND status<>'CANCELLED'`, [customerId]
      );
      const ledgerSum = await debtLedgerSum(customerId);
      check('S13: customer debt ledger sum matches SUM(orders.debt_amount) for non-cancelled orders', Number(sumRow.total) === ledgerSum, { orders_sum: sumRow.total, ledger_sum: ledgerSum });
      const custRows = await CustomerAgent.list(user);
      const custRow = custRows.find(c => Number(c.id) === Number(customerId));
      const aiRows = await getCustomerDebt('S8.2 Cancel Test Customer');
      const aiRow = aiRows.find(c => Number(c.id) === Number(customerId));
      check('S13: CustomerAgent.list() and AI debt lookup agree', !!custRow && !!aiRow && Number(custRow.current_debt) === Number(aiRow.debt_amount), { customer_list: custRow && custRow.current_debt, ai: aiRow && aiRow.debt_amount });
    }

    // ══════════════════════ Scenario 14: retry after simulated timeout — no duplicate reversal ══════════════════════
    {
      const p = await makeProduct('TRACK_STOCK', 40);
      productIds.push(p.id);
      const r = await OrderAgent.create({
        customer_id: customerId, order_date: today,
        items: [{ product_id: p.id, product_name: 'retry', unit: 'kg', quantity: 6, sale_price: 18000, manual_price: true }],
      }, user);
      orderIds.push(r.order_id);

      const first = await OrderAgent.cancel(r.order_id, { reason: 'first attempt (client never saw the response)' }, user);
      check('S14: first cancel attempt succeeds', !!first && first.order_id === r.order_id);
      const stockAfterFirst = await stockOf(p.id);
      const debtRowsAfterFirst = await debtRowsForOrder(r.order_id);

      // Client retries with the SAME semantics (simulated timeout — it doesn't know attempt 1 succeeded).
      let retryThrew = null;
      try { await OrderAgent.cancel(r.order_id, { reason: 'retry after timeout' }, user); } catch (e) { retryThrew = e; }
      check('S14: retry after "timeout" is rejected (already cancelled)', !!retryThrew, retryThrew && retryThrew.message);
      check('S14: stock unchanged by the retry', await stockOf(p.id) === stockAfterFirst, { after_first: stockAfterFirst, after_retry: await stockOf(p.id) });
      check('S14: no duplicate reversal row from the retry', (await debtRowsForOrder(r.order_id)).length === debtRowsAfterFirst.length, { after_first: debtRowsAfterFirst.length, after_retry: (await debtRowsForOrder(r.order_id)).length });
    }

  } finally {
    for (const pid of paymentIds) {
      await pool.query(`DELETE FROM payment_allocations WHERE payment_id=?`, [pid]).catch(() => {});
      await pool.query(`DELETE FROM payments WHERE id=?`, [pid]).catch(() => {});
    }
    for (const oid of orderIds) {
      await pool.query(`DELETE FROM payment_allocations WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM payments WHERE order_id=?`, [oid]).catch(() => {});
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
