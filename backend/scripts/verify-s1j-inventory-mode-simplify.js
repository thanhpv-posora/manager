'use strict';
// S1J — Simplify products.inventory_mode: verification.
//
// Retires CARCASS_PART as a current Product inventory classification. Final
// current values: NON_STOCK, TRACK_STOCK. Covers the ticket's Required Tests
// not already exercised by other regression scripts:
//
//   A. Product validation (create/update/reject CARCASS_PART)
//   E. Historical compatibility — using REAL pre-existing order_items rows
//      (read-only; this script NEVER mutates real historical order/order_items
//      data, only throwaway products it creates itself)
//
// Required Tests B (data migration), C (POS regression), D (inventory
// regression), and F (S1H/S1I suites) are covered by:
//   - V6_65_S1J_INVENTORY_MODE_SIMPLIFY.sql (run + re-run, see S1J final report)
//   - verify-product-sales-flow-separation.js (39/39 — catalog + mixed-flow +
//     inventory OUT/no-OUT coverage, updated for S1J)
//   - verify-inventory-policy-extraction.js / verify-inventory-reconciliation.js
//     (updated for S1J)
//   - verify-s1h-product-domain-guard.js (16/16, updated for S1J)

const pool = require('../src/config/db');
const ProductAgent = require('../src/agents/ProductAgent');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}
async function expectReject(fn, name, codeCheck) {
  try { await fn(); check(name, false, 'expected rejection, but it succeeded'); }
  catch (e) {
    const okStatus = (e.status === 400 || e.statusCode === 400);
    const okCode = codeCheck ? codeCheck(e.code) : true;
    check(name, okStatus && okCode, { status: e.status || e.statusCode, code: e.code, message: e.message });
  }
}
const adminUser = () => ({ id: null, role: 'ADMIN' });

const cleanup = { productIds: [] };

