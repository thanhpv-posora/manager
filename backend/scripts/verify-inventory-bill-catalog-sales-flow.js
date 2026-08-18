'use strict';
// Verifies "Fix Inventory Bill Customer Catalog Sales Flow Resolution" (S1N):
// PriceMatrixAgent.customerCatalogForOrder() must resolve the EFFECTIVE
// sales_flow (category's own value, else inherited from customers.
// default_sales_flow via the centralized resolveEffectiveSalesFlow) instead
// of checking the raw customer_price_categories.sales_flow column alone —
// the exact bug that threw CATALOG_CATEGORY_NOT_INVENTORY_SALE for a
// Hàng Kho customer whose category was still legacy sales_flow=NULL.
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
  const cpcIds = [];
  let categoryId = null;

  try {
    const [[cat]] = await pool.query(`SELECT id FROM product_categories LIMIT 1`);
    categoryId = cat.id;

    async function makeCustomer(name, defaultFlow) {
      const res = await CustomerAgent.create({ name: `VERIFY IBCF ${name} ${Date.now()}-${Math.random().toString(36).slice(2,6)}`, phone: `09${String(Date.now()).slice(-6)}${String(Math.floor(Math.random()*90)+10)}`, partner_type: 0, default_sales_flow: defaultFlow }, user);
      const [[row]] = await pool.query(`SELECT id FROM customers WHERE customer_code=?`, [res.customer_code]);
      customerIds.push(row.id);
      return row.id;
    }
    async function makeProduct(name, salesFlow) {
      const mode = salesFlow === 'INVENTORY_SALE' ? 'TRACK_STOCK' : 'NON_STOCK';
      await ProductAgent.addProduct({ name: `VERIFY IBCF ${name} ${Date.now()}-${Math.random().toString(36).slice(2,6)}`, unit: 'kg', category_id: categoryId, inventory_mode: mode, sales_flow: salesFlow });
      const [[p]] = await pool.query(`SELECT id FROM products WHERE name LIKE 'VERIFY IBCF ${name} %' ORDER BY id DESC LIMIT 1`);
      productIds.push(p.id);
      return p.id;
    }

    const pInv = await makeProduct('Inv', 'INVENTORY_SALE');
    const pCarcass = await makeProduct('Carcass', 'CARCASS_POS');

    // ── Acceptance 1: Inventory customer, legacy NULL category ──────────────
    const custInvLegacy = await makeCustomer('InvLegacy', 'INVENTORY_SALE');
    const [cpcInvR] = await pool.query(`INSERT INTO customer_price_categories (customer_id, category_id, is_default, display_order, sales_flow) VALUES (?,?,1,1,NULL)`, [custInvLegacy, categoryId]);
    cpcIds.push(cpcInvR.insertId);
    let invCatalog = null, invThrew = null;
    try { invCatalog = await PriceMatrixAgent.customerCatalogForOrder(custInvLegacy, categoryId, null, null, 'INVENTORY_SALE'); } catch (e) { invThrew = e; }
    check('Acceptance 1: customerCatalogForOrder succeeds for a legacy-NULL category on an INVENTORY_SALE customer (no CATALOG_CATEGORY_NOT_INVENTORY_SALE)', !invThrew, invThrew && invThrew.message);
    check('Acceptance 1: only INVENTORY_SALE products returned', invCatalog && invCatalog.products.every(p => p.product_id !== pCarcass) && invCatalog.products.some(p => p.product_id === pInv));

    // ── Acceptance 2: CARCASS_POS customer, legacy NULL category ─────────────
    const custCarcassLegacy = await makeCustomer('CarcassLegacy', 'CARCASS_POS');
    const [cpcCarR] = await pool.query(`INSERT INTO customer_price_categories (customer_id, category_id, is_default, display_order, sales_flow) VALUES (?,?,1,1,NULL)`, [custCarcassLegacy, categoryId]);
    cpcIds.push(cpcCarR.insertId);
    let carcassCatalog = null, carcassThrew = null;
    try { carcassCatalog = await PriceMatrixAgent.customerCatalogForOrder(custCarcassLegacy, categoryId, null, null, 'CARCASS_POS'); } catch (e) { carcassThrew = e; }
    check('Acceptance 2: customerCatalogForOrder succeeds for a legacy-NULL category on a CARCASS_POS customer', !carcassThrew, carcassThrew && carcassThrew.message);
    check('Acceptance 2: no INVENTORY_SALE-only product included', carcassCatalog && carcassCatalog.products.every(p => p.product_id !== pInv));

    // ── Acceptance 3: explicit matching category+customer (existing behavior preserved) ──
    const custExplicit = await makeCustomer('Explicit', 'INVENTORY_SALE');
    const [cpcExR] = await pool.query(`INSERT INTO customer_price_categories (customer_id, category_id, is_default, display_order, sales_flow) VALUES (?,?,1,1,'INVENTORY_SALE')`, [custExplicit, categoryId]);
    cpcIds.push(cpcExR.insertId);
    const explicitCatalog = await PriceMatrixAgent.customerCatalogForOrder(custExplicit, categoryId, null, null, 'INVENTORY_SALE');
    check('Acceptance 3: explicit matching category+customer still works', explicitCatalog.products.some(p => p.product_id === pInv));

    // ── Acceptance 4: explicit conflict — audited, NOT silently resolved, NOT
    // hard-blocked at read time (see auditCustomerCategorySalesFlowConflicts
    // doc comment: would break CreateOrder.jsx's shipped Unified Sales V1
    // dual-category feature, which relies on exactly this data shape). The
    // category's OWN explicit value still wins (matches the story's own
    // provided resolver pseudocode, which has no conflict branch) — this test
    // proves the conflict is at least detected/reportable for CTO review. ────
    const custConflict = await makeCustomer('Conflict', 'INVENTORY_SALE');
    const [cpcConflictR] = await pool.query(`INSERT INTO customer_price_categories (customer_id, category_id, is_default, display_order, sales_flow) VALUES (?,?,1,1,'CARCASS_POS')`, [custConflict, categoryId]);
    cpcIds.push(cpcConflictR.insertId);
    const conflicts = await PriceMatrixAgent.auditCustomerCategorySalesFlowConflicts();
    check('Acceptance 4: auditCustomerCategorySalesFlowConflicts detects the conflicting row', conflicts.some(c => c.customer_price_category_id === cpcConflictR.insertId && c.customer_default_sales_flow === 'INVENTORY_SALE' && c.category_sales_flow === 'CARCASS_POS'));

    // ── Acceptance 5: missing both flows — clear config error, no Bò Xô fallback ──
    const custMissing = await makeCustomer('Missing', 'CARCASS_POS');
    await pool.query(`UPDATE customers SET default_sales_flow=NULL WHERE id=?`, [custMissing]);
    const [cpcMissR] = await pool.query(`INSERT INTO customer_price_categories (customer_id, category_id, is_default, display_order, sales_flow) VALUES (?,?,1,1,NULL)`, [custMissing, categoryId]);
    cpcIds.push(cpcMissR.insertId);
    let missingThrew = null;
    try { await PriceMatrixAgent.customerCatalogForOrder(custMissing, categoryId, null, null, 'INVENTORY_SALE'); } catch (e) { missingThrew = e; }
    check('Acceptance 5: fully unresolved flow throws CUSTOMER_SALES_FLOW_NOT_CONFIGURED', !!missingThrew && missingThrew.code === 'CUSTOMER_SALES_FLOW_NOT_CONFIGURED', missingThrew && missingThrew.message);
    check('Acceptance 5: exact required error message', missingThrew && missingThrew.message === 'Khách hàng chưa được thiết lập luồng bán hợp lệ.', missingThrew && missingThrew.message);

    // ── Acceptance 6: backend still rejects a manipulated/incompatible request ──
    let manipulatedThrew = null;
    try { await PriceMatrixAgent.customerCatalogForOrder(custCarcassLegacy, categoryId, null, null, 'INVENTORY_SALE'); } catch (e) { manipulatedThrew = e; }
    check('Acceptance 6: requesting INVENTORY_SALE under an effective-CARCASS_POS category is still rejected', !!manipulatedThrew && manipulatedThrew.code === 'CATALOG_CATEGORY_NOT_INVENTORY_SALE', manipulatedThrew && manipulatedThrew.message);

    // ── Regression: matrix()/assertItemsMatchCategory() paths (fixed in the
    // prior story) still resolve consistently for the SAME legacy-NULL rows ──
    const matrixInv = await PriceMatrixAgent.matrix(custInvLegacy, categoryId);
    check('Regression: matrix() agrees with customerCatalogForOrder() for the same legacy-NULL INVENTORY_SALE customer', matrixInv.rows.some(r => r.product_id === pInv) && !matrixInv.rows.some(r => r.product_id === pCarcass));
    const saveOk = await PriceMatrixAgent.saveMatrix(custInvLegacy, [{ product_id: pInv, in_catalog: true, private_price: 33000, sort_order: 1 }], user.id, { effective_from: '2026-07-29', effective_calendar_type: 'SOLAR' }, categoryId);
    check('Regression: price-book save still works for the same legacy-NULL INVENTORY_SALE customer', !!saveOk.message);
    const [[bookRow]] = await pool.query(`SELECT id FROM customer_price_books WHERE customer_id=? AND category_id=? ORDER BY id DESC LIMIT 1`, [custInvLegacy, categoryId]);
    if (bookRow) await pool.query(`DELETE FROM customer_price_book_items WHERE price_book_id=?`, [bookRow.id]).then(() => pool.query(`DELETE FROM customer_price_books WHERE id=?`, [bookRow.id]));

  } finally {
    for (const id of productIds) await pool.query(`DELETE FROM products WHERE id=?`, [id]);
    for (const id of customerIds) {
      await pool.query(`DELETE FROM customer_price_book_items WHERE customer_id=?`, [id]);
      await pool.query(`DELETE FROM customer_price_books WHERE customer_id=?`, [id]);
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
