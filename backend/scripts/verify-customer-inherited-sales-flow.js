'use strict';
// Verifies "Customer Price Category Must Inherit Customer Sales Flow" (S1M):
//  - centralized resolveEffectiveSalesFlow (category's own value first, else
//    customers.default_sales_flow) drives category listing/display, Price
//    Matrix product loading, the save-time guard, and category creation
//    identically — never a second, disagreeing fallback rule
//  - a new category created with no explicit sales_flow inherits the
//    customer's default automatically, and is blocked with a clear message
//    when the customer itself has no valid default
//  - changing customers.default_sales_flow is blocked when an inheriting
//    category already has incompatible saved price-book items, and never
//    deletes/modifies existing price data
//  - CreateOrder.jsx's Unified Sales V1 "otherFlow" dual-category-per-customer
//    support (an explicit sales_flow passed by the caller) is unaffected by
//    the new inheritance default
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
      const res = await CustomerAgent.create({ name: `VERIFY CISF ${name} ${Date.now()}-${Math.random().toString(36).slice(2,6)}`, phone: `09${String(Date.now()).slice(-6)}${String(Math.floor(Math.random()*90)+10)}`, partner_type: 0, default_sales_flow: defaultFlow }, user);
      const [[row]] = await pool.query(`SELECT id FROM customers WHERE customer_code=?`, [res.customer_code]);
      customerIds.push(row.id);
      return row.id;
    }
    async function makeProduct(name, salesFlow) {
      const mode = salesFlow === 'INVENTORY_SALE' ? 'TRACK_STOCK' : 'NON_STOCK';
      await ProductAgent.addProduct({ name: `VERIFY CISF ${name} ${Date.now()}-${Math.random().toString(36).slice(2,6)}`, unit: 'kg', category_id: categoryId, inventory_mode: mode, sales_flow: salesFlow });
      const [[p]] = await pool.query(`SELECT id FROM products WHERE name LIKE 'VERIFY CISF ${name} %' ORDER BY id DESC LIMIT 1`);
      productIds.push(p.id);
      return p.id;
    }

    const pInv = await makeProduct('Inv', 'INVENTORY_SALE');
    const pCarcass = await makeProduct('Carcass', 'CARCASS_POS');

    // ── Root cause reproduction: NULL category + valid customer default must
    // display the inherited label, never "Chưa xác định" ──────────────────
    const custHangKho = await makeCustomer('HangKho', 'INVENTORY_SALE');
    const [cpcHkR] = await pool.query(`INSERT INTO customer_price_categories (customer_id, category_id, is_default, display_order, sales_flow) VALUES (?,?,1,1,NULL)`, [custHangKho, categoryId]);
    cpcIds.push(cpcHkR.insertId);
    const listHk = await PriceMatrixAgent.listCustomerPriceCategories(custHangKho);
    check('Acceptance 1: NULL category for a Hàng kho customer resolves sales_flow=INVENTORY_SALE (no "Chưa xác định")', listHk.find(c => c.id === cpcHkR.insertId)?.sales_flow === 'INVENTORY_SALE');
    const matrixHk = await PriceMatrixAgent.matrix(custHangKho, categoryId);
    check('Acceptance 1: only INVENTORY_SALE products load', matrixHk.rows.some(r => r.product_id === pInv) && !matrixHk.rows.some(r => r.product_id === pCarcass));

    const custBoXo = await makeCustomer('BoXo', 'CARCASS_POS');
    const [cpcBxR] = await pool.query(`INSERT INTO customer_price_categories (customer_id, category_id, is_default, display_order, sales_flow) VALUES (?,?,1,1,NULL)`, [custBoXo, categoryId]);
    cpcIds.push(cpcBxR.insertId);
    const listBx = await PriceMatrixAgent.listCustomerPriceCategories(custBoXo);
    check('Acceptance 2: NULL category for a Bò xô customer resolves sales_flow=CARCASS_POS', listBx.find(c => c.id === cpcBxR.insertId)?.sales_flow === 'CARCASS_POS');
    const matrixBx = await PriceMatrixAgent.matrix(custBoXo, categoryId);
    check('Acceptance 2: only CARCASS_POS products load', !matrixBx.rows.some(r => r.product_id === pInv));

    // ── Acceptance 3/4: create category (no sales_flow) inherits from customer ──
    const custCreateHk = await makeCustomer('CreateHk', 'INVENTORY_SALE');
    const createdHk = await PriceMatrixAgent.createCustomerPriceCategory(custCreateHk, categoryId, {});
    cpcIds.push(createdHk.id);
    check('Acceptance 3: created row sales_flow=INVENTORY_SALE with no explicit selector', createdHk.sales_flow === 'INVENTORY_SALE');

    const custCreateBx = await makeCustomer('CreateBx', 'CARCASS_POS');
    const createdBx = await PriceMatrixAgent.createCustomerPriceCategory(custCreateBx, categoryId, {});
    cpcIds.push(createdBx.id);
    check('Acceptance 4: created row sales_flow=CARCASS_POS with no explicit selector', createdBx.sales_flow === 'CARCASS_POS');

    // ── Acceptance 5: customer missing sales flow blocks category creation ──
    const custMissing = await makeCustomer('Missing', 'CARCASS_POS');
    await pool.query(`UPDATE customers SET default_sales_flow=NULL WHERE id=?`, [custMissing]);
    let missingThrew = null;
    try { await PriceMatrixAgent.createCustomerPriceCategory(custMissing, categoryId, {}); } catch (e) { missingThrew = e; }
    check('Acceptance 5: category creation blocked when customer has no valid default_sales_flow', !!missingThrew && missingThrew.code === 'CUSTOMER_DEFAULT_SALES_FLOW_REQUIRED', missingThrew && missingThrew.message);

    // ── Acceptance 6: backend still rejects a manipulated incompatible payload ──
    let mismatchThrew = null;
    try {
      await PriceMatrixAgent.saveMatrix(custHangKho, [{ product_id: pCarcass, in_catalog: true, private_price: 1000, sort_order: 1 }], user.id, { effective_from: '2026-07-29', effective_calendar_type: 'SOLAR' }, categoryId);
    } catch (e) { mismatchThrew = e; }
    check('Acceptance 6: PRICE_CATEGORY_SALES_FLOW_MISMATCH still rejects an incompatible save (using the inherited flow)', !!mismatchThrew && mismatchThrew.code === 'PRICE_CATEGORY_SALES_FLOW_MISMATCH', mismatchThrew && mismatchThrew.message);

    // ── Acceptance 7: changing customer default_sales_flow with an incompatible
    // existing (inheriting) price book is blocked, nothing deleted ──────────
    const custChange = await makeCustomer('Change', 'CARCASS_POS');
    const [cpcChangeR] = await pool.query(`INSERT INTO customer_price_categories (customer_id, category_id, is_default, display_order, sales_flow) VALUES (?,?,1,1,NULL)`, [custChange, categoryId]);
    cpcIds.push(cpcChangeR.insertId);
    await PriceMatrixAgent.saveMatrix(custChange, [{ product_id: pCarcass, in_catalog: true, private_price: 45000, sort_order: 1 }], user.id, { effective_from: '2026-07-29', effective_calendar_type: 'SOLAR' }, categoryId);
    const [[bookChange]] = await pool.query(`SELECT id FROM customer_price_books WHERE customer_id=? AND category_id=? ORDER BY id DESC LIMIT 1`, [custChange, categoryId]);
    if (bookChange) bookIds.push(bookChange.id);

    let flowChangeThrew = null;
    try { await CustomerAgent.update(custChange, { name: 'VERIFY CISF Change updated', partner_type: 0, default_sales_flow: 'INVENTORY_SALE' }, { role: 'ADMIN' }); } catch (e) { flowChangeThrew = e; }
    check('Acceptance 7: customer default_sales_flow change blocked when an inheriting category has incompatible saved items', !!flowChangeThrew && flowChangeThrew.code === 'CUSTOMER_DEFAULT_SALES_FLOW_CHANGE_BLOCKED', flowChangeThrew && flowChangeThrew.message);
    const [[custAfterBlock]] = await pool.query(`SELECT default_sales_flow, name FROM customers WHERE id=?`, [custChange]);
    check('Acceptance 7: default_sales_flow was NOT silently changed', custAfterBlock.default_sales_flow === 'CARCASS_POS');
    check('Acceptance 7: unrelated fields (name) were also not persisted from the rejected update', !custAfterBlock.name.includes('updated'));
    const [[itemStill]] = await pool.query(`SELECT sale_price FROM customer_price_book_items WHERE price_book_id=? AND product_id=?`, [bookChange.id, pCarcass]);
    check('Acceptance 7: existing saved price was NOT deleted or modified', itemStill && Number(itemStill.sale_price) === 45000);

    // Compatible change (same flow) succeeds normally.
    const okChange = await CustomerAgent.update(custChange, { name: 'VERIFY CISF Change', partner_type: 0, default_sales_flow: 'CARCASS_POS' }, { role: 'ADMIN' });
    check('Same-flow customer update (no actual change) succeeds normally', !!okChange.message);

    // Change to a flow with NO conflicting items succeeds.
    const custChangeSafe = await makeCustomer('ChangeSafe', 'CARCASS_POS');
    const [cpcSafeR] = await pool.query(`INSERT INTO customer_price_categories (customer_id, category_id, is_default, display_order, sales_flow) VALUES (?,?,1,1,'CARCASS_POS')`, [custChangeSafe, categoryId]);
    cpcIds.push(cpcSafeR.insertId); // explicit sales_flow on the category — customer default change cannot affect it
    const safeChange = await CustomerAgent.update(custChangeSafe, { name: 'VERIFY CISF ChangeSafe', partner_type: 0, default_sales_flow: 'INVENTORY_SALE' }, { role: 'ADMIN' });
    check('Changing default_sales_flow is allowed when the customer has no INHERITING (NULL) category to conflict', !!safeChange.message);

    // ── Regression: CreateOrder.jsx's Unified Sales V1 "otherFlow" pattern —
    // an explicit sales_flow opposite the customer's own default must still be
    // honored exactly (dual-flow-per-customer bill support unaffected). ─────
    const custDual = await makeCustomer('Dual', 'CARCASS_POS');
    const dualOther = await PriceMatrixAgent.createCustomerPriceCategory(custDual, categoryId, { sales_flow: 'INVENTORY_SALE' });
    cpcIds.push(dualOther.id);
    check('Regression: explicit sales_flow (opposite of customer default) is still honored — Unified Sales V1 otherFlow unaffected', dualOther.sales_flow === 'INVENTORY_SALE');
    const dualList = await PriceMatrixAgent.listCustomerPriceCategories(custDual);
    check('Regression: the explicit category keeps its own value, not the customer default', dualList.find(c => c.id === dualOther.id)?.sales_flow === 'INVENTORY_SALE');

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
