'use strict';
// MIXED SALES PHASE 1A verification.
//
// Covers, against OrderAgent.create()'s new deriveItemsSalesFlow() (schema-only +
// write-time derivation — InventoryPolicyResolver/InventoryMovementService/
// InventoryService are NOT touched by Phase 1A and are exercised here only
// through their existing, unmodified call surface):
//
//  1) CARCASS-only bill      -> header sales_flow=CARCASS_POS, item sales_flow=CARCASS_POS, no stock impact.
//  2) TRACK_STOCK-only bill  -> header sales_flow=INVENTORY_SALE, item sales_flow=INVENTORY_SALE, stock OUT written.
//  3) Mixed bill (1 CARCASS_PART + 1 TRACK_STOCK item) -> header sales_flow=MIXED, each item keeps
//     its own branch, exactly one orders row + one debt_transactions SALE row (single lifecycle).
//  4) INVENTORY_SALE item with allow_negative_stock=1 -> whole bill rejected, nothing committed.
//  5) Mixed bill where the TRACK_STOCK item's quantity exceeds stock -> whole bill rolled back:
//     no orders row, no order_items rows, no stock_transactions rows, even for the CARCASS_PART
//     line that would otherwise have succeeded on its own.
//  6) Legacy caller compatibility: a NON_STOCK-only bill, submitted exactly as a pre-Phase-1A
//     caller would (no sales_flow field at all) -> explicitly REJECTED with
//     SALES_FLOW_NON_STOCK_NOT_SUPPORTED. This is a deliberate, reported behavior change, not a
//     silent misclassification — Phase 1A does not invent a branch for NON_STOCK. A CARCASS_PART-only
//     legacy-shaped call (also no sales_flow field) still succeeds unchanged, proving the derivation
//     does not require the caller to send anything new.
//
// Self-cleaning: throwaway customer + products + orders + price book, removed in `finally`
// regardless of pass/fail. Touches no pre-existing data.

const pool = require('../src/config/db');
const ProductAgent = require('../src/agents/ProductAgent');
const OrderAgent = require('../src/agents/OrderAgent');
const PriceMatrixAgent = require('../src/agents/PriceMatrixAgent');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}

async function getProduct(id) {
  const [[row]] = await pool.query(`SELECT * FROM products WHERE id=?`, [id]);
  return row;
}

