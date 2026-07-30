'use strict';
// Verifies "Filter Customer Price Book Products by Sales Flow": the product
// SOURCE for the Price Matrix admin screen (PriceMatrixAgent.matrix(), backing
// GET /price-matrix/:id?category_id=) must be filtered by the selected
// Customer Price Category's own sales_flow classification — using
// products.sales_flow, never inventory_mode alone — while the save-time guard
// (assertItemsMatchCategory / PRICE_CATEGORY_SALES_FLOW_MISMATCH) remains
// intact as the final backend protection.
//
// Self-cleaning: all throwaway rows removed in `finally`, FK-safe order.

const pool = require('../src/config/db');
const CustomerAgent = require('../src/agents/CustomerAgent');
const ProductAgent = require('../src/agents/ProductAgent');
const PriceMatrixAgent = require('../src/agents/PriceMatrixAgent');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}

const user = { id: null };

async function main() {
  const productIds = [];
  const customerIds = [];
  const bookIds = [];
  let categoryId = null;

  try {
    const [[cat]] = await pool.query(`SELECT id FROM product_categories LIMIT 1`);
    categoryId = cat.id;

    // default_sales_flow is deliberately set to the OPPOSITE of the customer's
    // actual Customer Price Category sales_flow below — proving matrix() truly
    // ignores customer.default_sales_flow (the story's explicit "do not filter
    // only from customer.default_sales_flow" requirement), not just untested.
    async function makeCustomer(name, oppositeDefaultFlow) {
      const res = await CustomerAgent.create({ name: `VERIFY PMSF ${name} ${Date.now()}-${Math.random().toString(36).slice(2,6)}`, partner_type: 0, default_sales_flow: oppositeDefaultFlow }, user);
      const [[row]] = await pool.query(`SELECT id FROM customers WHERE customer_code=?`, [res.customer_code]);
      customerIds.push(row.id);
      return row.id;
    }
    // ProductAgent.addProduct enforces SALES_FLOW_INVENTORY_MODE_COMPAT (S1G) — a
    // NEW product can never be created with a mismatched sales_flow/inventory_mode
    // pair, and sales_flow is mandatory. A NULL-sales_flow or mismatched-mode row is
    // therefore only reachable as pre-existing legacy/unmigrated data, so those two
    // fixtures are created with a valid combo first, then patched directly via SQL —
    // reproducing real legacy rows rather than a combination the live app could ever
    // write. This is exactly the scenario mandatory tests 6/7 target: prove the
    // Price Matrix filter itself keys on sales_flow, not inventory_mode, as
    // defense-in-depth against such legacy data (it must never be trusted to always
    // agree, even though new writes are guaranteed to agree).
    async function makeProduct(name, salesFlow, inventoryMode) {
      const validModeForFlow = { CARCASS_POS: 'NON_STOCK', INVENTORY_SALE: 'TRACK_STOCK' }[salesFlow || 'CARCASS_POS'];
      await ProductAgent.addProduct({ name: `VERIFY PMSF ${name} ${Date.now()}-${Math.random().toString(36).slice(2,6)}`, unit: 'kg', category_id: categoryId, inventory_mode: validModeForFlow, sales_flow: salesFlow || 'CARCASS_POS' });
      const [[p]] = await pool.query(`SELECT id FROM products WHERE name LIKE 'VERIFY PMSF ${name} %' ORDER BY id DESC LIMIT 1`);
      productIds.push(p.id);
      if (!salesFlow) await pool.query(`UPDATE products SET sales_flow=NULL WHERE id=?`, [p.id]);
      else if (inventoryMode !== validModeForFlow) await pool.query(`UPDATE products SET inventory_mode=? WHERE id=?`, [inventoryMode, p.id]);
      return p.id;
    }

    // ── Fixtures ──────────────────────────────────────────────────────────
    // P1: correctly-classified INVENTORY_SALE/TRACK_STOCK.
    const pInv = await makeProduct('Inv', 'INVENTORY_SALE', 'TRACK_STOCK');
    // P2: correctly-classified CARCASS_POS/NON_STOCK.
    const pCarcass = await makeProduct('Carcass', 'CARCASS_POS', 'NON_STOCK');
    // P3: legacy unclassified (sales_flow NULL), NON_STOCK — must fall under
    // the CARCASS_POS/legacy bucket, never under INVENTORY_SALE.
    const pLegacy = await makeProduct('Legacy', null, 'NON_STOCK');
    // P4: sales_flow=INVENTORY_SALE but inventory_mode=NON_STOCK — proves the
    // filter follows sales_flow, not inventory_mode (mandatory test 6/7).
    const pInvWrongMode = await makeProduct('InvWrongMode', 'INVENTORY_SALE', 'NON_STOCK');
    // P5: sales_flow=CARCASS_POS but inventory_mode=TRACK_STOCK — same proof
    // in the other direction (mandatory test 7).
    const pCarcassWrongMode = await makeProduct('CarcassWrongMode', 'CARCASS_POS', 'TRACK_STOCK');

    const custInv = await makeCustomer('CustInv', 'CARCASS_POS');
    await pool.query(`INSERT INTO customer_price_categories (customer_id, category_id, is_default, display_order, sales_flow) VALUES (?,?,1,1,'INVENTORY_SALE')`, [custInv, categoryId]);

    const custCarcass = await makeCustomer('CustCarcass', 'INVENTORY_SALE');
    await pool.query(`INSERT INTO customer_price_categories (customer_id, category_id, is_default, display_order, sales_flow) VALUES (?,?,1,1,'CARCASS_POS')`, [custCarcass, categoryId]);

    // S1M correction: a NULL category now INHERITS the customer's own
    // default_sales_flow (centralized resolveEffectiveSalesFlow) — it no
    // longer always falls into the CARCASS_POS/legacy bucket regardless of
    // the customer. custLegacyInherit proves inheritance; custLegacyNoDefault
    // (default_sales_flow forced to NULL — unreachable via the API, only via
    // direct legacy data) proves the true "nothing resolvable at all" case
    // still falls back to the old Legacy Model bucket.
    const custLegacyInherit = await makeCustomer('CustLegacyInherit', 'INVENTORY_SALE');
    await pool.query(`INSERT INTO customer_price_categories (customer_id, category_id, is_default, display_order, sales_flow) VALUES (?,?,1,1,NULL)`, [custLegacyInherit, categoryId]);

    const custLegacyNoDefault = await makeCustomer('CustLegacyNoDefault', 'CARCASS_POS');
    await pool.query(`UPDATE customers SET default_sales_flow=NULL WHERE id=?`, [custLegacyNoDefault]);
    await pool.query(`INSERT INTO customer_price_categories (customer_id, category_id, is_default, display_order, sales_flow) VALUES (?,?,1,1,NULL)`, [custLegacyNoDefault, categoryId]);

    // ── Mandatory test 1: INVENTORY_SALE category returns only compatible products ──
    const matrixInv = await PriceMatrixAgent.matrix(custInv, categoryId);
    const idsInv = matrixInv.rows.map(r => r.product_id);
    check('Test 1: INVENTORY_SALE category shows INVENTORY_SALE product', idsInv.includes(pInv));
    check('Test 1: INVENTORY_SALE category shows INVENTORY_SALE product even with NON_STOCK inventory_mode (sales_flow drives filter, not inventory_mode)', idsInv.includes(pInvWrongMode));
    check('Test 1: INVENTORY_SALE category hides CARCASS_POS product', !idsInv.includes(pCarcass));
    check('Test 1: INVENTORY_SALE category hides legacy/NULL product (no legacy fallback for INVENTORY_SALE)', !idsInv.includes(pLegacy));
    check('Test 1: INVENTORY_SALE category hides CARCASS_POS product even with TRACK_STOCK inventory_mode', !idsInv.includes(pCarcassWrongMode));

    // ── Mandatory test 2: CARCASS_POS category returns only compatible products ──
    const matrixCarcass = await PriceMatrixAgent.matrix(custCarcass, categoryId);
    const idsCarcass = matrixCarcass.rows.map(r => r.product_id);
    check('Test 2: CARCASS_POS category shows CARCASS_POS product', idsCarcass.includes(pCarcass));
    check('Test 2: CARCASS_POS category shows legacy/NULL product (Legacy Model fallback, matches assertItemsMatchCategory)', idsCarcass.includes(pLegacy));
    check('Test 2: CARCASS_POS category shows CARCASS_POS product even with TRACK_STOCK inventory_mode', idsCarcass.includes(pCarcassWrongMode));
    check('Test 2: CARCASS_POS category hides INVENTORY_SALE product', !idsCarcass.includes(pInv));
    check('Test 2: CARCASS_POS category hides INVENTORY_SALE product even with NON_STOCK inventory_mode', !idsCarcass.includes(pInvWrongMode));

    // S1M: a NULL category INHERITS the customer's own default_sales_flow —
    // custLegacyInherit's customer default is INVENTORY_SALE, so its NULL
    // category must now resolve as INVENTORY_SALE, never fall into the
    // CARCASS_POS/legacy bucket just because the category row itself is NULL.
    const matrixInherit = await PriceMatrixAgent.matrix(custLegacyInherit, categoryId);
    const idsInherit = matrixInherit.rows.map(r => r.product_id);
    check('S1M: NULL category inherits INVENTORY_SALE from customer.default_sales_flow (shows INVENTORY_SALE products)', idsInherit.includes(pInv) && idsInherit.includes(pInvWrongMode));
    check('S1M: NULL category inheriting INVENTORY_SALE hides CARCASS_POS/legacy products (no longer defaults to Bò Xô)', !idsInherit.includes(pCarcass) && !idsInherit.includes(pLegacy));

    // Only when BOTH the category's own value AND the customer's default are
    // missing does the old Legacy Model (CARCASS_POS-or-NULL) bucket apply.
    const matrixNoDefault = await PriceMatrixAgent.matrix(custLegacyNoDefault, categoryId);
    const idsNoDefault = matrixNoDefault.rows.map(r => r.product_id);
    check('Fully unresolved (category NULL + customer default NULL) still falls back to the Legacy Model bucket', idsNoDefault.includes(pCarcass) && idsNoDefault.includes(pLegacy) && !idsNoDefault.includes(pInv));

    // ── Mandatory test 9: product name/code/price-entry fields remain intact ──
    const rowInv = matrixInv.rows.find(r => r.product_id === pInv);
    check('Test 9: row carries product_name/product_code/private_price/effective_price fields', rowInv && 'product_name' in rowInv && 'product_code' in rowInv && 'private_price' in rowInv && 'effective_price' in rowInv, JSON.stringify(rowInv));

    // ── Mandatory test 8: backend still rejects a manipulated/incompatible payload ──
    let mismatchThrew = null;
    try {
      await PriceMatrixAgent.saveMatrix(custInv, [{ product_id: pCarcass, in_catalog: true, private_price: 50000, sort_order: 1 }], user.id, { effective_from: '2026-07-29', effective_calendar_type: 'SOLAR' }, categoryId);
    } catch (e) { mismatchThrew = e; }
    check('Test 8: saveMatrix still rejects an INVENTORY_SALE-category payload containing a CARCASS_POS product', !!mismatchThrew && mismatchThrew.code === 'PRICE_CATEGORY_SALES_FLOW_MISMATCH', mismatchThrew && mismatchThrew.message);

    // ── Mandatory test 10: existing price-book creation and update remain functional ──
    const saveRes = await PriceMatrixAgent.saveMatrix(custInv, [{ product_id: pInv, in_catalog: true, private_price: 88000, sort_order: 1 }], user.id, { effective_from: '2026-07-29', effective_calendar_type: 'SOLAR' }, categoryId);
    check('Test 10: saveMatrix with a compatible product succeeds (no PRICE_CATEGORY_SALES_FLOW_MISMATCH regression)', !!saveRes.message);
    const [[bookRow]] = await pool.query(`SELECT id FROM customer_price_books WHERE customer_id=? AND category_id=? ORDER BY id DESC LIMIT 1`, [custInv, categoryId]);
    if (bookRow) bookIds.push(bookRow.id);
    const matrixAfterSave = await PriceMatrixAgent.matrix(custInv, categoryId);
    const savedRow = matrixAfterSave.rows.find(r => r.product_id === pInv);
    check('Test 10: saved private price is reflected on reload', savedRow && Number(savedRow.private_price) === 88000, savedRow && savedRow.private_price);

    // update again with a new price
    const updateRes = await PriceMatrixAgent.saveMatrix(custInv, [{ product_id: pInv, in_catalog: true, private_price: 91000, sort_order: 1 }], user.id, { effective_from: '2026-07-29', effective_calendar_type: 'SOLAR' }, categoryId);
    check('Test 10: updating an existing price book (same effective date) succeeds', !!updateRes.message);
    const matrixAfterUpdate = await PriceMatrixAgent.matrix(custInv, categoryId);
    const updatedRow = matrixAfterUpdate.rows.find(r => r.product_id === pInv);
    check('Test 10: updated private price is reflected on reload', updatedRow && Number(updatedRow.private_price) === 91000, updatedRow && updatedRow.private_price);

  } finally {
    for (const id of bookIds) {
      await pool.query(`DELETE FROM customer_price_book_items WHERE price_book_id=?`, [id]);
      await pool.query(`DELETE FROM customer_price_books WHERE id=?`, [id]);
    }
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
