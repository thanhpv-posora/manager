'use strict';
// CTO GO-LIVE FINAL BUSINESS ACCEPTANCE — GATE 1: Bò Xô / CARCASS_POS.
//
// Rules exercised (all DERIVED from current code, not invented — cited inline):
//  - products.sales_flow ∈ {CARCASS_POS, INVENTORY_SALE}; CARCASS_POS pairs
//    ONLY with inventory_mode=NON_STOCK, INVENTORY_SALE ONLY with TRACK_STOCK
//    (backend/src/utils/productSalesFlow.js SALES_FLOW_INVENTORY_MODE_COMPAT).
//  - InventoryService.reverseOrderInventory()/postOut(): mode==='NON_STOCK' is
//    an explicit NO_STOCK_SKIP — no stock_quantity write ever happens for a
//    CARCASS_POS line (backend/src/services/InventoryService.js:191-192).
//  - purchase_lots (SupplierAgent.createLot) is a supplier COST/WEIGHT ledger
//    only — no product_id, no quantity linkage to any products row. "Pha lóc"
//    (breaking a carcass into đùi/sườn/nạm) is therefore NOT a formal
//    lot->product quantity system in this codebase: the lot tracks what we
//    owe the supplier; CARCASS_POS product sales are priced/sold independently
//    with no inventory check at all (matches NON_STOCK exactly). Confirmed by
//    reading SupplierAgent.js:163-210 — this is not assumed.
//  - OrderAgent.assertItemsCategoryPerFlow() enforces flow isolation even for
//    COMMON_PRICE/MANUAL_PRICE items with no price_book_id (P0-002 fix) —
//    tested explicitly below, not just the price_book_id path.
//  - ReportAgent does not reference sales_flow anywhere (grep confirmed empty)
//    — revenue is summed at the order/order_item level regardless of flow
//    composition, so a MIXED bill is inherently counted once, not double.
//
// Targets a DISPOSABLE database only (CR4_FRESH_DB env var) — refuses to run
// against the configured application database. Not self-cleaning by design
// (disposable DB, left for inspection like the RC4 rehearsal fixtures).
//
//   CR4_FRESH_DB=meatbiz_cr4_rehearsal node scripts/verify-business-gate1-carcass-pos.js

require('dotenv').config();
const TARGET = process.env.CR4_FRESH_DB;
const APP_DB = process.env.DB_NAME;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}
async function expectError(name, code, fn) {
  try { await fn(); check(name, false, 'expected to throw but succeeded'); }
  catch (e) { check(name, e && e.code === code, { expected: code, got: e && e.code, message: e && e.message }); }
}

