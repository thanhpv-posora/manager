'use strict';
// S4.2 verification — category-scoped price books.
// Exercises real DB code paths (PriceMatrixAgent, PriceBookService, SupplierPurchaseCatalogResolver)
// against a single throwaway test customer, cleaned up in `finally` regardless of pass/fail.
// Does not touch any pre-existing customer/product/price-book data.

const pool = require('../src/config/db');
const PriceMatrixAgent = require('../src/agents/PriceMatrixAgent');
const PriceBookService = require('../src/services/PriceBookService');
const SupplierPurchaseCatalogResolver = require('../src/services/SupplierPurchaseCatalogResolver');
const InventoryPurchaseAgent = require('../src/agents/InventoryPurchaseAgent');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}

async function main() {
  let testCustomerId = null;
  const createdBookIds = [];
  const createdCategoryIds = [];

  try {
    // ── Setup: one throwaway customer, reuse existing real products/categories ──
    const [[beefCat]] = await pool.query(`SELECT id FROM product_categories WHERE name='Thịt bò' LIMIT 1`);
    const [[chickenCat]] = await pool.query(`SELECT id FROM product_categories WHERE name='Thịt gà' LIMIT 1`);
    const [[beefProduct]] = await pool.query(`SELECT id FROM products WHERE category_id=? AND del_flg=0 LIMIT 1`, [beefCat.id]);
    const [[chickenProduct]] = await pool.query(`SELECT id FROM products WHERE category_id=? AND del_flg=0 LIMIT 1`, [chickenCat.id]);
    console.log(`Using categories: Bò=${beefCat.id} (product ${beefProduct.id}), Gà=${chickenCat.id} (product ${chickenProduct.id})`);

    const [custIns] = await pool.query(
      `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type)
       VALUES(?,?,?,?,?,?,?,?)`,
      [`S42TEST-${Date.now()}`, 'S4.2 Verify Test Customer', '0000000000', 'test', 'PRIVATE_PRICE', 0, 0, 'SOLAR']
    );
    testCustomerId = custIns.insertId;
    console.log(`Created throwaway test customer id=${testCustomerId}`);

    const EFFECTIVE_DATE = '2026-08-01';

    // S4.3: a price book can only be created under an existing Customer Price Category —
    // set both up first (same explicit-confirm entry point POS/Price Matrix use).
    const beefCpc = await PriceMatrixAgent.createCustomerPriceCategory(testCustomerId, beefCat.id, {});
    createdCategoryIds.push(beefCpc.id);
    const chickenCpc = await PriceMatrixAgent.createCustomerPriceCategory(testCustomerId, chickenCat.id, {});
    createdCategoryIds.push(chickenCpc.id);

    // ── Scenario 1: Customer A + Bò price book ──
    const r1 = await PriceMatrixAgent.saveMatrix(
      testCustomerId,
      [{ product_id: beefProduct.id, private_price: 99000, in_catalog: true }],
      null,
      { effective_from: EFFECTIVE_DATE, effective_calendar_type: 'SOLAR' },
      beefCat.id
    );
    check('Customer A + Bò price book created', !!r1, JSON.stringify(r1));

    // ── Scenario 2: Customer A + Gà price book, SAME effective date ──
    let scenario2Error = null;
    try {
      await PriceMatrixAgent.saveMatrix(
        testCustomerId,
        [{ product_id: chickenProduct.id, private_price: 55000, in_catalog: true }],
        null,
        { effective_from: EFFECTIVE_DATE, effective_calendar_type: 'SOLAR' },
        chickenCat.id
      );
    } catch (e) { scenario2Error = e; }
    check('Same effective date allowed for different category (Bò + Gà)', !scenario2Error, scenario2Error && scenario2Error.message);

    // ── Scenario 3: Bò price book cannot contain Gà product ──
    let scenario3Rejected = false;
    try {
      await PriceMatrixAgent.saveMatrix(
        testCustomerId,
        [{ product_id: chickenProduct.id, private_price: 1, in_catalog: true }],
        null,
        { effective_from: EFFECTIVE_DATE, effective_calendar_type: 'SOLAR' },
        beefCat.id
      );
    } catch (e) { scenario3Rejected = true; }
    check('Bò price book rejects Gà product', scenario3Rejected);

    // collect created book ids for cleanup
    const [books] = await pool.query(`SELECT id FROM customer_price_books WHERE customer_id=?`, [testCustomerId]);
    books.forEach(b => createdBookIds.push(b.id));

    // ── Scenario 4: POS bill resolves the correct category price ──
    const beefPrice = await PriceBookService.getEffectivePrice(testCustomerId, beefProduct.id, EFFECTIVE_DATE, pool, 'SOLAR', '');
    check('POS Bò bill gets Bò price (99000)', beefPrice && Number(beefPrice.sale_price) === 99000, JSON.stringify(beefPrice));

    const chickenPrice = await PriceBookService.getEffectivePrice(testCustomerId, chickenProduct.id, EFFECTIVE_DATE, pool, 'SOLAR', '');
    check('POS Gà bill gets Gà price (55000), not Bò price', chickenPrice && Number(chickenPrice.sale_price) === 55000, JSON.stringify(chickenPrice));

    // ── Scenario 5: Purchase catalog loads only matching category (read-only, real supplier data) ──
    const [[beefPartner]] = await pool.query(
      `SELECT b.customer_id FROM customer_price_books b
       JOIN customers c ON c.id=b.customer_id
       WHERE b.category_id=? AND (c.partner_type & 1)=1 LIMIT 1`, [beefCat.id]
    );
    if (beefPartner) {
      const catalogBeef = await SupplierPurchaseCatalogResolver.resolveCatalog(beefPartner.customer_id, null, EFFECTIVE_DATE, 'SOLAR', beefCat.id);
      const catalogChicken = await SupplierPurchaseCatalogResolver.resolveCatalog(beefPartner.customer_id, null, EFFECTIVE_DATE, 'SOLAR', chickenCat.id);
      check(
        'Purchase catalog (Bò category) returns no Gà products',
        !catalogBeef.items.some(i => String(i.category_name || '').toLowerCase().includes('gà')),
        JSON.stringify(catalogBeef.items.map(i => i.product_name))
      );
      check(
        'Purchase catalog (Gà category) returns no Bò products',
        !catalogChicken.items.some(i => String(i.category_name || '').toLowerCase().includes('bò')),
        JSON.stringify(catalogChicken.items.map(i => i.product_name))
      );
    } else {
      console.log('  [SKIP] No existing partner with a Bò price book found for purchase-catalog scenario');
    }

    // ── Scenario 6: InventoryPurchaseAgent must not trust client purchase_price ──
    let testPoId = null;
    try {
      // Pick a link whose supplier bills on SOLAR calendar — LUNAR purchase-catalog lookups
      // require a lunar_date_text the /supplier-catalog endpoint doesn't collect (pre-existing
      // gap, unrelated to S4.2 category scoping; noted separately in the report).
      const [[link]] = await pool.query(
        `SELECT psl.supplier_id, psl.product_id, psl.purchase_price
         FROM product_supplier_links psl
         JOIN suppliers s ON s.id=psl.supplier_id
         LEFT JOIN supplier_partner_map spm ON spm.supplier_id=s.id
         LEFT JOIN customers c ON c.id=spm.partner_id
         WHERE psl.is_active=1 AND COALESCE(s.billing_calendar_type,'SOLAR')='SOLAR'
           AND COALESCE(c.billing_calendar_type,'SOLAR')='SOLAR'
         LIMIT 1`
      );
      if (link) {
        const [[map]] = await pool.query(`SELECT partner_id FROM supplier_partner_map WHERE supplier_id=?`, [link.supplier_id]);
        const po = await InventoryPurchaseAgent.create(
          { partner_id: map ? map.partner_id : null, supplier_id: link.supplier_id, purchase_date: EFFECTIVE_DATE },
          null
        );
        testPoId = po.id;
        const wrongPrice = 1;
        const addResult = await InventoryPurchaseAgent.addItem(testPoId, {
          product_id: link.product_id, quantity: 2, purchase_price: wrongPrice,
        }, null);
        const saved = await InventoryPurchaseAgent.get(testPoId);
        const savedItem = saved.items.find(i => i.id === addResult.id);
        check(
          `Purchase price re-resolved server-side (client sent ${wrongPrice}, catalog has ${link.purchase_price})`,
          savedItem && Number(savedItem.purchase_price) === Number(link.purchase_price),
          JSON.stringify(savedItem)
        );
      } else {
        console.log('  [SKIP] No product_supplier_links row available for re-resolution scenario');
      }
    } finally {
      if (testPoId) {
        await pool.query(`DELETE FROM purchase_order_items WHERE purchase_order_id=?`, [testPoId]);
        await pool.query(`DELETE FROM purchase_orders WHERE id=?`, [testPoId]);
      }
    }

  } finally {
    // ── Cleanup: remove only what this script created ──
    for (const bookId of createdBookIds) {
      await pool.query(`DELETE FROM customer_price_book_items WHERE price_book_id=?`, [bookId]);
      await pool.query(`DELETE FROM customer_price_books WHERE id=?`, [bookId]);
    }
    for (const catId of createdCategoryIds) {
      await pool.query(`DELETE FROM customer_price_categories WHERE id=?`, [catId]);
    }
    if (testCustomerId) {
      await pool.query(`DELETE FROM price_change_logs WHERE customer_id=?`, [testCustomerId]);
      await pool.query(`DELETE FROM customer_product_catalogs WHERE customer_id=?`, [testCustomerId]);
      await pool.query(`DELETE FROM customers WHERE id=?`, [testCustomerId]);
    }
    console.log(`Cleanup done (test customer + ${createdBookIds.length} test price book(s) removed).`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
