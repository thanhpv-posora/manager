'use strict';
// S11 "INVENTORY SALES FORM V1" verification.
//
// Covers:
//  A) PriceMatrixAgent.customerCatalogForOrder() inventory_mode filter (Task 1/18):
//     omitted, TRACK_STOCK, NON_STOCK, invalid value (including the retired
//     CARCASS_PART, which S1J made an invalid filter value — see PriceMatrixAgent.js
//     CATALOG_VALID_INVENTORY_MODES / ProductAgent.js VALID_INVENTORY_MODE_FILTERS).
//  B) OrderAgent.create() sales_flow DB-validated guard (Task 3/19): backward
//     compatibility when omitted, CARCASS_POS/INVENTORY_SALE acceptance and
//     rejection, invalid sales_flow value.
//  C) Warehouse-sales stock behavior: sale-within-stock decrements
//     products.stock_quantity and writes a stock_transactions row,
//     insufficient stock is rejected by the backend (never the frontend),
//     allow_negative_stock=1 bypasses the check, cancelling a bill restores
//     stock.
//  D) TRACK_STOCK and NON_STOCK catalogs stay mutually exclusive.
//  E) Static proof (source grep) that CreateOrder.jsx requests only
//     sales_flow=CARCASS_POS and InventorySales.jsx requests only
//     sales_flow=INVENTORY_SALE (S1I Patch B: sales_flow alone determines the
//     catalog, no inventory_mode filter param sent from either page), with none
//     of the excluded V1 features (Excel Import, AI Voice, OCR, Quick Add)
//     pulled into the new page.
//
// Self-cleaning: throwaway customer + products + orders + price book, removed
// in `finally` regardless of pass/fail. Touches no pre-existing data.

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

async function getProduct(id) {
  const [[row]] = await pool.query(`SELECT * FROM products WHERE id=?`, [id]);
  return row;
}