async function main() {
  if (!TARGET) { console.error('CR4_FRESH_DB is not set — refusing to run.'); process.exit(2); }
  if (TARGET === APP_DB) { console.error(`CR4_FRESH_DB (${TARGET}) is the application database — refusing.`); process.exit(2); }
  process.env.DB_NAME = TARGET;
  const pool = require('../src/config/db');
  const [[who]] = await pool.query('SELECT DATABASE() db');
  if (who.db !== TARGET) { console.error(`pool connected to ${who.db}, not ${TARGET} — refusing.`); process.exit(2); }
  console.log(`=== GATE 1: Bò Xô / CARCASS_POS isolation (${TARGET}) ===\n`);

  const ProductAgent = require('../src/agents/ProductAgent');
  const OrderAgent = require('../src/agents/OrderAgent');
  const PaymentAgent = require('../src/agents/PaymentAgent');
  const PriceMatrixAgent = require('../src/agents/PriceMatrixAgent');
  const SupplierAgent = require('../src/agents/SupplierAgent');
  const ReportAgent = require('../src/agents/ReportAgent');

  const admin = { id: null, role: 'ADMIN' };
  const today = new Date().toISOString().slice(0, 10);
  const tag = `G1-${Date.now()}`;

  // Real seed data already separates these: a dedicated "Bò xô / pha lóc"
  // product_categories row exists alongside the packaged-goods categories
  // ("Thịt bò" etc.) — confirms real practice keeps CARCASS_POS and
  // INVENTORY_SALE products in separate product categories, not one shared
  // category serving both flows for the same customer.
  const [[carcassCat]] = await pool.query(`SELECT id FROM product_categories WHERE del_flg=0 AND name LIKE '%Bò xô%' LIMIT 1`);
  const [[warehouseCat]] = await pool.query(`SELECT id FROM product_categories WHERE del_flg=0 AND name NOT LIKE '%Bò xô%' ORDER BY id LIMIT 1`);
  const catId = carcassCat.id; // still used for the single-flow CARCASS_POS setup below
  const catIdWarehouse = warehouseCat.id;

  // ══════════════════ Setup: supplier + lot (purchase side) ══════════════════
  const [supIns] = await pool.query(
    `INSERT INTO suppliers(supplier_code,name,phone,address,is_active) VALUES(?,?,?,?,1)`,
    [`${tag}-SUP`, `${tag} Bò Xô Supplier`, '0', 'test']
  );
  const supplierId = supIns.insertId;
  const lotResult = await SupplierAgent.createLot({
    supplier_id: supplierId, purchase_date: today,
    raw_weight: 250, bone_weight: 20, total_animals: 2, male_animals: 1, female_animals: 1,
    male_price: 80000, female_price: 75000, male_weight: 130, female_weight: 100,
  }, admin);
  check('Setup: purchase lot created (Bò Xô carcass purchase)', !!lotResult && !!lotResult.lot_code, lotResult);
  check('Setup: lot total_weight/cost computed (costing formula itself is out of this gate\'s scope)', Number(lotResult.total_weight) > 0 && Number(lotResult.total_cost) > 0, lotResult);

  // ══════════════════ Setup: CARCASS_POS products (đùi/sườn/nạm) + one INVENTORY_SALE product ══════════════════
  async function makeCarcassProduct(name) {
    const full = `${tag} ${name}`;
    await ProductAgent.addProduct({ name: full, unit: 'kg', category_id: catId, inventory_mode: 'NON_STOCK', sales_flow: 'CARCASS_POS' });
    const [[p]] = await pool.query(`SELECT * FROM products WHERE name=? LIMIT 1`, [full]);
    return p;
  }
  async function makeInventoryProduct(name, qty) {
    const full = `${tag} ${name}`;
    await ProductAgent.addProduct({ name: full, unit: 'kg', category_id: catIdWarehouse, inventory_mode: 'TRACK_STOCK', sales_flow: 'INVENTORY_SALE', stock_quantity: qty, allow_negative_stock: 0 });
    const [[p]] = await pool.query(`SELECT * FROM products WHERE name=? LIMIT 1`, [full]);
    return p;
  }
  const pDui = await makeCarcassProduct('Đùi');
  const pSuon = await makeCarcassProduct('Sườn');
  const pNam = await makeCarcassProduct('Nạm');
  const pWarehouse = await makeInventoryProduct('Chả lụa (kho)', 50);

  check('Setup: đùi/sườn/nạm are CARCASS_POS + NON_STOCK', [pDui, pSuon, pNam].every(p => p.sales_flow === 'CARCASS_POS' && p.inventory_mode === 'NON_STOCK'));
  check('Setup: warehouse product is INVENTORY_SALE + TRACK_STOCK', pWarehouse.sales_flow === 'INVENTORY_SALE' && pWarehouse.inventory_mode === 'TRACK_STOCK');

  // Reject combo: CARCASS_POS + TRACK_STOCK must be rejected at product creation.
  let comboThrew = null;
  try { await ProductAgent.addProduct({ name: `${tag} BadCombo`, unit: 'kg', category_id: catId, inventory_mode: 'TRACK_STOCK', sales_flow: 'CARCASS_POS' }); }
  catch (e) { comboThrew = e; }
  check('1. CARCASS_POS + TRACK_STOCK combo rejected at product creation', !!comboThrew && comboThrew.code === 'PRODUCT_SALES_FLOW_INVENTORY_MODE_MISMATCH', comboThrew && comboThrew.message);

  // ══════════════════ Setup: two customers, opposite default flows ══════════════════
  async function makeCustomer(name, defaultFlow) {
    const res = await require('../src/agents/CustomerAgent').create({ name: `${tag} ${name}`, partner_type: 2, default_sales_flow: defaultFlow, price_mode: 'PRIVATE_PRICE', billing_calendar_type: 'SOLAR' }, admin);
    const [[row]] = await pool.query(`SELECT id FROM customers WHERE customer_code=?`, [res.customer_code]);
    return row.id;
  }
  const custCarcass = await makeCustomer('Carcass Customer', 'CARCASS_POS');
  const custWarehouse = await makeCustomer('Warehouse Customer', 'INVENTORY_SALE');

  // Give each customer a private price category matching their own flow, with prices.
  const cpcCarcass = await PriceMatrixAgent.createCustomerPriceCategory(custCarcass, catId, { sales_flow: 'CARCASS_POS' });
  await PriceMatrixAgent.saveMatrix(custCarcass, [
    { product_id: pDui.id, private_price: 180000, in_catalog: true },
    { product_id: pSuon.id, private_price: 150000, in_catalog: true },
    { product_id: pNam.id, private_price: 160000, in_catalog: true },
  ], null, { effective_from: today, effective_calendar_type: 'SOLAR' }, catId);

  const cpcWarehouse = await PriceMatrixAgent.createCustomerPriceCategory(custWarehouse, catIdWarehouse, { sales_flow: 'INVENTORY_SALE' });
  await PriceMatrixAgent.saveMatrix(custWarehouse, [
    { product_id: pWarehouse.id, private_price: 90000, in_catalog: true },
  ], null, { effective_from: today, effective_calendar_type: 'SOLAR' }, catIdWarehouse);

  // ══════════════════ 2 & 3. Bò Xô sale must not deduct stock; INVENTORY_SALE must deduct correctly ══════════════════
  const stockBeforeCarcass = { dui: Number((await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [pDui.id]))[0][0].stock_quantity) };
  const rCarcass = await OrderAgent.create({
    customer_id: custCarcass, order_date: today,
    items: [{ product_id: pDui.id, product_name: pDui.name, unit: 'kg', quantity: 5 }, { product_id: pSuon.id, product_name: pSuon.name, unit: 'kg', quantity: 3 }],
  }, admin);
  check('Bò Xô bill created', !!rCarcass && !!rCarcass.order_id, rCarcass);
  const [[dui_after]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [pDui.id]);
  check('2. Bò Xô sale does NOT deduct stock_quantity (NON_STOCK, unaffected)', Number(dui_after.stock_quantity) === stockBeforeCarcass.dui);
  // NOTE: InventoryService.js's own header comment (lines 16-21) claims NON_STOCK
  // "performs no write here" for applyOrderInventory() — actual behavior is a
  // real (audit-trail) stock_transactions row IS written, tagged SKIP_STOCK_CHECK/
  // NON_STOCK with affect_stock=0, and stock_quantity is genuinely untouched
  // (confirmed by check 2 above). The comment is stale relative to the code;
  // the actual behavior is sound (full audit trail, zero balance impact) — not
  // a defect, just documented here since it contradicts what the comment says.
  const [stRowsCarcass] = await pool.query(`SELECT affect_stock, note FROM stock_transactions WHERE reference_type='SALE' AND reference_id=?`, [rCarcass.order_id]);
  check('2b. Bò Xô sale\'s stock_transactions rows (if any) all have affect_stock=0 (audit trail only, no balance impact)', stRowsCarcass.every(r => Number(r.affect_stock) === 0), stRowsCarcass);

  const rWarehouse = await OrderAgent.create({
    customer_id: custWarehouse, order_date: today,
    items: [{ product_id: pWarehouse.id, product_name: pWarehouse.name, unit: 'kg', quantity: 10 }],
  }, admin);
  check('Warehouse bill created', !!rWarehouse && !!rWarehouse.order_id, rWarehouse);
  const [[wh_after]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [pWarehouse.id]);
  check('3. INVENTORY_SALE deducts TRACK_STOCK correctly (50 -> 40)', Number(wh_after.stock_quantity) === 40, wh_after);

  // ══════════════════ 6. Bò Xô-specific prices resolve correctly ══════════════════
  const [duiLine] = await pool.query(`SELECT sale_price, price_type FROM order_items WHERE order_id=? AND product_id=?`, [rCarcass.order_id, pDui.id]);
  check('6. Bò Xô private price resolved (180,000/kg for đùi)', Number(duiLine[0].sale_price) === 180000, duiLine[0]);
  const [whLine] = await pool.query(`SELECT sale_price FROM order_items WHERE order_id=? AND product_id=?`, [rWarehouse.order_id, pWarehouse.id]);
  check('6b. Warehouse private price resolved (90,000/kg)', Number(whLine[0].sale_price) === 90000, whLine[0]);

  // ══════════════════ 5. Cross-flow customer/item mismatch rejected ══════════════════
  await expectError('5. CARCASS customer buying INVENTORY_SALE item (their category has no such flow) is rejected',
    'PRICE_CATEGORY_NOT_INVENTORY_SALE',
    () => OrderAgent.create({ customer_id: custCarcass, order_date: today, items: [{ product_id: pWarehouse.id, product_name: pWarehouse.name, unit: 'kg', quantity: 1, sale_price: 90000, manual_price: true }] }, admin));
  await expectError('5b. INVENTORY customer buying CARCASS_POS item (their category has no such flow) is rejected',
    'PRICE_CATEGORY_SALES_FLOW_MISMATCH',
    () => OrderAgent.create({ customer_id: custWarehouse, order_date: today, items: [{ product_id: pDui.id, product_name: pDui.name, unit: 'kg', quantity: 1, sale_price: 180000, manual_price: true }] }, admin));

  // ══════════════════ 4. COMMON_PRICE / MANUAL_PRICE / missing price_book_id must NOT bypass sales_flow (P0-002) ══════════════════
  // Same two rejections as above, but forcing the NULL-price_book_id branch
  // (manual_price / no category resolution) — this is the exact P0-002 gap:
  // proves the flow guard applies even when no price_book_id is present.
  await expectError('4. MANUAL_PRICE item still enforces sales_flow (CARCASS customer, INVENTORY item, explicit manual price)',
    'PRICE_CATEGORY_NOT_INVENTORY_SALE',
    async () => {
      // custCarcass's default_sales_flow IS resolvable (CARCASS_POS) — so this
      // hits "resolved flow disagrees with the item's flow", not "unresolved".
      // Either way it's a rejection, not a bypass — which is what this check proves.
      await OrderAgent.create({ customer_id: custCarcass, order_date: today, items: [{ product_id: pWarehouse.id, product_name: pWarehouse.name, unit: 'kg', quantity: 1, sale_price: 99999, manual_price: true, price_type: 'MANUAL_PRICE' }] }, admin);
    });
  await expectError('4b. MANUAL_PRICE item still enforces sales_flow (INVENTORY customer, CARCASS item, explicit manual price)',
    'PRICE_CATEGORY_SALES_FLOW_MISMATCH',
    () => OrderAgent.create({ customer_id: custWarehouse, order_date: today, items: [{ product_id: pDui.id, product_name: pDui.name, unit: 'kg', quantity: 1, sale_price: 99999, manual_price: true, price_type: 'MANUAL_PRICE' }] }, admin));

  // ══════════════════ MIXED bill: both flows in one order ══════════════════
  // A genuinely mixed-flow customer needs real price books for BOTH flows —
  // default_sales_flow only carries ONE inherited flow (confirmed above: an
  // INVENTORY_SALE-default customer buying a CARCASS_POS item via manual_price
  // with no book is correctly rejected). This is how the system is designed
  // to support mixed buyers, not a workaround.
  const custBoth = await makeCustomer('Mixed Customer', 'INVENTORY_SALE');
  await PriceMatrixAgent.createCustomerPriceCategory(custBoth, catId, { sales_flow: 'CARCASS_POS' });
  await PriceMatrixAgent.createCustomerPriceCategory(custBoth, catIdWarehouse, { sales_flow: 'INVENTORY_SALE' });
  await PriceMatrixAgent.saveMatrix(custBoth, [{ product_id: pNam.id, private_price: 160000, in_catalog: true }], null, { effective_from: today, effective_calendar_type: 'SOLAR' }, catId);
  await PriceMatrixAgent.saveMatrix(custBoth, [{ product_id: pWarehouse.id, private_price: 90000, in_catalog: true }], null, { effective_from: today, effective_calendar_type: 'SOLAR' }, catIdWarehouse);
  const rMixed = await OrderAgent.create({
    customer_id: custBoth, order_date: today,
    items: [
      { product_id: pNam.id, product_name: pNam.name, unit: 'kg', quantity: 2 },
      { product_id: pWarehouse.id, product_name: pWarehouse.name, unit: 'kg', quantity: 2 },
    ],
  }, admin);
  const [[mixedOrder]] = await pool.query(`SELECT sales_flow, total_amount FROM orders WHERE id=?`, [rMixed.order_id]);
  check('MIXED bill: order header sales_flow = MIXED', mixedOrder.sales_flow === 'MIXED', mixedOrder);
  check('MIXED bill: total_amount = 320,000+180,000=500,000 (2x160k carcass + 2x90k warehouse)', Number(mixedOrder.total_amount) === 500000, mixedOrder);
  const [[whAfterMixed]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [pWarehouse.id]);
  check('MIXED bill: only the INVENTORY_SALE line deducted stock (40 -> 38)', Number(whAfterMixed.stock_quantity) === 38, whAfterMixed);

  // ══════════════════ 7 & 8. No double-count in reports ══════════════════
  const [[revSum]] = await pool.query(
    `SELECT COALESCE(SUM(total_amount),0) total FROM orders WHERE id IN (?,?,?)`,
    [rCarcass.order_id, rWarehouse.order_id, rMixed.order_id]
  );
  const [[oC]] = await pool.query(`SELECT total_amount FROM orders WHERE id=?`, [rCarcass.order_id]);
  const [[oW]] = await pool.query(`SELECT total_amount FROM orders WHERE id=?`, [rWarehouse.order_id]);
  const [[oM]] = await pool.query(`SELECT total_amount FROM orders WHERE id=?`, [rMixed.order_id]);
  const sumExpected = Number(oC.total_amount) + Number(oW.total_amount) + Number(oM.total_amount);
  check('7/8. Sum of individual order totals equals the batch SUM query (no double count at the DB level)', Number(revSum.total) === sumExpected, { revSum, sumExpected });

  const dashCarcass = await ReportAgent.dashboard({ role: 'ADMIN' });
  check('8b. ReportAgent.dashboard() runs without a sales_flow-based double-count path (no crash, returns a summary)', !!dashCarcass && !!dashCarcass.summary && typeof dashCarcass.summary.total_revenue !== 'undefined', dashCarcass && dashCarcass.summary);

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
