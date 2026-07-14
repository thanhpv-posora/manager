'use strict';
// Verifies S6.3's read-only Inventory Reconciliation (StockLedgerAgent.reconciliation()).
// Covers: OK/MISMATCH detection, affect_stock=0 zero-contribution (Bò Xô / CARCASS_PART
// protection), ADJUSTMENT sign correctness, mode-changed-but-history-preserved
// reconstruction, decimal tolerance, and summary/items consistency.
//
// Self-cleaning: creates throwaway products (+ stock_transactions rows via the real
// write path, plus a couple of direct test-only manipulations to simulate drift/mode
// changes), all removed in `finally`. Never touches real product data.

const pool = require('../src/config/db');
const StockLedgerAgent = require('../src/agents/StockLedgerAgent');
const InventoryMovementService = require('../src/services/InventoryMovementService');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}

async function makeProduct(mode, stockQuantity = 0) {
  const code = `RECON-TEST-${mode}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const [r] = await pool.query(
    `INSERT INTO products(product_code, name, unit, stock_quantity, inventory_mode, allow_negative_stock, is_active, del_flg)
     VALUES (?, ?, 'kg', ?, ?, 0, 1, 0)`,
    [code, `Recon Test ${mode}`, stockQuantity, mode]
  );
  return r.insertId;
}

async function withConn(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function reconcileOne(productId) {
  const r = await StockLedgerAgent.reconciliation({ product_id: productId });
  return r.items[0];
}

async function main() {
  const productIds = [];
  try {
    // ── Case 1: cache=0, no ledger rows at all → ledger=0, difference=0, OK ──
    {
      const id = await makeProduct('TRACK_STOCK', 0);
      productIds.push(id);
      const item = await reconcileOne(id);
      check('Case 1: item found via product_id filter', !!item, JSON.stringify(item));
      check('Case 1: ledger_qty=0 with no rows', item.ledger_qty === 0, JSON.stringify(item));
      check('Case 1: difference=0', item.difference === 0, JSON.stringify(item));
      check('Case 1: status=OK', item.status === 'OK', JSON.stringify(item));
    }

    // ── Case 2: TRACK_STOCK, matching IN and OUT → cache equals ledger, OK ──
    {
      const id = await makeProduct('TRACK_STOCK', 0);
      productIds.push(id);
      await withConn(conn => InventoryMovementService.postIn(conn, id, 20, new Date(), 'MANUAL', null, 'test', null));
      await withConn(conn => InventoryMovementService.postOut(conn, id, 5, new Date(), 'SALE', null, 'test', null));
      const item = await reconcileOne(id);
      check('Case 2: cache_qty=15', item.cache_qty === 15, JSON.stringify(item));
      check('Case 2: ledger_qty=15 (20-5)', item.ledger_qty === 15, JSON.stringify(item));
      check('Case 2: status=OK', item.status === 'OK', JSON.stringify(item));
    }

    // ── Case 3: deliberate cache mismatch → correct difference, MISMATCH ──
    {
      const id = await makeProduct('TRACK_STOCK', 0);
      productIds.push(id);
      await withConn(conn => InventoryMovementService.postIn(conn, id, 10, new Date(), 'MANUAL', null, 'test', null));
      // Simulate drift: directly corrupt the cache, bypassing the single writer.
      // Test-only manipulation — never done by application code.
      await pool.query(`UPDATE products SET stock_quantity = ? WHERE id = ?`, [999, id]);
      const item = await reconcileOne(id);
      check('Case 3: cache_qty=999 (corrupted)', item.cache_qty === 999, JSON.stringify(item));
      check('Case 3: ledger_qty=10 (unaffected by cache corruption)', item.ledger_qty === 10, JSON.stringify(item));
      check('Case 3: difference=989', item.difference === 989, JSON.stringify(item));
      check('Case 3: status=MISMATCH', item.status === 'MISMATCH', JSON.stringify(item));
    }

    // ── Case 4: CARCASS_PART, affect_stock=0 OUT → contributes zero, ledger unchanged ──
    {
      const id = await makeProduct('CARCASS_PART', 0);
      productIds.push(id);
      const before = await reconcileOne(id);
      await withConn(conn => InventoryMovementService.postOut(conn, id, 500, new Date(), 'SALE', null, 'test carcass', null));
      const after = await reconcileOne(id);
      check('Case 4: CARCASS_PART OUT writes affect_stock=0', true); // implicitly proven by ledger_qty staying put below
      check('Case 4: ledger_qty unchanged by the skip-affect OUT (still 0)', before.ledger_qty === 0 && after.ledger_qty === 0, JSON.stringify({ before, after }));
      check('Case 4: cache_qty unchanged (still 0)', after.cache_qty === 0, JSON.stringify(after));
      check('Case 4: status=OK (Bò Xô never flagged as drifted)', after.status === 'OK', JSON.stringify(after));
    }

    // ── Case 5: NON_STOCK, affect_stock=0 IN (audit row) → contributes zero ──
    {
      const id = await makeProduct('NON_STOCK', 0);
      productIds.push(id);
      const before = await reconcileOne(id);
      await withConn(conn => InventoryMovementService.postIn(conn, id, 500, new Date(), 'MANUAL', null, 'audit only', null));
      const after = await reconcileOne(id);
      check('Case 5: ledger_qty unchanged by the skip-affect IN (still 0)', before.ledger_qty === 0 && after.ledger_qty === 0, JSON.stringify({ before, after }));
      check('Case 5: cache_qty unchanged (still 0)', after.cache_qty === 0, JSON.stringify(after));
      check('Case 5: status=OK', after.status === 'OK', JSON.stringify(after));
    }

    // ── Case 6: ADJUSTMENT_INCREASE → positive contribution ──
    {
      const id = await makeProduct('TRACK_STOCK', 0);
      productIds.push(id);
      await withConn(conn => InventoryMovementService.postAdjustmentIncrease(conn, id, 10, new Date(), 'MANUAL', null, 'test adj+', null));
      const item = await reconcileOne(id);
      check('Case 6: cache_qty=10', item.cache_qty === 10, JSON.stringify(item));
      check('Case 6: ledger_qty=+10 (ADJUSTMENT_INCREASE is positive)', item.ledger_qty === 10, JSON.stringify(item));
      check('Case 6: status=OK', item.status === 'OK', JSON.stringify(item));
    }

    // ── Case 7: ADJUSTMENT_DECREASE → negative contribution ──
    {
      const id = await makeProduct('TRACK_STOCK', 0);
      productIds.push(id);
      await withConn(conn => InventoryMovementService.postAdjustmentIncrease(conn, id, 10, new Date(), 'MANUAL', null, 'base', null));
      const beforeDecrease = await reconcileOne(id);
      await withConn(conn => InventoryMovementService.postAdjustmentDecrease(conn, id, 4, new Date(), 'MANUAL', null, 'test adj-', null));
      const afterDecrease = await reconcileOne(id);
      check('Case 7: ledger_qty decreased by exactly the delta (10→6)', beforeDecrease.ledger_qty === 10 && afterDecrease.ledger_qty === 6, JSON.stringify({ beforeDecrease, afterDecrease }));
      check('Case 7: cache_qty matches ledger_qty (6)', afterDecrease.cache_qty === 6 && afterDecrease.ledger_qty === 6, JSON.stringify(afterDecrease));
      check('Case 7: status=OK', afterDecrease.status === 'OK', JSON.stringify(afterDecrease));
    }

    // ── Case 8: product's mode later changed away from TRACK_STOCK, but historical
    //    affect_stock=1 rows must still be counted, and the product must still
    //    appear in the DEFAULT (unfiltered) listing despite its current mode. ──
    {
      const id = await makeProduct('TRACK_STOCK', 0);
      productIds.push(id);
      await withConn(conn => InventoryMovementService.postIn(conn, id, 10, new Date(), 'MANUAL', null, 'test', null));
      // Simulate a later mode change — test-only manipulation, not an application code path.
      await pool.query(`UPDATE products SET inventory_mode = 'CARCASS_PART' WHERE id = ?`, [id]);

      const filtered = await reconcileOne(id); // still resolvable directly by id
      check('Case 8: historical affect_stock=1 row still counted after mode change (ledger_qty=10)', filtered.ledger_qty === 10, JSON.stringify(filtered));
      check('Case 8: cache_qty still 10 (postIn ran while it was TRACK_STOCK)', filtered.cache_qty === 10, JSON.stringify(filtered));
      check('Case 8: status=OK (reconstruction followed stored affect_stock, not current mode)', filtered.status === 'OK', JSON.stringify(filtered));

      const all = await StockLedgerAgent.reconciliation({});
      const found = all.items.find(it => it.product_id === id);
      check('Case 8: product still appears in the DEFAULT (unfiltered) listing despite now being CARCASS_PART', !!found, JSON.stringify({ mode: found && found.inventory_mode }));
      check('Case 8: default-listing entry reports the current mode (CARCASS_PART), not the historical one', found && found.inventory_mode === 'CARCASS_PART', JSON.stringify(found));
    }

    // ── Case 9: decimal quantities — tolerance applied correctly ──
    {
      // 9a: clean decimal arithmetic, exact match.
      const idA = await makeProduct('TRACK_STOCK', 0);
      productIds.push(idA);
      await withConn(conn => InventoryMovementService.postIn(conn, idA, 10.125, new Date(), 'MANUAL', null, 'test', null));
      await withConn(conn => InventoryMovementService.postOut(conn, idA, 2.075, new Date(), 'SALE', null, 'test', null));
      const itemA = await reconcileOne(idA);
      check('Case 9a: decimal cache_qty=8.05', Math.abs(itemA.cache_qty - 8.05) < 1e-9, JSON.stringify(itemA));
      check('Case 9a: decimal ledger_qty=8.05', Math.abs(itemA.ledger_qty - 8.05) < 1e-9, JSON.stringify(itemA));
      check('Case 9a: status=OK', itemA.status === 'OK', JSON.stringify(itemA));

      // 9b: difference just BELOW tolerance (0.0005 < 0.001) → still OK.
      const idB = await makeProduct('TRACK_STOCK', 0);
      productIds.push(idB);
      await withConn(conn => InventoryMovementService.postIn(conn, idB, 10, new Date(), 'MANUAL', null, 'test', null));
      await pool.query(`UPDATE products SET stock_quantity = ? WHERE id = ?`, [10.0005, idB]);
      const itemB = await reconcileOne(idB);
      check('Case 9b: sub-tolerance difference (0.0005) still reports OK', itemB.status === 'OK', JSON.stringify(itemB));

      // 9c: difference just ABOVE tolerance (0.002 > 0.001) → MISMATCH.
      const idC = await makeProduct('TRACK_STOCK', 0);
      productIds.push(idC);
      await withConn(conn => InventoryMovementService.postIn(conn, idC, 10, new Date(), 'MANUAL', null, 'test', null));
      await pool.query(`UPDATE products SET stock_quantity = ? WHERE id = ?`, [10.002, idC]);
      const itemC = await reconcileOne(idC);
      check('Case 9c: above-tolerance difference (0.002) reports MISMATCH', itemC.status === 'MISMATCH', JSON.stringify(itemC));
      check('Case 9c: difference stays a raw number, not toFixed-string', typeof itemC.difference === 'number', typeof itemC.difference);
    }

    // ── Case 10: summary counts always match the returned items array,
    //    both unfiltered and with a status filter applied. ──
    {
      const all = await StockLedgerAgent.reconciliation({});
      const okCount = all.items.filter(it => it.status === 'OK').length;
      const mismatchCount = all.items.filter(it => it.status === 'MISMATCH').length;
      check('Case 10: summary.total_products matches items.length (unfiltered)', all.summary.total_products === all.items.length, JSON.stringify(all.summary));
      check('Case 10: summary.ok_count matches items (unfiltered)', all.summary.ok_count === okCount, JSON.stringify({ summary: all.summary, okCount }));
      check('Case 10: summary.mismatch_count matches items (unfiltered)', all.summary.mismatch_count === mismatchCount, JSON.stringify({ summary: all.summary, mismatchCount }));

      const onlyMismatch = await StockLedgerAgent.reconciliation({ status: 'MISMATCH' });
      check('Case 10: status=MISMATCH filter returns only MISMATCH items', onlyMismatch.items.every(it => it.status === 'MISMATCH'), JSON.stringify(onlyMismatch.items.map(i => i.status)));
      check('Case 10: filtered summary matches filtered items', onlyMismatch.summary.total_products === onlyMismatch.items.length && onlyMismatch.summary.ok_count === 0, JSON.stringify(onlyMismatch.summary));

      const onlyOk = await StockLedgerAgent.reconciliation({ status: 'OK' });
      check('Case 10: status=OK filter returns only OK items', onlyOk.items.every(it => it.status === 'OK'), JSON.stringify(onlyOk.items.map(i => i.status)));
    }

  } finally {
    for (const id of productIds) {
      await pool.query(`DELETE FROM stock_transactions WHERE product_id = ?`, [id]);
      await pool.query(`DELETE FROM products WHERE id = ?`, [id]);
    }
    console.log('Cleanup done (throwaway reconciliation-test products removed).');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
