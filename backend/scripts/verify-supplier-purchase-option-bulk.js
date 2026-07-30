'use strict';
// Verifies "Bulk Configure Supplier Purchase Units":
//  - bulkList() sources products from the existing, already-approved Supplier
//    Product Catalog resolver (SupplierPurchaseCatalogResolver.resolveCatalog,
//    product_supplier_links fallback here), scoped to supplier+category, never
//    falling back to "every product in the category"
//  - 0/1/2+ existing supplier_purchase_options per product are reported
//    correctly (spo_count, spo only for the unambiguous 0-or-1 case)
//  - bulkSave() validates every row server-side against real IDs (never
//    trusting product/unit names or a claimed supplier relationship), never
//    partially saves on any invalid row, dedups by the exact
//    (partner_id, product_id, unit_id) triple (update if it exists, insert if
//    not) without ever touching a DIFFERENT unit already configured for the
//    same product, and skips genuinely unchanged rows in one batch transaction
//
// Self-cleaning: all throwaway rows removed in `finally`, FK-safe order.

const pool = require('../src/config/db');
const CustomerAgent = require('../src/agents/CustomerAgent');
const ProductAgent = require('../src/agents/ProductAgent');
const SupplierPurchaseOptionAgent = require('../src/agents/SupplierPurchaseOptionAgent');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}

const user = { id: null };

