'use strict';
// Verifies S6.6's standalone Inventory Adjustment (InventoryAdjustmentAgent),
// independent of Order Edit. Covers: Increase, Decrease, all 6 reasons accepted,
// remark stored, adjustment_code generated, ledger type/reference correctness,
// history, reconciliation returning OK after adjustment, Bò Xô (CARCASS_PART/
// NON_STOCK) correctly rejected, insufficient-stock rejection on Decrease, and
// allow_negative_stock bypassing that rejection.
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
  await ProductAgent.addProduct({ name: `S6.6 ADJ ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, unit: 'kg', inventory_mode: mode, stock_quantity: qty, allow_negative_stock: allowNeg ? 1 : 0 });
  const [[created]] = await pool.query(`SELECT * FROM products WHERE name LIKE 'S6.6 ADJ %' ORDER BY id DESC LIMIT 1`);
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
    // ── Case 1: Increase — TRACK_STOCK, reason=FOUND, with remark ──
    {
      const p = await makeProduct('TRACK_STOCK', 20);
      productIds.push(p.id);
      const r = await InventoryAdjustmentAgent.create({ product_id: p.id, direction: 'INCREASE', quantity: 5, reason: 'FOUND', remark: 'Tìm thấy trong kho lạnh' }, user);
      adjustmentIds.push(r.adjustment_id);
      check('Case 1: adjustment_code generated (ADJ prefix)', /^ADJ/.test(r.adjustment_code), r.adjustment_code);
      check('Case 1: balance_after = 25', r.balance_after === 25, r.balance_after);
      const after = await getProduct(p.id);
      check('Case 1: products.stock_quantity actually updated to 25', Number(after.stock_quantity) === 25, after.stock_quantity);

      const [[header]] = await pool.query(`SELECT * FROM inventory_adjustments WHERE id=?`, [r.adjustment_id]);
      check('Case 1: header row stored direction/reason/remark correctly', header.direction === 'INCREASE' && header.reason === 'FOUND' && header.remark === 'Tìm thấy trong kho lạnh', JSON.stringify(header));

      const [[tx]] = await pool.query(`SELECT type, reference_type, reference_id, affect_stock FROM stock_transactions WHERE product_id=? ORDER BY id DESC LIMIT 1`, [p.id]);
      check('Case 1: ledger type=ADJUSTMENT_INCREASE', tx.type === 'ADJUSTMENT_INCREASE', tx.type);
      check('Case 1: ledger reference_type=ADJUSTMENT, reference_id=header.id', tx.reference_type === 'ADJUSTMENT' && Number(tx.reference_id) === r.adjustment_id, JSON.stringify(tx));
      check('Case 1: affect_stock=1', Number(tx.affect_stock) === 1, tx.affect_stock);
    }

    // ── Case 2: Decrease — TRACK_STOCK, reason=BROKEN ──
    {
      const p = await makeProduct('TRACK_STOCK', 20);
      productIds.push(p.id);
      const r = await InventoryAdjustmentAgent.create({ product_id: p.id, direction: 'DECREASE', quantity: 8, reason: 'BROKEN', remark: 'Vỡ khi vận chuyển' }, user);
      adjustmentIds.push(r.adjustment_id);
      check('Case 2: balance_after = 12', r.balance_after === 12, r.balance_after);
      const [[tx]] = await pool.query(`SELECT type, affect_stock FROM stock_transactions WHERE product_id=? ORDER BY id DESC LIMIT 1`, [p.id]);
      check('Case 2: ledger type=ADJUSTMENT_DECREASE', tx.type === 'ADJUSTMENT_DECREASE', tx.type);
      check('Case 2: affect_stock=1', Number(tx.affect_stock) === 1, tx.affect_stock);
    }

    // ── Case 3: all 6 reasons accepted ──
    {
      const reasons = ['BROKEN', 'LOST', 'EXPIRED', 'FOUND', 'STOCK_COUNT', 'OTHER'];
      for (const reason of reasons) {
        const p = await makeProduct('TRACK_STOCK', 50);
        productIds.push(p.id);
        const r = await InventoryAdjustmentAgent.create({ product_id: p.id, direction: 'INCREASE', quantity: 1, reason }, user);
        adjustmentIds.push(r.adjustment_id);
        check(`Case 3: reason=${reason} accepted`, r.reason === reason, r.reason);
      }
    }

    // ── Case 4: invalid reason rejected ──
    {
      const p = await makeProduct('TRACK_STOCK', 20);
      productIds.push(p.id);
      let threw = null;
      try { await InventoryAdjustmentAgent.create({ product_id: p.id, direction: 'INCREASE', quantity: 1, reason: 'MADE_UP_REASON' }, user); }
      catch (e) { threw = e; }
      check('Case 4: invalid reason rejected', !!threw, threw && threw.message);
    }

    // ── Case 5: reconciliation reports OK after an adjustment ──
    {
      const p = await makeProduct('TRACK_STOCK', 20);
      productIds.push(p.id);
      const r = await InventoryAdjustmentAgent.create({ product_id: p.id, direction: 'DECREASE', quantity: 3, reason: 'STOCK_COUNT', remark: 'Kiểm kê định kỳ' }, user);
      adjustmentIds.push(r.adjustment_id);
      const recon = await StockLedgerAgent.reconciliation({ product_id: p.id });
      check('Case 5: reconciliation status=OK after standalone adjustment', recon.items[0] && recon.items[0].status === 'OK', JSON.stringify(recon.items[0]));
      check('Case 5: reconciliation ledger_qty matches cache_qty (17)', recon.items[0].cache_qty === 17 && recon.items[0].ledger_qty === 17, JSON.stringify(recon.items[0]));
    }

    // ── Case 6: history — list() returns the created adjustment with joined product name ──
    {
      const p = await makeProduct('TRACK_STOCK', 20);
      productIds.push(p.id);
      const r = await InventoryAdjustmentAgent.create({ product_id: p.id, direction: 'INCREASE', quantity: 2, reason: 'OTHER', remark: 'test history' }, user);
      adjustmentIds.push(r.adjustment_id);
      const list = await InventoryAdjustmentAgent.list({ product_id: p.id });
      const found = list.find(x => x.id === r.adjustment_id);
      check('Case 6: history includes the new adjustment with product_name joined', !!found && found.product_name === p.name, JSON.stringify(found));
      check('Case 6: history includes adjustment_code/reason/remark', found && found.adjustment_code === r.adjustment_code && found.reason === 'OTHER' && found.remark === 'test history', JSON.stringify(found));

      const ledgerView = await StockLedgerAgent.list({ product_id: p.id, reference_type: 'ADJUSTMENT', limit: 10 });
      check('Case 6: generic Stock Ledger view also surfaces it via reference_type=ADJUSTMENT filter', ledgerView.items.some(x => Number(x.reference_id) === r.adjustment_id), JSON.stringify(ledgerView.items.map(x => x.reference_id)));
    }

    // ── Case 7: CARCASS_PART (Bò Xô) rejected — never adjustable via this feature ──
    {
      const p = await makeProduct('CARCASS_PART', 0);
      productIds.push(p.id);
      let threw = null;
      try { await InventoryAdjustmentAgent.create({ product_id: p.id, direction: 'INCREASE', quantity: 5, reason: 'FOUND' }, user); }
      catch (e) { threw = e; }
      check('Case 7: CARCASS_PART rejected (Bò Xô untouched by this feature)', !!threw, threw && threw.message);
      const after = await getProduct(p.id);
      check('Case 7: balance unchanged (still 0)', Number(after.stock_quantity) === 0, after.stock_quantity);
    }

    // ── Case 8: NON_STOCK rejected ──
    {
      const p = await makeProduct('NON_STOCK', 0);
      productIds.push(p.id);
      let threw = null;
      try { await InventoryAdjustmentAgent.create({ product_id: p.id, direction: 'INCREASE', quantity: 5, reason: 'FOUND' }, user); }
      catch (e) { threw = e; }
      check('Case 8: NON_STOCK rejected', !!threw, threw && threw.message);
    }

    // ── Case 9: Decrease below zero rejected (no allow_negative_stock) ──
    {
      const p = await makeProduct('TRACK_STOCK', 5, false);
      productIds.push(p.id);
      let threw = null;
      try { await InventoryAdjustmentAgent.create({ product_id: p.id, direction: 'DECREASE', quantity: 999, reason: 'LOST' }, user); }
      catch (e) { threw = e; }
      check('Case 9: decrease below zero rejected', !!threw, threw && threw.message);
      const after = await getProduct(p.id);
      check('Case 9: balance unchanged (still 5)', Number(after.stock_quantity) === 5, after.stock_quantity);
    }

    // ── Case 10: Decrease below zero ALLOWED when allow_negative_stock=1 ──
    {
      const p = await makeProduct('TRACK_STOCK', 5, true);
      productIds.push(p.id);
      const r = await InventoryAdjustmentAgent.create({ product_id: p.id, direction: 'DECREASE', quantity: 999, reason: 'LOST' }, user);
      adjustmentIds.push(r.adjustment_id);
      check('Case 10: allow_negative_stock permits a large decrease (5→-994)', r.balance_after === 5 - 999, r.balance_after);
    }

    // ── Case 11: missing/invalid fields rejected cleanly ──
    {
      let threw1 = null;
      try { await InventoryAdjustmentAgent.create({ direction: 'INCREASE', quantity: 1, reason: 'FOUND' }, user); } catch (e) { threw1 = e; }
      check('Case 11: missing product_id rejected', !!threw1);

      const p = await makeProduct('TRACK_STOCK', 20);
      productIds.push(p.id);
      let threw2 = null;
      try { await InventoryAdjustmentAgent.create({ product_id: p.id, direction: 'SIDEWAYS', quantity: 1, reason: 'FOUND' }, user); } catch (e) { threw2 = e; }
      check('Case 11: invalid direction rejected', !!threw2);

      let threw3 = null;
      try { await InventoryAdjustmentAgent.create({ product_id: p.id, direction: 'INCREASE', quantity: 0, reason: 'FOUND' }, user); } catch (e) { threw3 = e; }
      check('Case 11: zero/negative quantity rejected', !!threw3);
    }

  } finally {
    for (const id of adjustmentIds) {
      await pool.query(`DELETE FROM inventory_adjustments WHERE id=?`, [id]);
    }
    for (const id of productIds) {
      await pool.query(`DELETE FROM stock_transactions WHERE product_id=?`, [id]);
      await pool.query(`DELETE FROM products WHERE id=?`, [id]);
    }
    console.log('Cleanup done.');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
