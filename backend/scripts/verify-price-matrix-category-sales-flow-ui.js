'use strict';
// Verifies "Complete Customer Price Category Sales Flow UI":
//  - creating a NEW Customer Price Category now REQUIRES an explicit sales_flow
//    (CARCASS_POS/INVENTORY_SALE only — never NULL, empty, MIXED, or a display label)
//  - reclassifying an EXISTING category's sales_flow is audited against every
//    already-saved price-book item and blocked (never silently changed, never
//    deletes data) if any item would become incompatible
//  - a legacy sales_flow=NULL category can never get a brand-new price book
//    until explicitly classified, but an already-existing, internally-consistent
//    legacy book keeps working exactly as before (no forced/silent migration)
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
  const cpcIds = [];
  let categoryId = null;

  try {
    const [[cat]] = await pool.query(`SELECT id FROM product_categories LIMIT 1`);
    categoryId = cat.id;

    async function makeCustomer(name, defaultFlow) {
      const res = await CustomerAgent.create({ name: `VERIFY PMCF ${name} ${Date.now()}-${Math.random().toString(36).slice(2,6)}`, phone: `09${String(Date.now()).slice(-6)}${String(Math.floor(Math.random()*90)+10)}`, partner_type: 0, default_sales_flow: defaultFlow }, user);
      const [[row]] = await pool.query(`SELECT id FROM customers WHERE customer_code=?`, [res.customer_code]);
      customerIds.push(row.id);
      return row.id;
    }
    async function makeProduct(name, salesFlow) {
      const mode = salesFlow === 'INVENTORY_SALE' ? 'TRACK_STOCK' : 'NON_STOCK';
      await ProductAgent.addProduct({ name: `VERIFY PMCF ${name} ${Date.now()}-${Math.random().toString(36).slice(2,6)}`, unit: 'kg', category_id: categoryId, inventory_mode: mode, sales_flow: salesFlow });
      const [[p]] = await pool.query(`SELECT id FROM products WHERE name LIKE 'VERIFY PMCF ${name} %' ORDER BY id DESC LIMIT 1`);
      productIds.push(p.id);
      return p.id;
    }

    const pInv = await makeProduct('Inv', 'INVENTORY_SALE');
    const pCarcass = await makeProduct('Carcass', 'CARCASS_POS');

    // ── S1M correction / Mandatory test 3 — Create validation ───────────────
    // sales_flow omitted now INHERITS the customer's own default_sales_flow —
    // the user is never asked to pick it again (custA has a valid default, so
    // creation succeeds and stores the inherited value).
    const custA = await makeCustomer('CustA', 'CARCASS_POS');
    const inheritedCreate = await PriceMatrixAgent.createCustomerPriceCategory(custA, categoryId, {});
    cpcIds.push(inheritedCreate.id);
    check('S1M: sales_flow omitted inherits the customer\'s default_sales_flow (CARCASS_POS)', inheritedCreate.sales_flow === 'CARCASS_POS', inheritedCreate.sales_flow);

    // Acceptance test 5 — a customer with NO valid default_sales_flow blocks
    // creation with a clear message, rather than silently defaulting to CARCASS_POS.
    const custNoDefault = await makeCustomer('CustNoDefault', 'CARCASS_POS');
    await pool.query(`UPDATE customers SET default_sales_flow=NULL WHERE id=?`, [custNoDefault]);
    let noDefaultThrew = null;
    try { await PriceMatrixAgent.createCustomerPriceCategory(custNoDefault, categoryId, {}); } catch (e) { noDefaultThrew = e; }
    check('Acceptance 5: customer with no valid default_sales_flow blocks category creation (CUSTOMER_DEFAULT_SALES_FLOW_REQUIRED)', !!noDefaultThrew && noDefaultThrew.code === 'CUSTOMER_DEFAULT_SALES_FLOW_REQUIRED', noDefaultThrew && noDefaultThrew.message);
    check('Acceptance 5: blocked-creation message matches the required text', noDefaultThrew && noDefaultThrew.message === 'Khách hàng chưa được thiết lập luồng bán. Vui lòng cập nhật khách hàng trước.', noDefaultThrew && noDefaultThrew.message);

    let mixedThrew = null;
    try { await PriceMatrixAgent.createCustomerPriceCategory(custA, categoryId, { sales_flow: 'MIXED' }); } catch (e) { mixedThrew = e; }
    check('Create: sales_flow=MIXED is rejected (INVALID_PRICE_CATEGORY_SALES_FLOW)', !!mixedThrew && mixedThrew.code === 'INVALID_PRICE_CATEGORY_SALES_FLOW', mixedThrew && mixedThrew.message);

    let labelThrew = null;
    try { await PriceMatrixAgent.createCustomerPriceCategory(custA, categoryId, { sales_flow: 'Bò xô' }); } catch (e) { labelThrew = e; }
    check('Create: a client display label ("Bò xô") is rejected, only the technical enum is accepted', !!labelThrew && labelThrew.code === 'INVALID_PRICE_CATEGORY_SALES_FLOW', labelThrew && labelThrew.message);

    // ── Acceptance test 1: create Hàng kho category ─────────────────────────
    const custInv = await makeCustomer('CustInv', 'CARCASS_POS'); // default flow deliberately opposite
    const createdInv = await PriceMatrixAgent.createCustomerPriceCategory(custInv, categoryId, { sales_flow: 'INVENTORY_SALE' });
    cpcIds.push(createdInv.id);
    check('Acceptance 1: created category stores sales_flow=INVENTORY_SALE', createdInv.sales_flow === 'INVENTORY_SALE');
    const [[storedInv]] = await pool.query(`SELECT sales_flow FROM customer_price_categories WHERE id=?`, [createdInv.id]);
    check('Acceptance 1: database row persisted INVENTORY_SALE', storedInv.sales_flow === 'INVENTORY_SALE');
    const matrixInv = await PriceMatrixAgent.matrix(custInv, categoryId);
    check('Acceptance 1: Price Matrix shows the INVENTORY_SALE product', matrixInv.rows.some(r => r.product_id === pInv));
    check('Acceptance 1: Price Matrix excludes the CARCASS_POS product', !matrixInv.rows.some(r => r.product_id === pCarcass));
    const savedInv = await PriceMatrixAgent.saveMatrix(custInv, [{ product_id: pInv, in_catalog: true, private_price: 77000, sort_order: 1 }], user.id, { effective_from: '2026-07-29', effective_calendar_type: 'SOLAR' }, categoryId);
    check('Acceptance 1: pricing the INVENTORY_SALE product saves without PRICE_CATEGORY_SALES_FLOW_MISMATCH', !!savedInv.message);
    const [[bookInv]] = await pool.query(`SELECT id FROM customer_price_books WHERE customer_id=? AND category_id=? ORDER BY id DESC LIMIT 1`, [custInv, categoryId]);
    if (bookInv) bookIds.push(bookInv.id);

    // ── Acceptance test 2: create Bò xô category ─────────────────────────────
    const custCarcass = await makeCustomer('CustCarcass', 'INVENTORY_SALE');
    const createdCarcass = await PriceMatrixAgent.createCustomerPriceCategory(custCarcass, categoryId, { sales_flow: 'CARCASS_POS' });
    cpcIds.push(createdCarcass.id);
    const [[storedCarcass]] = await pool.query(`SELECT sales_flow FROM customer_price_categories WHERE id=?`, [createdCarcass.id]);
    check('Acceptance 2: database row persisted CARCASS_POS', storedCarcass.sales_flow === 'CARCASS_POS');
    const matrixCarcass = await PriceMatrixAgent.matrix(custCarcass, categoryId);
    check('Acceptance 2: Price Matrix excludes the INVENTORY_SALE product', !matrixCarcass.rows.some(r => r.product_id === pInv));

    // ── Acceptance test 4: edit empty category (no price data) succeeds ─────
    const custEmpty = await makeCustomer('CustEmpty', 'CARCASS_POS');
    const createdEmpty = await PriceMatrixAgent.createCustomerPriceCategory(custEmpty, categoryId, { sales_flow: 'CARCASS_POS' });
    cpcIds.push(createdEmpty.id);
    const editEmpty = await PriceMatrixAgent.updateCustomerPriceCategorySalesFlow(createdEmpty.id, 'INVENTORY_SALE');
    check('Acceptance 4: empty category flow change succeeds', editEmpty.changed === true && editEmpty.sales_flow === 'INVENTORY_SALE');
    const matrixAfterEdit = await PriceMatrixAgent.matrix(custEmpty, categoryId);
    check('Acceptance 4: product list refreshes to Hàng kho products after the change', matrixAfterEdit.rows.some(r => r.product_id === pInv) && !matrixAfterEdit.rows.some(r => r.product_id === pCarcass));

    // ── Acceptance test 5: edit populated (incompatible) category is blocked ─
    const custPopulated = await makeCustomer('CustPopulated', 'CARCASS_POS');
    const createdPop = await PriceMatrixAgent.createCustomerPriceCategory(custPopulated, categoryId, { sales_flow: 'CARCASS_POS' });
    cpcIds.push(createdPop.id);
    await PriceMatrixAgent.saveMatrix(custPopulated, [{ product_id: pCarcass, in_catalog: true, private_price: 55000, sort_order: 1 }], user.id, { effective_from: '2026-07-29', effective_calendar_type: 'SOLAR' }, categoryId);
    const [[bookPop]] = await pool.query(`SELECT id FROM customer_price_books WHERE customer_id=? AND category_id=? ORDER BY id DESC LIMIT 1`, [custPopulated, categoryId]);
    if (bookPop) bookIds.push(bookPop.id);
    let blockedThrew = null;
    try { await PriceMatrixAgent.updateCustomerPriceCategorySalesFlow(createdPop.id, 'INVENTORY_SALE'); } catch (e) { blockedThrew = e; }
    check('Acceptance 5: reclassifying a populated/incompatible category is blocked (409)', !!blockedThrew && blockedThrew.code === 'PRICE_CATEGORY_SALES_FLOW_CHANGE_BLOCKED', blockedThrew && blockedThrew.message);
    const [[cpcAfterBlock]] = await pool.query(`SELECT sales_flow FROM customer_price_categories WHERE id=?`, [createdPop.id]);
    check('Acceptance 5: sales_flow was NOT silently changed', cpcAfterBlock.sales_flow === 'CARCASS_POS');
    const [[itemStillThere]] = await pool.query(`SELECT sale_price FROM customer_price_book_items WHERE price_book_id=? AND product_id=?`, [bookPop.id, pCarcass]);
    check('Acceptance 5: existing saved price was NOT deleted', itemStillThere && Number(itemStillThere.sale_price) === 55000);

    // ── Acceptance test 6 / Legacy NULL category ─────────────────────────────
    // S1M correction: "Chưa xác định" (fully unresolved) now requires BOTH the
    // category's own value AND the customer's default_sales_flow to be
    // missing — default_sales_flow is forced to NULL here (unreachable via the
    // real create/update API, only via direct legacy data) to reproduce that
    // genuine case. The separate "NULL category + valid customer default"
    // inheritance case is covered end-to-end in
    // verify-price-matrix-sales-flow-filter.js.
    const custLegacyEmpty = await makeCustomer('CustLegacyEmpty', 'INVENTORY_SALE');
    await pool.query(`UPDATE customers SET default_sales_flow=NULL WHERE id=?`, [custLegacyEmpty]);
    const [cpcLegacyR] = await pool.query(`INSERT INTO customer_price_categories (customer_id, category_id, is_default, display_order, sales_flow) VALUES (?,?,1,1,NULL)`, [custLegacyEmpty, categoryId]);
    const cpcLegacyId = cpcLegacyR.insertId; cpcIds.push(cpcLegacyId);
    const legacyList = await PriceMatrixAgent.listCustomerPriceCategories(custLegacyEmpty);
    check('Legacy: fully unresolved row (category NULL + customer default NULL) reports sales_flow=null (UI renders "Chưa xác định")', legacyList.find(c => c.id === cpcLegacyId)?.sales_flow == null);
    let legacyBookThrew = null;
    try {
      await PriceMatrixAgent.saveMatrix(custLegacyEmpty, [{ product_id: pCarcass, in_catalog: true, private_price: 10000, sort_order: 1 }], user.id, { effective_from: '2026-07-29', effective_calendar_type: 'SOLAR' }, categoryId);
    } catch (e) { legacyBookThrew = e; }
    check('Legacy: creating a brand-new price book under an unclassified category is blocked (PRICE_CATEGORY_SALES_FLOW_REQUIRED_FOR_BOOK)', !!legacyBookThrew && legacyBookThrew.code === 'PRICE_CATEGORY_SALES_FLOW_REQUIRED_FOR_BOOK', legacyBookThrew && legacyBookThrew.message);
    // classify it, then the same save succeeds
    await PriceMatrixAgent.updateCustomerPriceCategorySalesFlow(cpcLegacyId, 'CARCASS_POS');
    const legacySavedNow = await PriceMatrixAgent.saveMatrix(custLegacyEmpty, [{ product_id: pCarcass, in_catalog: true, private_price: 10000, sort_order: 1 }], user.id, { effective_from: '2026-07-29', effective_calendar_type: 'SOLAR' }, categoryId);
    check('Legacy: after explicit classification, the same save now succeeds', !!legacySavedNow.message);
    const [[bookLegacy]] = await pool.query(`SELECT id FROM customer_price_books WHERE customer_id=? AND category_id=? ORDER BY id DESC LIMIT 1`, [custLegacyEmpty, categoryId]);
    if (bookLegacy) bookIds.push(bookLegacy.id);

    // ── Regression: an existing, internally-consistent legacy NULL category with
    // an EXISTING book must keep working (re-saving the same date) without being
    // forced to classify first — proves no live-data regression (e.g. a real
    // "Hồng Hiền"-shaped row: NULL category, one pre-existing consistent book). ──
    const custLegacyPopulated = await makeCustomer('CustLegacyPopulated', 'CARCASS_POS');
    const [cpcLegacyPopR] = await pool.query(`INSERT INTO customer_price_categories (customer_id, category_id, is_default, display_order, sales_flow) VALUES (?,?,1,1,NULL)`, [custLegacyPopulated, categoryId]);
    const cpcLegacyPopId = cpcLegacyPopR.insertId; cpcIds.push(cpcLegacyPopId);
    const [legacyPopBookR] = await pool.query(
      `INSERT INTO customer_price_books (customer_id, category_id, customer_price_category_id, book_name, effective_from, effective_calendar_type, status) VALUES (?,?,?,?,?,'SOLAR','ACTIVE')`,
      [custLegacyPopulated, categoryId, cpcLegacyPopId, 'Pre-existing legacy book', '2026-07-29']
    );
    bookIds.push(legacyPopBookR.insertId);
    await pool.query(`INSERT INTO customer_price_book_items (price_book_id, customer_id, product_id, sale_price) VALUES (?,?,?,?)`, [legacyPopBookR.insertId, custLegacyPopulated, pCarcass, 60000]);
    const regressionSave = await PriceMatrixAgent.saveMatrix(custLegacyPopulated, [{ product_id: pCarcass, in_catalog: true, private_price: 65000, sort_order: 1 }], user.id, { effective_from: '2026-07-29', effective_calendar_type: 'SOLAR' }, categoryId);
    check('Regression: re-saving an EXISTING legacy-NULL-category book (same effective date) is NOT blocked', !!regressionSave.message);
    const matrixLegacyPop = await PriceMatrixAgent.matrix(custLegacyPopulated, categoryId);
    const legacyPopRow = matrixLegacyPop.rows.find(r => r.product_id === pCarcass);
    check('Regression: updated price reflected, existing legacy book still fully functional', legacyPopRow && Number(legacyPopRow.private_price) === 65000, legacyPopRow && legacyPopRow.private_price);

    // ── Regression 7: backend mismatch guard still intact ───────────────────
    let guardThrew = null;
    try {
      await PriceMatrixAgent.saveMatrix(custInv, [{ product_id: pCarcass, in_catalog: true, private_price: 1000, sort_order: 1 }], user.id, { effective_from: '2026-07-29', effective_calendar_type: 'SOLAR' }, categoryId);
    } catch (e) { guardThrew = e; }
    check('Regression 7: PRICE_CATEGORY_SALES_FLOW_MISMATCH guard still rejects an incompatible save-time payload', !!guardThrew && guardThrew.code === 'PRICE_CATEGORY_SALES_FLOW_MISMATCH', guardThrew && guardThrew.message);

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