async function main() {
  const productIds = [];
  const spoIds = [];
  const linkIds = [];
  let partnerId = null, legacySupplierId = null, categoryId = null, otherCategoryId = null, unitKgId = null, unitThungId = null;

  try {
    const [categories] = await pool.query(`SELECT id FROM product_categories LIMIT 2`);
    categoryId = categories[0].id;
    otherCategoryId = categories[1]?.id || categories[0].id;
    const [[unitKg]] = await pool.query(`SELECT id FROM units WHERE code='kg' LIMIT 1`);
    unitKgId = unitKg.id;
    const [[unitThung]] = await pool.query(`SELECT id, is_active FROM units WHERE code<>'kg' AND is_active=1 LIMIT 1`);
    unitThungId = unitThung ? unitThung.id : null;
    if (!unitThungId) {
      const [ins] = await pool.query(`INSERT INTO units (code, name, is_active) VALUES ('VBULKTEST','Thùng test',1)`);
      unitThungId = ins.insertId;
    }

    const partnerRes = await CustomerAgent.create({ name: `VERIFY SPOB Supplier ${Date.now()}`, partner_type: 1 }, user);
    const [[partnerRow]] = await pool.query(`SELECT id FROM customers WHERE customer_code=?`, [partnerRes.customer_code]);
    partnerId = partnerRow.id;
    const [[map]] = await pool.query(`SELECT supplier_id FROM supplier_partner_map WHERE partner_id=?`, [partnerId]);
    legacySupplierId = map.supplier_id;

    async function makeProduct(name, catId) {
      await ProductAgent.addProduct({ name: `VERIFY SPOB ${name} ${Date.now()}-${Math.random().toString(36).slice(2,6)}`, unit: 'kg', category_id: catId, inventory_mode: 'TRACK_STOCK', sales_flow: 'INVENTORY_SALE' });
      const [[p]] = await pool.query(`SELECT id FROM products WHERE name LIKE 'VERIFY SPOB ${name} %' ORDER BY id DESC LIMIT 1`);
      productIds.push(p.id);
      return p.id;
    }
    async function linkToSupplier(productId) {
      const [r] = await pool.query(`INSERT INTO product_supplier_links (product_id, supplier_id, purchase_price, is_active) VALUES (?,?,100000,1)`, [productId, legacySupplierId]);
      linkIds.push(r.insertId);
    }
    async function makeSpo(productId, unitId, conv, order = 0) {
      const [r] = await pool.query(
        `INSERT INTO supplier_purchase_options (supplier_id, partner_id, product_id, unit_id, default_conversion_qty, display_order, is_active) VALUES (?,?,?,?,?,?,1)`,
        [legacySupplierId, partnerId, productId, unitId, conv, order]
      );
      spoIds.push(r.insertId);
      return r.insertId;
    }

    const pUnconfigured = await makeProduct('Unconfigured', categoryId);
    const pOneOption = await makeProduct('OneOption', categoryId);
    const pTwoOptions = await makeProduct('TwoOptions', categoryId);
    const pOutsideCategory = await makeProduct('OutsideCategory', otherCategoryId);
    const pNotLinked = await makeProduct('NotLinked', categoryId); // never linked to this supplier

    await linkToSupplier(pUnconfigured);
    await linkToSupplier(pOneOption);
    await linkToSupplier(pTwoOptions);
    await linkToSupplier(pOutsideCategory);
    // pNotLinked deliberately NOT linked — must never appear in the catalog.

    await makeSpo(pOneOption, unitKgId, 1, 1);
    await makeSpo(pTwoOptions, unitKgId, 1, 1);
    await makeSpo(pTwoOptions, unitThungId, 15, 2);

    // ── Product source audit: scoped to supplier + category, never "all products" ──
    const listResult = await SupplierPurchaseOptionAgent.bulkList(partnerId, categoryId);
    check('Product source: catalog_source reported (audit evidence)', !!listResult.catalog_source, listResult.catalog_source);
    const ids = listResult.products.map(p => p.product_id);
    check('Product source: includes linked, in-category products', ids.includes(pUnconfigured) && ids.includes(pOneOption) && ids.includes(pTwoOptions));
    check('Product source: excludes a product outside the selected category', !ids.includes(pOutsideCategory));
    check('Product source: excludes a product never linked to this supplier (never falls back to "all products")', !ids.includes(pNotLinked));

    // ── Existing configuration display ──
    const rowUnconfigured = listResult.products.find(p => p.product_id === pUnconfigured);
    check('Acceptance 3 / display: unconfigured product has spo_count=0, spo=null ("Chưa cấu hình")', rowUnconfigured.spo_count === 0 && rowUnconfigured.spo === null);
    const rowOne = listResult.products.find(p => p.product_id === pOneOption);
    check('Acceptance 3 / display: single-option product has spo_count=1 with correct values inline', rowOne.spo_count === 1 && rowOne.spo.unit_id === unitKgId && Number(rowOne.spo.default_conversion_qty) === 1);
    const rowTwo = listResult.products.find(p => p.product_id === pTwoOptions);
    check('Acceptance 4: multi-option product has spo_count=2, spo=null (never inline-editable, "Có 2 đơn vị")', rowTwo.spo_count === 2 && rowTwo.spo === null);

    // ── Acceptance 2: bulk apply + batch save (3 products, one request) ──
    const bulkRows = [
      { product_id: pUnconfigured, product_name: 'Unconfigured', unit_id: unitKgId, default_conversion_qty: 1, requires_actual_weight: 0, display_order: 1 },
      { product_id: pOneOption, product_name: 'OneOption', unit_id: unitKgId, default_conversion_qty: 1, requires_actual_weight: 0, display_order: 1 }, // unchanged
      { product_id: pTwoOptions, product_name: 'TwoOptions', unit_id: unitKgId, default_conversion_qty: 2, requires_actual_weight: 1, display_order: 5 }, // updates the Kg option only, Thùng untouched
    ];
    const saveResult = await SupplierPurchaseOptionAgent.bulkSave(partnerId, categoryId, bulkRows, user.id);
    check('Acceptance 2: batch save reports correct saved count (2 changed)', saveResult.saved_count === 2, saveResult);
    check('Acceptance 3: batch save reports correct skipped/unchanged count (1 unchanged)', saveResult.skipped_count === 1, saveResult);
    check('Save summary message matches the required format', /^Đã lưu \d+ quy cách nhập\. Bỏ qua \d+ mặt hàng không thay đổi\.$/.test(saveResult.message), saveResult.message);

    const afterUnconfigured = await SupplierPurchaseOptionAgent.bulkList(partnerId, categoryId);
    const afterRowUnconfigured = afterUnconfigured.products.find(p => p.product_id === pUnconfigured);
    check('Acceptance 2: previously-unconfigured product now has 1 option (created, not duplicated)', afterRowUnconfigured.spo_count === 1 && Number(afterRowUnconfigured.spo.default_conversion_qty) === 1);

    // ── Acceptance 4 continued: bulk edit of the Kg option did NOT touch Thùng ──
    const [[thungRow]] = await pool.query(`SELECT default_conversion_qty, is_active FROM supplier_purchase_options WHERE product_id=? AND unit_id=? AND is_active=1`, [pTwoOptions, unitThungId]);
    check('Acceptance 4: the OTHER existing unit (Thùng, 15kg) is completely untouched by the bulk edit of Kg', thungRow && Number(thungRow.default_conversion_qty) === 15);
    const [[kgRowAfter]] = await pool.query(`SELECT id, default_conversion_qty, requires_actual_weight, display_order FROM supplier_purchase_options WHERE product_id=? AND unit_id=? AND is_active=1`, [pTwoOptions, unitKgId]);
    check('Acceptance 6: duplicate rule — the EXISTING Kg option was updated in place (same id), not duplicated', kgRowAfter && spoIds.includes(kgRowAfter.id) && Number(kgRowAfter.default_conversion_qty) === 2 && Number(kgRowAfter.requires_actual_weight) === 1 && Number(kgRowAfter.display_order) === 5);
    const [[kgCount]] = await pool.query(`SELECT COUNT(*) cnt FROM supplier_purchase_options WHERE product_id=? AND unit_id=? AND is_active=1`, [pTwoOptions, unitKgId]);
    check('Acceptance 6: exactly one active Kg option exists for this product (no duplicate row created)', Number(kgCount.cnt) === 1);

    // ── Acceptance 5: invalid row blocks the ENTIRE batch, no partial save ──
    const beforeInvalid = await pool.query(`SELECT COUNT(*) cnt FROM supplier_purchase_options WHERE partner_id=?`, [partnerId]);
    const invalidRows = [
      { product_id: pOneOption, product_name: 'OneOption', unit_id: unitKgId, default_conversion_qty: 99, requires_actual_weight: 0, display_order: 1 }, // valid, would change
      { product_id: pTwoOptions, product_name: 'TwoOptions', unit_id: unitKgId, default_conversion_qty: 0, requires_actual_weight: 0, display_order: 1 }, // invalid: conversion = 0
    ];
    let invalidThrew = null;
    try { await SupplierPurchaseOptionAgent.bulkSave(partnerId, categoryId, invalidRows, user.id); } catch (e) { invalidThrew = e; }
    check('Acceptance 5: batch with one invalid row (conversion=0) is rejected entirely', !!invalidThrew && invalidThrew.code === 'BULK_PURCHASE_OPTION_INVALID_ROWS', invalidThrew && invalidThrew.message);
    check('Acceptance 5: invalid product is identified in the error', invalidThrew && invalidThrew.invalid.some(x => x.product_id === pTwoOptions));
    const afterInvalid = await pool.query(`SELECT COUNT(*) cnt FROM supplier_purchase_options WHERE partner_id=?`, [partnerId]);
    check('Acceptance 5: NO partial save — the valid row (OneOption=99) was NOT persisted either', beforeInvalid[0][0].cnt === afterInvalid[0][0].cnt);
    const [[oneOptionUnchanged]] = await pool.query(`SELECT default_conversion_qty FROM supplier_purchase_options WHERE product_id=? AND unit_id=? AND is_active=1`, [pOneOption, unitKgId]);
    check('Acceptance 5: OneOption\'s value truly unchanged (still 1, not 99)', Number(oneOptionUnchanged.default_conversion_qty) === 1);

    // ── Manipulated request: product from a DIFFERENT category / not linked to this supplier ──
    let manipulatedCategoryThrew = null;
    try { await SupplierPurchaseOptionAgent.bulkSave(partnerId, categoryId, [{ product_id: pOutsideCategory, product_name: 'OutsideCategory', unit_id: unitKgId, default_conversion_qty: 1, display_order: 0 }], user.id); } catch (e) { manipulatedCategoryThrew = e; }
    check('Backend rejects a product outside the selected category, even if otherwise valid', !!manipulatedCategoryThrew && manipulatedCategoryThrew.code === 'BULK_PURCHASE_OPTION_INVALID_ROWS');

    let manipulatedSupplierThrew = null;
    try { await SupplierPurchaseOptionAgent.bulkSave(partnerId, categoryId, [{ product_id: pNotLinked, product_name: 'NotLinked', unit_id: unitKgId, default_conversion_qty: 1, display_order: 0 }], user.id); } catch (e) { manipulatedSupplierThrew = e; }
    check('Backend rejects a product not in this supplier\'s catalog, even if otherwise valid', !!manipulatedSupplierThrew && manipulatedSupplierThrew.code === 'BULK_PURCHASE_OPTION_INVALID_ROWS');

    // ── Performance: 100 products, one batch load + one batch save ──
    const manyProductIds = [];
    for (let i = 0; i < 100; i++) {
      const pid = await makeProduct(`Perf${i}`, categoryId);
      await linkToSupplier(pid);
      manyProductIds.push(pid);
    }
    const t0 = Date.now();
    const bigList = await SupplierPurchaseOptionAgent.bulkList(partnerId, categoryId);
    const listMs = Date.now() - t0;
    check('Acceptance 1: 100+ product category loads via ONE bulkList() call', bigList.products.length >= 100, bigList.products.length);
    check('Acceptance 1: loads in reasonable time (no per-row query fan-out)', listMs < 3000, `${listMs}ms`);

    const bigRows = manyProductIds.map((pid, i) => ({ product_id: pid, product_name: `Perf${i}`, unit_id: unitKgId, default_conversion_qty: 1, requires_actual_weight: 0, display_order: i }));
    const t1 = Date.now();
    const bigSave = await SupplierPurchaseOptionAgent.bulkSave(partnerId, categoryId, bigRows, user.id);
    const saveMs = Date.now() - t1;
    check('Performance: 100-row batch saved in ONE call (no per-row request)', bigSave.saved_count === 100, bigSave.saved_count);
    check('Performance: batch save completes in reasonable time', saveMs < 10000, `${saveMs}ms`);

  } finally {
    for (const id of spoIds) await pool.query(`DELETE FROM supplier_purchase_options WHERE id=?`, [id]).catch(() => {});
    if (partnerId) await pool.query(`DELETE FROM supplier_purchase_options WHERE partner_id=?`, [partnerId]).catch(() => {});
    for (const id of linkIds) await pool.query(`DELETE FROM product_supplier_links WHERE id=?`, [id]).catch(() => {});
    if (unitThungId) await pool.query(`DELETE FROM units WHERE id=? AND code='VBULKTEST'`, [unitThungId]).catch(() => {});
    for (const id of productIds) await pool.query(`DELETE FROM products WHERE id=?`, [id]).catch(() => {});
    if (partnerId) {
      const [[p]] = await pool.query(`SELECT customer_code FROM customers WHERE id=?`, [partnerId]);
      await pool.query(`DELETE FROM supplier_partner_map WHERE partner_id=?`, [partnerId]);
      if (p) await pool.query(`DELETE FROM suppliers WHERE supplier_code=?`, [p.customer_code]);
      await pool.query(`DELETE FROM customers WHERE id=?`, [partnerId]);
    }
    console.log('Cleanup done.');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