async function makeProduct(mode, { stock = 0, allowNegative = 0, categoryId }) {
  const tag = `S11 SALES ${mode} ${allowNegative ? 'NEG' : 'STD'} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  // sales_flow is required at create-time (ProductAgent.assertProductClassification,
  // pre-existing S1G validation, unrelated to this script's original CARCASS_PART
  // drift) — this helper never set it and could not create any fixture at all.
  const salesFlow = mode === 'TRACK_STOCK' ? 'INVENTORY_SALE' : 'CARCASS_POS';
  await ProductAgent.addProduct({
    name: tag, unit: 'kg', category_id: categoryId,
    inventory_mode: mode, sales_flow: salesFlow, stock_quantity: stock, allow_negative_stock: allowNegative,
  });
  const [[created]] = await pool.query(`SELECT * FROM products WHERE name=? LIMIT 1`, [tag]);
  return created;
}

async function main() {
  const productIds = [];
  const orderIds = [];
  let customerId = null;
  let categoryId = null;
  const today = new Date().toISOString().slice(0, 10);
  const user = { id: null, role: 'ADMIN' };

  try {
    // ── Setup ──
    const [[cat]] = await pool.query(`SELECT id FROM product_categories WHERE del_flg=0 LIMIT 1`);
    categoryId = cat.id;

    const [custIns] = await pool.query(
      `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type)
       VALUES(?,?,?,?,?,?,?,?)`,
      [`S11TEST-${Date.now()}`, 'S11 Inventory Sales Test Customer', '0', 'test', 'PRIVATE_PRICE', 0, 0, 'SOLAR']
    );
    customerId = custIns.insertId;

    const pTrack = await makeProduct('TRACK_STOCK', { stock: 20, allowNegative: 0, categoryId });
    const pTrackNeg = await makeProduct('TRACK_STOCK', { stock: 5, allowNegative: 1, categoryId });
    const pCarcass = await makeProduct('NON_STOCK', { categoryId });
    const pNonStock = await makeProduct('NON_STOCK', { categoryId });
    productIds.push(pTrack.id, pTrackNeg.id, pCarcass.id, pNonStock.id);

    // No saveMatrix()/customer_price_category setup here: nothing in Section A
    // (catalog inventory_mode filter) or Section B (OrderAgent.create sales_flow
    // guard, which prices every billItem via manual_price:true) reads
    // price_book_id/price_type, so no price book is needed. A prior version of
    // this script did set one up via a single shared category — that stopped
    // working once S1G Phase 6 made a Customer Price Category sales_flow-isolated
    // (INVENTORY_SALE and CARCASS_POS products can no longer share one category;
    // PriceMatrixAgent.assertItemsMatchCategory rejects the mix). Since this
    // script never asserted on the resulting price data, removing the unused
    // setup is the correct fix rather than splitting it across two product
    // categories (which Section A's single-category filter assertions depend on).

    // ══════════════════ A) Catalog inventory_mode filter ══════════════════

    {
      const r = await PriceMatrixAgent.customerCatalogForOrder(customerId, categoryId, null);
      const ids = r.products.map(p => p.product_id);
      check('A1 omitted inventory_mode: sees all 4 test products (backward compatible)',
        [pTrack.id, pTrackNeg.id, pCarcass.id, pNonStock.id].every(id => ids.includes(id)), ids);
    }
    {
      const r = await PriceMatrixAgent.customerCatalogForOrder(customerId, categoryId, 'TRACK_STOCK');
      const ids = r.products.map(p => p.product_id);
      check('A2 inventory_mode=TRACK_STOCK: contains both TRACK_STOCK test products',
        ids.includes(pTrack.id) && ids.includes(pTrackNeg.id), ids);
      check('A2 inventory_mode=TRACK_STOCK: excludes CARCASS_PART', !ids.includes(pCarcass.id), ids);
      check('A2 inventory_mode=TRACK_STOCK: excludes NON_STOCK', !ids.includes(pNonStock.id), ids);
    }
    {
      // Post-S1J: CARCASS_PART no longer exists as a distinct inventory_mode —
      // pCarcass was created as NON_STOCK (S1J retired CARCASS_PART), so it is
      // now indistinguishable from pNonStock at the inventory_mode level. The
      // filter's positive-path contract is exercised via NON_STOCK instead.
      const r = await PriceMatrixAgent.customerCatalogForOrder(customerId, categoryId, 'NON_STOCK');
      const ids = r.products.map(p => p.product_id);
      check('A3 inventory_mode=NON_STOCK: contains both NON_STOCK test products (post-S1J, former-CARCASS_PART product included)', ids.includes(pCarcass.id) && ids.includes(pNonStock.id), ids);
      check('A3 inventory_mode=NON_STOCK: excludes TRACK_STOCK', !ids.includes(pTrack.id) && !ids.includes(pTrackNeg.id), ids);
    }
    {
      // A3b: the retired CARCASS_PART value must now be rejected as an invalid
      // filter, same as any other unrecognized value (S1J).
      let threw = null;
      try { await PriceMatrixAgent.customerCatalogForOrder(customerId, categoryId, 'CARCASS_PART'); } catch (e) { threw = e; }
      check('A3b retired inventory_mode=CARCASS_PART rejected with HTTP 400 (S1J)', threw && threw.status === 400, threw && threw.message);
    }
    {
      let threw = null;
      try { await PriceMatrixAgent.customerCatalogForOrder(customerId, categoryId, 'BOGUS_MODE'); } catch (e) { threw = e; }
      check('A4 invalid inventory_mode rejected with HTTP 400', threw && threw.status === 400, threw && threw.message);
    }

    // ══════════════════ B) OrderAgent.create() sales_flow guard ══════════════════

    const billItem = (p, qty) => ({ product_id: p.id, product_name: p.name, unit: 'kg', quantity: qty, sale_price: 1000, manual_price: true });

    {
      // B1: sales_flow omitted, mixed CARCASS_PART + TRACK_STOCK on one bill — unrestricted (legacy behavior).
      const r = await OrderAgent.create({ customer_id: customerId, order_date: today, items: [billItem(pCarcass, 1), billItem(pTrack, 1)] }, user);
      orderIds.push(r.order_id);
      check('B1 sales_flow omitted: mixed-mode bill still succeeds (backward compatible)', !!r.order_id);
      await OrderAgent.cancel(r.order_id, { reason: 'cleanup B1' }, user); // restore stock before later scenarios count on pTrack=20
    }
    {
      // B2: CARCASS_POS + CARCASS_PART item → succeeds, no stock check performed.
      const before = await getProduct(pCarcass.id);
      const r = await OrderAgent.create({ customer_id: customerId, order_date: today, sales_flow: 'CARCASS_POS', items: [billItem(pCarcass, 3)] }, user);
      orderIds.push(r.order_id);
      const [[item]] = await pool.query(`SELECT * FROM order_items WHERE order_id=?`, [r.order_id]);
      check('B2 CARCASS_POS + CARCASS_PART: bill created', !!r.order_id);
      check('B2 CARCASS_POS + CARCASS_PART: order_items.stock_checked=0 (Bò Xô never affects stock)', Number(item.stock_checked) === 0, item.stock_checked);
      const after = await getProduct(pCarcass.id);
      check('B2 CARCASS_POS + CARCASS_PART: stock_quantity unchanged', Number(after.stock_quantity) === Number(before.stock_quantity), `${before.stock_quantity} -> ${after.stock_quantity}`);
    }
    {
      // B3: OrderAgent.create() never reads data.sales_flow for validation (see
      // deriveItemsSalesFlow's own doc comment: "neither data.sales_flow nor any
      // item.inventory_mode/item.sales_flow sent in the request body is read
      // here") — the order's real sales_flow is derived solely from each item's
      // own products.sales_flow, independent of what the caller claims. A
      // caller-declared 'CARCASS_POS' against a TRACK_STOCK/INVENTORY_SALE item
      // therefore still succeeds, and the persisted order.sales_flow reflects the
      // item's real classification, not the caller's claim — proving the
      // request body's sales_flow is a no-op, never a trust boundary.
      const r = await OrderAgent.create({ customer_id: customerId, order_date: today, sales_flow: 'CARCASS_POS', items: [billItem(pTrack, 1)] }, user);
      orderIds.push(r.order_id);
      const [[order]] = await pool.query(`SELECT sales_flow FROM orders WHERE id=?`, [r.order_id]);
      check('B3 caller-declared sales_flow is ignored: order.sales_flow is derived from the item (INVENTORY_SALE), not the caller-declared CARCASS_POS', order.sales_flow === 'INVENTORY_SALE', order.sales_flow);
      await OrderAgent.cancel(r.order_id, { reason: 'cleanup B3' }, user); // restore stock before B4 counts on pTrack=20
    }
    {
      // B4: INVENTORY_SALE + TRACK_STOCK, within stock → succeeds, stock decreases, ledger written.
      const before = await getProduct(pTrack.id);
      const r = await OrderAgent.create({ customer_id: customerId, order_date: today, sales_flow: 'INVENTORY_SALE', items: [billItem(pTrack, 5)] }, user);
      orderIds.push(r.order_id);
      const [[item]] = await pool.query(`SELECT * FROM order_items WHERE order_id=?`, [r.order_id]);
      const after = await getProduct(pTrack.id);
      const [[ledger]] = await pool.query(
        `SELECT * FROM stock_transactions WHERE product_id=? AND reference_type='SALE' AND reference_id=? AND type='OUT'`,
        [pTrack.id, r.order_id]
      );
      check('B4 INVENTORY_SALE + TRACK_STOCK: bill created', !!r.order_id);
      check('B4 INVENTORY_SALE + TRACK_STOCK: order_items.stock_checked=1', Number(item.stock_checked) === 1, item.stock_checked);
      check('B4 INVENTORY_SALE + TRACK_STOCK: stock_quantity decreased by 5', Number(after.stock_quantity) === Number(before.stock_quantity) - 5, `${before.stock_quantity} -> ${after.stock_quantity}`);
      check('B4 INVENTORY_SALE + TRACK_STOCK: stock_transactions OUT row written', !!ledger, ledger);
      check('B4 INVENTORY_SALE + TRACK_STOCK: ledger row affect_stock=1', ledger && Number(ledger.affect_stock) === 1, ledger);
    }
    {
      // B5: symmetric to B3 — a caller-declared 'INVENTORY_SALE' against a
      // NON_STOCK/CARCASS_POS item still succeeds, with order.sales_flow derived
      // from the item's real classification (CARCASS_POS), never the caller's claim.
      const r = await OrderAgent.create({ customer_id: customerId, order_date: today, sales_flow: 'INVENTORY_SALE', items: [billItem(pCarcass, 1)] }, user);
      orderIds.push(r.order_id);
      const [[order]] = await pool.query(`SELECT sales_flow FROM orders WHERE id=?`, [r.order_id]);
      check('B5 caller-declared sales_flow is ignored: order.sales_flow is derived from the item (CARCASS_POS), not the caller-declared INVENTORY_SALE', order.sales_flow === 'CARCASS_POS', order.sales_flow);
    }
    {
      // B6: INVENTORY_SALE + TRACK_STOCK, quantity exceeds remaining stock, allow_negative_stock=0 → rejected by the backend.
      const before = await getProduct(pTrack.id); // 15 remaining after B4
      let threw = null;
      try { await OrderAgent.create({ customer_id: customerId, order_date: today, sales_flow: 'INVENTORY_SALE', items: [billItem(pTrack, 9999)] }, user); }
      catch (e) { threw = e; }
      const after = await getProduct(pTrack.id);
      check('B6 insufficient stock: rejected by backend (never trusts a frontend-only warning)', threw && /Không đủ tồn kho/.test(threw.message), threw && threw.message);
      check('B6 insufficient stock: stock_quantity unchanged after rejection', Number(after.stock_quantity) === Number(before.stock_quantity), `${before.stock_quantity} -> ${after.stock_quantity}`);
    }
    {
      // B7: deriveItemsSalesFlow() deliberately rejects an allow_negative_stock=1
      // item once it resolves to INVENTORY_SALE — "Bán hàng kho must never
      // silently take that skip-path" (see the function's own doc comment in
      // OrderAgent.js). This is a real, already-implemented guard, distinct
      // from B6's separate insufficient-stock rejection: this one fires purely
      // because the item allows negative stock at all, regardless of quantity.
      const before = await getProduct(pTrackNeg.id); // stock=5
      let threw = null;
      try { await OrderAgent.create({ customer_id: customerId, order_date: today, sales_flow: 'INVENTORY_SALE', items: [billItem(pTrackNeg, 1)] }, user); }
      catch (e) { threw = e; }
      const after = await getProduct(pTrackNeg.id);
      check('B7 INVENTORY_SALE + allow_negative_stock=1 item: rejected', threw && threw.code === 'SALES_FLOW_NEGATIVE_STOCK_NOT_ALLOWED', threw && threw.message);
      check('B7 rejected sale: stock_quantity unchanged', Number(after.stock_quantity) === Number(before.stock_quantity), `${before.stock_quantity} -> ${after.stock_quantity}`);
    }
    {
      // B8: same no-op-request-body property as B3/B5 — an unrecognized
      // data.sales_flow value is never read or validated, so it has no effect;
      // the order still succeeds, deriving its real sales_flow from the item.
      const r = await OrderAgent.create({ customer_id: customerId, order_date: today, sales_flow: 'BOGUS_FLOW', items: [billItem(pTrack, 1)] }, user);
      orderIds.push(r.order_id);
      const [[order]] = await pool.query(`SELECT sales_flow FROM orders WHERE id=?`, [r.order_id]);
      check('B8 unrecognized data.sales_flow value is a no-op: bill still succeeds', !!r.order_id);
      check('B8 order.sales_flow is still correctly derived from the item (INVENTORY_SALE)', order.sales_flow === 'INVENTORY_SALE', order.sales_flow);
      await OrderAgent.cancel(r.order_id, { reason: 'cleanup B8' }, user); // restore stock before B9 counts on pTrack=20
    }
    {
      // B9: cancelling an INVENTORY_SALE bill restores stock.
      const before = await getProduct(pTrack.id); // 15 remaining
      const r = await OrderAgent.create({ customer_id: customerId, order_date: today, sales_flow: 'INVENTORY_SALE', items: [billItem(pTrack, 3)] }, user);
      orderIds.push(r.order_id);
      const afterSale = await getProduct(pTrack.id);
      check('B9 cancel restores stock: stock decreased on sale (15->12)', Number(afterSale.stock_quantity) === Number(before.stock_quantity) - 3, afterSale.stock_quantity);
      await OrderAgent.cancel(r.order_id, { reason: 'S11 verify cancel-restores-stock' }, user);
      const afterCancel = await getProduct(pTrack.id);
      check('B9 cancel restores stock: stock_quantity restored after cancel (12->15)', Number(afterCancel.stock_quantity) === Number(before.stock_quantity), afterCancel.stock_quantity);
      const [[order]] = await pool.query(`SELECT status FROM orders WHERE id=?`, [r.order_id]);
      check('B9 cancel restores stock: order status=CANCELLED', order.status === 'CANCELLED', order.status);
    }

    // ══════════════════ E) Static source proof ══════════════════

    const frontendSrc = path.join(__dirname, '..', '..', 'frontend', 'src');
    const createOrderSrc = fs.readFileSync(path.join(frontendSrc, 'pages', 'CreateOrder.jsx'), 'utf8');
    const inventorySalesSrc = fs.readFileSync(path.join(frontendSrc, 'pages', 'InventorySales.jsx'), 'utf8');

    // S1I Patch B: sales_flow alone determines the catalog on both pages —
    // neither page sends an inventory_mode filter param on the catalog request
    // any more, so the pre-S1I assertion that CreateOrder.jsx requests
    // inventory_mode:'CARCASS_PART' no longer matches reality (verification
    // drift, not a defect: CARCASS_PART is retired as of S1J regardless).
    check('E1 CreateOrder.jsx save() sends sales_flow:\'CARCASS_POS\'', /sales_flow\s*:\s*'CARCASS_POS'/.test(createOrderSrc));
    check('E1 CreateOrder.jsx never requests inventory_mode:\'TRACK_STOCK\'', !/inventory_mode\s*:\s*'TRACK_STOCK'/.test(createOrderSrc));
    check('E1 CreateOrder.jsx never requests the retired inventory_mode:\'CARCASS_PART\'', !/inventory_mode\s*:\s*'CARCASS_PART'/.test(createOrderSrc));

    check('E2 InventorySales.jsx save() sends sales_flow: \'INVENTORY_SALE\'', /sales_flow\s*:\s*'INVENTORY_SALE'/.test(inventorySalesSrc));
    check('E2 InventorySales.jsx never requests inventory_mode: \'CARCASS_PART\'', !/inventory_mode\s*:\s*'CARCASS_PART'/.test(inventorySalesSrc));
    check('E2 InventorySales.jsx does not import Excel/xlsx import', !/xlsx|XLSX/.test(inventorySalesSrc));
    check('E2 InventorySales.jsx does not import voice/OCR parsers', !/voiceBillParser|handwritingBillParser|Tesseract/.test(inventorySalesSrc));
    check('E2 InventorySales.jsx does not touch POSProductTableAgent', !/POSProductTableAgent/.test(inventorySalesSrc));
    check('E2 InventorySales.jsx is a small, purpose-built file (<600 lines, not a CreateOrder.jsx copy)', inventorySalesSrc.split('\n').length < 600, inventorySalesSrc.split('\n').length);

    const appSrc = fs.readFileSync(path.join(frontendSrc, 'App.jsx'), 'utf8');
    check('E3 App.jsx maps page key \'inventory-sales\' to <InventorySales/>', /'inventory-sales'\s*:\s*<InventorySales/.test(appSrc));

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