async function main() {
  console.log('=== S1J Simplify inventory_mode verification ===\n');
  try {

    // ══════════════════ A. Product validation ══════════════════
    {
      const tagNonStock = `S1J-A-NONSTOCK-${Date.now()}`;
      await ProductAgent.addProduct({ name: tagNonStock, unit: 'kg', sales_flow: 'CARCASS_POS', inventory_mode: 'NON_STOCK' });
      const [[nonStockRow]] = await pool.query(`SELECT * FROM products WHERE name=?`, [tagNonStock]);
      cleanup.productIds.push(nonStockRow.id);
      check('A1. Create NON_STOCK succeeds', nonStockRow.inventory_mode === 'NON_STOCK', nonStockRow);

      const tagTrackStock = `S1J-A-TRACKSTOCK-${Date.now()}`;
      await ProductAgent.addProduct({ name: tagTrackStock, unit: 'kg', sales_flow: 'INVENTORY_SALE', inventory_mode: 'TRACK_STOCK' });
      const [[trackStockRow]] = await pool.query(`SELECT * FROM products WHERE name=?`, [tagTrackStock]);
      cleanup.productIds.push(trackStockRow.id);
      check('A2. Create TRACK_STOCK succeeds', trackStockRow.inventory_mode === 'TRACK_STOCK', trackStockRow);

      await expectReject(
        () => ProductAgent.addProduct({ name: `S1J-A-REJECT-${Date.now()}`, unit: 'kg', sales_flow: 'CARCASS_POS', inventory_mode: 'CARCASS_PART' }),
        'A3. Create CARCASS_PART fails',
        c => c === 'PRODUCT_INVENTORY_MODE_REQUIRED'
      );

      await expectReject(
        () => ProductAgent.updateProduct(nonStockRow.id, { name: nonStockRow.name, unit: 'kg', sales_flow: 'CARCASS_POS', inventory_mode: 'CARCASS_PART' }),
        'A4. Update to CARCASS_PART fails',
        c => c === 'PRODUCT_INVENTORY_MODE_REQUIRED'
      );

      // A5. "Import" fails clearly for CARCASS_PART: the quick-add path (used by
      // POS Quick Add / Excel-import-missing-product flows) shares the exact
      // same assertSalesFlowInventoryModeCombo() gate as addProduct/updateProduct
      // — no separate, weaker validation contract exists for bulk/quick creation.
      await expectReject(
        () => ProductAgent.quickProduct({ name: `S1J-A-QUICKREJECT-${Date.now()}`, unit: 'kg', sale_price: 1000, sales_flow: 'CARCASS_POS', inventory_mode: 'CARCASS_PART' }),
        'A5. Quick/import-style create with CARCASS_PART fails clearly',
        c => c === 'PRODUCT_SALES_FLOW_INVENTORY_MODE_MISMATCH' || c === 'PRODUCT_INVENTORY_MODE_REQUIRED'
      );

      // A6. Raw DB insert of CARCASS_PART is rejected by the tightened ENUM itself
      // (defense in depth below the application layer).
      let dbThrew = null;
      try {
        await pool.query(
          `INSERT INTO products(product_code,name,unit,inventory_mode,is_active,del_flg) VALUES(?,?,?,?,1,0)`,
          [`S1J-DB-${Date.now()}`, `S1J DB-level reject test`, 'kg', 'CARCASS_PART']
        );
      } catch (e) { dbThrew = e; }
      check('A6. Raw SQL insert of CARCASS_PART rejected by tightened ENUM', !!dbThrew, dbThrew && dbThrew.message);
    }

    // ══════════════════ E. Historical compatibility (read-only, REAL data) ══════════════════
    {
      const [legacyRows] = await pool.query(
        `SELECT oi.id, oi.order_id, oi.product_id, oi.inventory_mode, oi.stock_checked, o.order_code, o.status
         FROM order_items oi JOIN orders o ON o.id=oi.order_id
         WHERE oi.inventory_mode='CARCASS_PART' LIMIT 1`
      );
      if (!legacyRows.length) {
        check('E0. Real historical CARCASS_PART order_items exist to verify against', false, 'none found — cannot verify E1-E3 (see note in final report)');
      } else {
        const legacy = legacyRows[0];

        // E1. Old order_item with CARCASS_PART remains readable (never mutated by this script).
        const [[stillThere]] = await pool.query(`SELECT inventory_mode FROM order_items WHERE id=?`, [legacy.id]);
        check('E1. Historical order_item still readable with CARCASS_PART snapshot intact', stillThere && stillThere.inventory_mode === 'CARCASS_PART', stillThere);

        // E2. Its bill can be viewed (read-only OrderAgent.get(), no crash, no mutation).
        const OrderAgent = require('../src/agents/OrderAgent');
        let viewError = null;
        let viewedOrder = null;
        try { viewedOrder = await OrderAgent.get(legacy.order_id, adminUser()); }
        catch (e) { viewError = e; }
        check('E2. Bill containing the legacy CARCASS_PART line can be viewed without error', !viewError && !!viewedOrder, viewError && viewError.message);
        check('E2b. Viewed bill still shows the CARCASS_PART line item', !!(viewedOrder && viewedOrder.items || []).find(it => Number(it.id) === Number(legacy.id)), viewedOrder && viewedOrder.items);

        // E3. Reversal treats it as NON_STOCK semantics — proven via the frozen
        // stock_checked flag InventoryService's reversal path reads (never
        // today's product.inventory_mode — see InventoryService.js comments).
        // stock_checked=0 means postOut() never touched the balance for this
        // line at write time, so cancel/reversal correctly skips restoring
        // stock for it, identical to a NON_STOCK line. Read-only: does NOT
        // actually cancel this real order.
        check('E3. Historical CARCASS_PART line has stock_checked=0 (reversal skips it, same as NON_STOCK)', Number(legacy.stock_checked) === 0, legacy);

        // E4. The product that originally carried this snapshot has itself
        // already been migrated to NON_STOCK (current classification) — the
        // snapshot is frozen at the time of sale and does NOT change retroactively.
        const [[currentProduct]] = await pool.query(`SELECT inventory_mode FROM products WHERE id=?`, [legacy.product_id]);
        check('E4. The product\'s CURRENT inventory_mode is NON_STOCK post-migration (snapshot unaffected)', currentProduct && currentProduct.inventory_mode === 'NON_STOCK', currentProduct);
      }

      // E5. No new order_item can ever be written as CARCASS_PART — proven
      // structurally: OrderAgent.create()/addItem() freeze inventory_mode from
      // InventoryService.out()'s return value, which is InventoryPolicyResolver's
      // normalized mode (only ever NON_STOCK or TRACK_STOCK after S1J). Confirmed
      // by inspecting the live order_items column: it cannot be constrained at
      // the DB level (deliberately immutable historical snapshots per ORDER_ITEMS
      // POLICY — the ticket forbids rewriting old rows), but the application
      // write path structurally cannot produce it going forward.
      const InventoryPolicyResolver = require('../src/services/InventoryPolicyResolver');
      const p1 = InventoryPolicyResolver.resolve({ inventory_mode: 'CARCASS_PART', allow_negative_stock: 0 });
      check('E5. InventoryPolicyResolver normalizes a raw CARCASS_PART row to mode=NON_STOCK', p1.mode === 'NON_STOCK', p1);
    }

  } finally {
    for (const id of cleanup.productIds) {
      await pool.query(`DELETE FROM products WHERE id=?`, [id]).catch(() => {});
    }
    console.log('Cleanup done (throwaway products only — no historical order/order_items data touched).');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
