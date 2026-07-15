'use strict';
// Verifies S7.2's bulk Inventory Adjustment (InventoryAdjustmentAgent.createBatch),
// the Excel-style "stock count" save. Covers: one transaction producing multiple
// ledger rows (each in the EXISTING inventory_adjustments table, no new document
// model), zero-difference rows never touching the ledger, atomicity (one bad row
// rolls back the WHOLE request), TRACK_STOCK-only enforcement, and that the
// original single-item create() (S6.6, unchanged) still works identically.
//
// Self-cleaning: throwaway products + adjustments, removed in `finally`.

const pool = require('../src/config/db');
const ProductAgent = require('../src/agents/ProductAgent');
const InventoryAdjustmentAgent = require('../src/agents/InventoryAdjustmentAgent');
const StockLedgerAgent = require('../src/agents/StockLedgerAgent');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}

async function makeProduct(mode, qty, allowNeg = false) {
  await ProductAgent.addProduct({ name: `S7.2 BATCH ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, unit: 'kg', inventory_mode: mode, stock_quantity: qty, allow_negative_stock: allowNeg ? 1 : 0 });
  const [[created]] = await pool.query(`SELECT * FROM products WHERE name LIKE 'S7.2 BATCH %' ORDER BY id DESC LIMIT 1`);
  return created;
}
async function getProduct(id) {
  const [[row]] = await pool.query(`SELECT * FROM products WHERE id=?`, [id]);
  return row;
}

const user = { id: null };

async function main() {
  const productIds = [];
  const adjustmentIds = [];

  try {
    // ── Case 1: mixed save — one increase, one decrease, one no-change ──
    {
      const pInc = await makeProduct('TRACK_STOCK', 20); productIds.push(pInc.id);
      const pDec = await makeProduct('TRACK_STOCK', 20); productIds.push(pDec.id);
      const pSame = await makeProduct('TRACK_STOCK', 20); productIds.push(pSame.id);

      const r = await InventoryAdjustmentAgent.createBatch({
        items: [
          { product_id: pInc.id, actual_quantity: 25, reason: 'FOUND', remark: 'found extra' },
          { product_id: pDec.id, actual_quantity: 12, reason: 'BROKEN', remark: 'broken units' },
          { product_id: pSame.id, actual_quantity: 20, reason: 'STOCK_COUNT' }, // no real difference
        ],
      }, user);
      adjustmentIds.push(...r.items.map(x => x.adjustment_id));

      check('Case 1: items_adjusted = 2 (increase + decrease only)', r.items_adjusted === 2, r.items_adjusted);
      check('Case 1: items_skipped_no_change = 1', r.items_skipped_no_change === 1, r.items_skipped_no_change);
      check('Case 1: response has no batch_id/batch_code fields (no document model)', r.batch_id === undefined && r.batch_code === undefined, JSON.stringify(r));

      const afterInc = await getProduct(pInc.id);
      const afterDec = await getProduct(pDec.id);
      const afterSame = await getProduct(pSame.id);
      check('Case 1: increase applied (20→25)', Number(afterInc.stock_quantity) === 25, afterInc.stock_quantity);
      check('Case 1: decrease applied (20→12)', Number(afterDec.stock_quantity) === 12, afterDec.stock_quantity);
      check('Case 1: unchanged row stayed at 20', Number(afterSame.stock_quantity) === 20, afterSame.stock_quantity);

      // Note: makeProduct(mode, 20) itself writes one opening-stock ledger row
      // (ProductAgent.addProduct -> InventoryService.in, type=IN/reference=MANUAL)
      // before the save even runs — so "no ledger row" must mean "no NEW
      // (ADJUSTMENT_*) row", not "zero rows total".
      const [[adjCountSame]] = await pool.query(`SELECT COUNT(*) c FROM stock_transactions WHERE product_id=? AND type IN ('ADJUSTMENT_INCREASE','ADJUSTMENT_DECREASE')`, [pSame.id]);
      check('Case 1: NO ADJUSTMENT ledger row for the zero-difference product', Number(adjCountSame.c) === 0, adjCountSame.c);

      const [[txInc]] = await pool.query(`SELECT type, reference_type, reference_id, affect_stock FROM stock_transactions WHERE product_id=? ORDER BY id DESC LIMIT 1`, [pInc.id]);
      check('Case 1: increase row is ADJUSTMENT_INCREASE, reference_type=ADJUSTMENT, affect_stock=1', txInc.type === 'ADJUSTMENT_INCREASE' && txInc.reference_type === 'ADJUSTMENT' && Number(txInc.affect_stock) === 1, JSON.stringify(txInc));

      const [[itemInc]] = await pool.query(`SELECT * FROM inventory_adjustments WHERE product_id=?`, [pInc.id]);
      check('Case 1: item row has no batch_id column at all (table unchanged from S6.6)', !('batch_id' in itemInc), JSON.stringify(Object.keys(itemInc)));
    }

    // ── Case 2: atomicity — one bad row rolls back the WHOLE request ──
    // (Note: "insufficient stock on decrease" can never occur via the actual-
    // quantity model — actual_quantity is validated >= 0, so the implied
    // decrease (current - actual_quantity) can never exceed current by
    // construction. An invalid product_id is used instead as a real, reachable
    // failure to prove the OTHER valid row in the same request never applies.)
    {
      const pGood = await makeProduct('TRACK_STOCK', 20); productIds.push(pGood.id);

      let threw = null;
      try {
        await InventoryAdjustmentAgent.createBatch({
          items: [
            { product_id: pGood.id, actual_quantity: 30, reason: 'FOUND' },
            { product_id: 999999999, actual_quantity: 10, reason: 'LOST' },
          ],
        }, user);
      } catch (e) { threw = e; }
      check('Case 2: request with one invalid row throws', !!threw, threw && threw.message);
      const afterGood = await getProduct(pGood.id);
      check('Case 2: the OTHER (valid) row in the same request was NOT applied — whole transaction rolled back', Number(afterGood.stock_quantity) === 20, afterGood.stock_quantity);
      const [[adjCountGood]] = await pool.query(`SELECT COUNT(*) c FROM stock_transactions WHERE product_id=? AND type='ADJUSTMENT_INCREASE'`, [pGood.id]);
      check('Case 2: no ADJUSTMENT_INCREASE ledger row leaked for the valid row either', Number(adjCountGood.c) === 0, adjCountGood.c);
    }

    // ── Case 3: TRACK_STOCK-only enforcement (defense in depth) ──
    {
      const pCarcass = await makeProduct('CARCASS_PART', 0); productIds.push(pCarcass.id);
      let threw = null;
      try {
        await InventoryAdjustmentAgent.createBatch({ items: [{ product_id: pCarcass.id, actual_quantity: 5, reason: 'FOUND' }] }, user);
      } catch (e) { threw = e; }
      check('Case 3: CARCASS_PART rejected even via the bulk save', !!threw, threw && threw.message);
    }

    // ── Case 4: reconciliation OK after a bulk save ──
    {
      const p = await makeProduct('TRACK_STOCK', 20); productIds.push(p.id);
      const r = await InventoryAdjustmentAgent.createBatch({ items: [{ product_id: p.id, actual_quantity: 17.5, reason: 'STOCK_COUNT' }] }, user);
      adjustmentIds.push(...r.items.map(x => x.adjustment_id));
      const recon = await StockLedgerAgent.reconciliation({ product_id: p.id });
      check('Case 4: reconciliation OK after bulk decrease', recon.items[0].status === 'OK' && recon.items[0].cache_qty === 17.5, JSON.stringify(recon.items[0]));
    }

    // ── Case 5: history reads each item independently (no grouping needed) ──
    {
      const p = await makeProduct('TRACK_STOCK', 10); productIds.push(p.id);
      const r = await InventoryAdjustmentAgent.createBatch({ items: [{ product_id: p.id, actual_quantity: 12, reason: 'FOUND' }] }, user);
      adjustmentIds.push(...r.items.map(x => x.adjustment_id));
      const list = await InventoryAdjustmentAgent.list({ product_id: p.id });
      const found = list.find(x => x.product_id === p.id);
      check('Case 5: history row exists with the correct adjustment_code, no batch_code field', !!found && found.adjustment_code === r.items[0].adjustment_code && !('batch_code' in found), JSON.stringify(found));
    }

    // ── Case 6: original single-item create() unchanged ──
    {
      const p = await makeProduct('TRACK_STOCK', 20); productIds.push(p.id);
      const r = await InventoryAdjustmentAgent.create({ product_id: p.id, direction: 'INCREASE', quantity: 5, reason: 'FOUND' }, user);
      adjustmentIds.push(r.adjustment_id);
      const [[row]] = await pool.query(`SELECT * FROM inventory_adjustments WHERE id=?`, [r.adjustment_id]);
      check('Case 6: single-item create() still works, row has no batch_id column', row && !('batch_id' in row), JSON.stringify(row && Object.keys(row)));
      check('Case 6: balance_after correct (20→25)', r.balance_after === 25, r.balance_after);
    }

    // ── Case 7: empty items array rejected ──
    {
      let threw = null;
      try { await InventoryAdjustmentAgent.createBatch({ items: [] }, user); } catch (e) { threw = e; }
      check('Case 7: empty request rejected', !!threw);
    }

    // ── Case 8: schema confirmation — no document tables exist ──
    {
      const [tbl] = await pool.query(`SHOW TABLES LIKE 'inventory_adjustment_batches'`);
      check('Case 8: inventory_adjustment_batches table does NOT exist', tbl.length === 0);
      const [cols] = await pool.query(`SHOW COLUMNS FROM inventory_adjustments LIKE 'batch_id'`);
      check('Case 8: inventory_adjustments has no batch_id column', cols.length === 0);
    }

  } finally {
    for (const id of adjustmentIds) await pool.query(`DELETE FROM inventory_adjustments WHERE id=?`, [id]).catch(() => {});
    for (const id of productIds) {
      await pool.query(`DELETE FROM stock_transactions WHERE product_id=?`, [id]).catch(() => {});
      await pool.query(`DELETE FROM inventory_adjustments WHERE product_id=?`, [id]).catch(() => {});
      await pool.query(`DELETE FROM products WHERE id=?`, [id]).catch(() => {});
    }
    console.log('Cleanup done.');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