async function makeProduct(mode, { stock = 0, allowNegative = 0, categoryId }) {
  const tag = `P1A ${mode} ${allowNegative ? 'NEG' : 'STD'} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await ProductAgent.addProduct({
    name: tag, unit: 'kg', category_id: categoryId,
    inventory_mode: mode, stock_quantity: stock, allow_negative_stock: allowNegative,
  });
  const [[created]] = await pool.query(`SELECT * FROM products WHERE name=? LIMIT 1`, [tag]);
  return created;
}

async function main() {
  const productIds = [];
  const orderIds = [];
  let customerId = null;
  let categoryId = null;
  let priceCategoryId = null;
  const bookIds = [];
  const today = new Date().toISOString().slice(0, 10);
  const user = { id: null, role: 'ADMIN' };

  try {
    // ── Setup ──
    const [[cat]] = await pool.query(`SELECT id FROM product_categories WHERE del_flg=0 LIMIT 1`);
    categoryId = cat.id;

    const [custIns] = await pool.query(
      `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type)
       VALUES(?,?,?,?,?,?,?,?)`,
      [`P1ATEST-${Date.now()}`, 'Phase 1A Mixed Sales Test Customer', '0', 'test', 'PRIVATE_PRICE', 0, 0, 'SOLAR']
    );
    customerId = custIns.insertId;

    const pCarcass = await makeProduct('CARCASS_PART', { categoryId });
    const pTrack = await makeProduct('TRACK_STOCK', { stock: 20, allowNegative: 0, categoryId });
    const pTrackNeg = await makeProduct('TRACK_STOCK', { stock: 5, allowNegative: 1, categoryId });
    const pTrackLow = await makeProduct('TRACK_STOCK', { stock: 2, allowNegative: 0, categoryId });
    const pNonStock = await makeProduct('NON_STOCK', { categoryId });
    productIds.push(pCarcass.id, pTrack.id, pTrackNeg.id, pTrackLow.id, pNonStock.id);

    const cpc = await PriceMatrixAgent.createCustomerPriceCategory(customerId, categoryId, {});
    priceCategoryId = cpc.id;
    await PriceMatrixAgent.saveMatrix(
      customerId,
      [
        { product_id: pCarcass.id, private_price: 70000, in_catalog: true },
        { product_id: pTrack.id, private_price: 50000, in_catalog: true },
        { product_id: pTrackNeg.id, private_price: 60000, in_catalog: true },
        { product_id: pTrackLow.id, private_price: 55000, in_catalog: true },
        { product_id: pNonStock.id, private_price: 80000, in_catalog: true },
      ],
      null,
      { effective_from: '2024-01-01', effective_calendar_type: 'SOLAR' },
      categoryId
    );
    const [books] = await pool.query(`SELECT id FROM customer_price_books WHERE customer_id=?`, [customerId]);
    books.forEach(b => bookIds.push(b.id));

    const billItem = (p, qty) => ({ product_id: p.id, product_name: p.name, unit: 'kg', quantity: qty, sale_price: 1000, manual_price: true });

    // ══════════════════ 1) CARCASS-only bill ══════════════════
    {
      const before = await getProduct(pCarcass.id);
      const r = await OrderAgent.create({ customer_id: customerId, order_date: today, items: [billItem(pCarcass, 3)] }, user);
      orderIds.push(r.order_id);
      const [[order]] = await pool.query(`SELECT sales_flow FROM orders WHERE id=?`, [r.order_id]);
      const [[item]] = await pool.query(`SELECT sales_flow, stock_checked FROM order_items WHERE order_id=?`, [r.order_id]);
      const after = await getProduct(pCarcass.id);
      check('1. CARCASS-only: header sales_flow=CARCASS_POS', order.sales_flow === 'CARCASS_POS', order.sales_flow);
      check('1. CARCASS-only: item sales_flow=CARCASS_POS', item.sales_flow === 'CARCASS_POS', item.sales_flow);
      check('1. CARCASS-only: no stock impact (stock_quantity unchanged)', Number(after.stock_quantity) === Number(before.stock_quantity), `${before.stock_quantity} -> ${after.stock_quantity}`);
      check('1. CARCASS-only: item stock_checked=0', Number(item.stock_checked) === 0, item.stock_checked);
    }

    // ══════════════════ 2) TRACK_STOCK-only bill ══════════════════
    {
      const before = await getProduct(pTrack.id);
      const r = await OrderAgent.create({ customer_id: customerId, order_date: today, items: [billItem(pTrack, 5)] }, user);
      orderIds.push(r.order_id);
      const [[order]] = await pool.query(`SELECT sales_flow FROM orders WHERE id=?`, [r.order_id]);
      const [[item]] = await pool.query(`SELECT sales_flow, stock_checked FROM order_items WHERE order_id=?`, [r.order_id]);
      const after = await getProduct(pTrack.id);
      const [[ledger]] = await pool.query(
        `SELECT * FROM stock_transactions WHERE product_id=? AND reference_type='SALE' AND reference_id=? AND type='OUT'`,
        [pTrack.id, r.order_id]
      );
      check('2. TRACK_STOCK-only: header sales_flow=INVENTORY_SALE', order.sales_flow === 'INVENTORY_SALE', order.sales_flow);
      check('2. TRACK_STOCK-only: item sales_flow=INVENTORY_SALE', item.sales_flow === 'INVENTORY_SALE', item.sales_flow);
      check('2. TRACK_STOCK-only: stock decreased by 5', Number(after.stock_quantity) === Number(before.stock_quantity) - 5, `${before.stock_quantity} -> ${after.stock_quantity}`);
      check('2. TRACK_STOCK-only: stock_transactions OUT row written', !!ledger, ledger);
    }

    // ══════════════════ 3) Mixed bill ══════════════════
    {
      const beforeCarcass = await getProduct(pCarcass.id);
      const beforeTrack = await getProduct(pTrack.id); // 15 remaining after scenario 2
      const r = await OrderAgent.create({
        customer_id: customerId, order_date: today,
        items: [billItem(pCarcass, 2), billItem(pTrack, 3)]
      }, user);
      orderIds.push(r.order_id);
      const [[order]] = await pool.query(`SELECT sales_flow FROM orders WHERE id=?`, [r.order_id]);
      const [items] = await pool.query(`SELECT product_id, sales_flow FROM order_items WHERE order_id=? ORDER BY id`, [r.order_id]);
      const [orderRows] = await pool.query(`SELECT id FROM orders WHERE id=?`, [r.order_id]);
      const [debtRows] = await pool.query(`SELECT * FROM debt_transactions WHERE order_id=?`, [r.order_id]);
      const afterCarcass = await getProduct(pCarcass.id);
      const afterTrack = await getProduct(pTrack.id);

      const carcassItem = items.find(i => Number(i.product_id) === Number(pCarcass.id));
      const trackItem = items.find(i => Number(i.product_id) === Number(pTrack.id));

      check('3. Mixed: header sales_flow=MIXED', order.sales_flow === 'MIXED', order.sales_flow);
      check('3. Mixed: CARCASS_PART item flow=CARCASS_POS', carcassItem && carcassItem.sales_flow === 'CARCASS_POS', carcassItem);
      check('3. Mixed: TRACK_STOCK item flow=INVENTORY_SALE', trackItem && trackItem.sales_flow === 'INVENTORY_SALE', trackItem);
      check('3. Mixed: exactly one orders row for this bill', orderRows.length === 1, orderRows.length);
      check('3. Mixed: exactly one debt_transactions SALE row (single lifecycle)', debtRows.length === 1 && debtRows[0].type === 'SALE', debtRows);
      check('3. Mixed: CARCASS_PART stock unaffected', Number(afterCarcass.stock_quantity) === Number(beforeCarcass.stock_quantity), `${beforeCarcass.stock_quantity} -> ${afterCarcass.stock_quantity}`);
      check('3. Mixed: TRACK_STOCK stock decreased by 3', Number(afterTrack.stock_quantity) === Number(beforeTrack.stock_quantity) - 3, `${beforeTrack.stock_quantity} -> ${afterTrack.stock_quantity}`);
    }

    // ══════════════════ 4) INVENTORY_SALE with allow_negative_stock=1 ══════════════════
    {
      const before = await getProduct(pTrackNeg.id);
      const [[orderCountBefore]] = await pool.query(`SELECT COUNT(*) c FROM orders WHERE customer_id=?`, [customerId]);
      let threw = null;
      try { await OrderAgent.create({ customer_id: customerId, order_date: today, items: [billItem(pTrackNeg, 40)] }, user); }
      catch (e) { threw = e; }
      const after = await getProduct(pTrackNeg.id);
      const [[orderCountAfter]] = await pool.query(`SELECT COUNT(*) c FROM orders WHERE customer_id=?`, [customerId]);
      check('4. allow_negative_stock=1: whole bill rejected', threw && threw.code === 'SALES_FLOW_NEGATIVE_STOCK_NOT_ALLOWED', threw && threw.message);
      check('4. allow_negative_stock=1: stock unchanged', Number(after.stock_quantity) === Number(before.stock_quantity), `${before.stock_quantity} -> ${after.stock_quantity}`);
      check('4. allow_negative_stock=1: no order row created', Number(orderCountAfter.c) === Number(orderCountBefore.c), `${orderCountBefore.c} -> ${orderCountAfter.c}`);
    }

    // ══════════════════ 5) Mixed bill, insufficient warehouse stock ══════════════════
    {
      const beforeCarcass = await getProduct(pCarcass.id);
      const beforeLow = await getProduct(pTrackLow.id); // stock=2
      const [[orderCountBefore]] = await pool.query(`SELECT COUNT(*) c FROM orders WHERE customer_id=?`, [customerId]);
      let threw = null;
      try {
        await OrderAgent.create({
          customer_id: customerId, order_date: today,
          items: [billItem(pCarcass, 1), billItem(pTrackLow, 999)] // 999 far exceeds stock=2
        }, user);
      } catch (e) { threw = e; }
      const afterCarcass = await getProduct(pCarcass.id);
      const afterLow = await getProduct(pTrackLow.id);
      const [[orderCountAfter]] = await pool.query(`SELECT COUNT(*) c FROM orders WHERE customer_id=?`, [customerId]);
      const [[itemCount]] = await pool.query(
        `SELECT COUNT(*) c FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.customer_id=? AND oi.product_id=?`,
        [customerId, pCarcass.id]
      );

      check('5. Mixed insufficient stock: whole bill rejected', threw && /Không đủ tồn kho/.test(threw.message), threw && threw.message);
      check('5. Mixed insufficient stock: no new order row (rolled back)', Number(orderCountAfter.c) === Number(orderCountBefore.c), `${orderCountBefore.c} -> ${orderCountAfter.c}`);
      check('5. Mixed insufficient stock: CARCASS_PART stock unaffected (nothing committed)', Number(afterCarcass.stock_quantity) === Number(beforeCarcass.stock_quantity), `${beforeCarcass.stock_quantity} -> ${afterCarcass.stock_quantity}`);
      check('5. Mixed insufficient stock: TRACK_STOCK stock unaffected (rolled back)', Number(afterLow.stock_quantity) === Number(beforeLow.stock_quantity), `${beforeLow.stock_quantity} -> ${afterLow.stock_quantity}`);
      // pCarcass appears in scenario 1 and 3 already (2 prior rows) — this must not add a 3rd.
      check('5. Mixed insufficient stock: no orphaned CARCASS_PART order_items row from the rolled-back bill', Number(itemCount.c) === 2, itemCount.c);
    }

    // ══════════════════ 6) Legacy caller compatibility ══════════════════
    {
      // 6a. NON_STOCK-only bill, exactly as a pre-Phase-1A caller would send it
      // (no sales_flow field in the payload at all) -> explicitly rejected, not
      // silently misclassified into either branch.
      let threw = null;
      try { await OrderAgent.create({ customer_id: customerId, order_date: today, items: [billItem(pNonStock, 1)] }, user); }
      catch (e) { threw = e; }
      check('6a. Legacy NON_STOCK-only call: explicitly rejected (SALES_FLOW_NON_STOCK_NOT_SUPPORTED), not silently misclassified',
        threw && threw.code === 'SALES_FLOW_NON_STOCK_NOT_SUPPORTED', threw && threw.message);

      // 6b. CARCASS_PART-only bill, also with no sales_flow field sent (legacy-shaped
      // payload) -> still succeeds and is still correctly derived, proving the
      // derivation needs nothing new from the caller.
      const r = await OrderAgent.create({ customer_id: customerId, order_date: today, items: [billItem(pCarcass, 1)] }, user);
      orderIds.push(r.order_id);
      const [[order]] = await pool.query(`SELECT sales_flow FROM orders WHERE id=?`, [r.order_id]);
      check('6b. Legacy-shaped CARCASS_PART-only call (no sales_flow field sent): still succeeds, still correctly derived CARCASS_POS',
        order.sales_flow === 'CARCASS_POS', order.sales_flow);
    }

  } finally {
    for (const oid of orderIds) {
      if (!oid) continue;
      await pool.query(`DELETE FROM stock_transactions WHERE reference_type='SALE' AND reference_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM order_items WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM debt_transactions WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM orders WHERE id=?`, [oid]).catch(() => {});
    }
    for (const id of productIds) {
      await pool.query(`DELETE FROM stock_transactions WHERE product_id=?`, [id]).catch(() => {});
      await pool.query(`DELETE FROM customer_product_prices WHERE product_id=?`, [id]).catch(() => {});
      await pool.query(`DELETE FROM products WHERE id=?`, [id]).catch(() => {});
    }
    for (const bookId of bookIds) {
      await pool.query(`DELETE FROM customer_price_book_items WHERE price_book_id=?`, [bookId]).catch(() => {});
      await pool.query(`DELETE FROM customer_price_books WHERE id=?`, [bookId]).catch(() => {});
    }
    if (priceCategoryId) await pool.query(`DELETE FROM customer_price_categories WHERE id=?`, [priceCategoryId]).catch(() => {});
    if (customerId) {
      await pool.query(`DELETE FROM price_change_logs WHERE customer_id=?`, [customerId]).catch(() => {});
      await pool.query(`DELETE FROM customer_product_catalogs WHERE customer_id=?`, [customerId]).catch(() => {});
      await pool.query(`DELETE FROM customers WHERE id=?`, [customerId]).catch(() => {});
    }
    console.log('Cleanup done.');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
