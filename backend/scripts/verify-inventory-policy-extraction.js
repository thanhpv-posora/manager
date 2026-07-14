'use strict';
// Verifies S6.1/S6.2's InventoryPolicyResolver extraction is a pure, zero-behavior-change
// refactor of the mode/allow_negative_stock branches that used to be inline in
// InventoryMovementService (postIn/postOut) and InventoryService
// (adjustOrderItem/applyOrderInventory).
//
// Exercises all 4 call paths directly (no HTTP), across all 4 policy combinations that
// existed before either extraction, asserting the exact same outcomes the original inline
// conditionals produced: NON_STOCK, CARCASS_PART, TRACK_STOCK, TRACK_STOCK +
// allow_negative_stock. Self-cleaning: creates throwaway products, removed in `finally`.

const pool = require('../src/config/db');
const InventoryMovementService = require('../src/services/InventoryMovementService');
const InventoryService = require('../src/services/InventoryService');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}

async function makeProduct(mode, allowNegative, initialStock = 10) {
  const code = `POLICY-TEST-${mode}-${allowNegative}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const [r] = await pool.query(
    `INSERT INTO products(product_code, name, unit, stock_quantity, inventory_mode, allow_negative_stock, is_active, del_flg)
     VALUES (?, ?, 'kg', ?, ?, ?, 1, 0)`,
    [code, `Policy Test ${mode} ${allowNegative}`, initialStock, mode, allowNegative ? 1 : 0]
  );
  return r.insertId;
}

async function getBalance(productId) {
  const [[row]] = await pool.query(`SELECT stock_quantity FROM products WHERE id = ?`, [productId]);
  return Number(row.stock_quantity);
}

async function getLastTxAffectStock(productId, type) {
  const [[row]] = await pool.query(
    `SELECT affect_stock FROM stock_transactions WHERE product_id = ? AND type = ? ORDER BY id DESC LIMIT 1`,
    [productId, type]
  );
  return row ? Number(row.affect_stock) : null;
}

async function getTxCount(productId) {
  const [[row]] = await pool.query(`SELECT COUNT(*) c FROM stock_transactions WHERE product_id = ?`, [productId]);
  return Number(row.c);
}

async function main() {
  const productIds = [];
  try {
    // ── Case 1: NON_STOCK — IN and OUT must both skip the balance ──
    {
      const id = await makeProduct('NON_STOCK', false, 10);
      productIds.push(id);
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const inResult = await InventoryMovementService.postIn(conn, id, 5, new Date(), 'MANUAL', null, 'test', null);
        check('NON_STOCK postIn: stock_added=false', inResult.stock_added === false, JSON.stringify(inResult));
        await conn.commit();
      } finally { conn.release(); }
      check('NON_STOCK postIn: balance unchanged (still 10)', await getBalance(id) === 10);
      check('NON_STOCK postIn: affect_stock=0 on ledger row', await getLastTxAffectStock(id, 'IN') === 0);

      const conn2 = await pool.getConnection();
      try {
        await conn2.beginTransaction();
        // Requesting MORE than current stock must still succeed (no check) for NON_STOCK.
        const outResult = await InventoryMovementService.postOut(conn2, id, 999, new Date(), 'SALE', null, 'test', null);
        check('NON_STOCK postOut: stock_checked=false even when qty > balance', outResult.stock_checked === false, JSON.stringify(outResult));
        await conn2.commit();
      } finally { conn2.release(); }
      check('NON_STOCK postOut: balance unchanged (still 10)', await getBalance(id) === 10);
      check('NON_STOCK postOut: affect_stock=0 on ledger row', await getLastTxAffectStock(id, 'OUT') === 0);
    }

    // ── Case 2: CARCASS_PART — same skip behavior as NON_STOCK ──
    {
      const id = await makeProduct('CARCASS_PART', false, 10);
      productIds.push(id);
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const inResult = await InventoryMovementService.postIn(conn, id, 5, new Date(), 'MANUAL', null, 'test', null);
        check('CARCASS_PART postIn: stock_added=false', inResult.stock_added === false, JSON.stringify(inResult));
        await conn.commit();
      } finally { conn.release(); }
      check('CARCASS_PART postIn: balance unchanged (still 10)', await getBalance(id) === 10);

      const conn2 = await pool.getConnection();
      try {
        await conn2.beginTransaction();
        const outResult = await InventoryMovementService.postOut(conn2, id, 999, new Date(), 'SALE', null, 'test', null);
        check('CARCASS_PART postOut: stock_checked=false even when qty > balance', outResult.stock_checked === false, JSON.stringify(outResult));
        await conn2.commit();
      } finally { conn2.release(); }
      check('CARCASS_PART postOut: balance unchanged (still 10)', await getBalance(id) === 10);
    }

    // ── Case 3: TRACK_STOCK (allow_negative_stock=0) — real check + real balance change ──
    {
      const id = await makeProduct('TRACK_STOCK', false, 10);
      productIds.push(id);
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const inResult = await InventoryMovementService.postIn(conn, id, 5, new Date(), 'MANUAL', null, 'test', null);
        check('TRACK_STOCK postIn: stock_added=true', inResult.stock_added === true, JSON.stringify(inResult));
        await conn.commit();
      } finally { conn.release(); }
      check('TRACK_STOCK postIn: balance increased to 15', await getBalance(id) === 15);
      check('TRACK_STOCK postIn: affect_stock=1 on ledger row', await getLastTxAffectStock(id, 'IN') === 1);

      // Insufficient stock must throw and must NOT change the balance.
      const conn2 = await pool.getConnection();
      let threw = false;
      try {
        await conn2.beginTransaction();
        await InventoryMovementService.postOut(conn2, id, 999, new Date(), 'SALE', null, 'test', null);
        await conn2.commit();
      } catch (e) {
        threw = true;
        await conn2.rollback();
      } finally { conn2.release(); }
      check('TRACK_STOCK postOut: insufficient stock throws', threw);
      check('TRACK_STOCK postOut: balance unchanged after failed OUT (still 15)', await getBalance(id) === 15);

      const conn3 = await pool.getConnection();
      try {
        await conn3.beginTransaction();
        const outResult = await InventoryMovementService.postOut(conn3, id, 5, new Date(), 'SALE', null, 'test', null);
        check('TRACK_STOCK postOut: stock_checked=true', outResult.stock_checked === true, JSON.stringify(outResult));
        await conn3.commit();
      } finally { conn3.release(); }
      check('TRACK_STOCK postOut: balance decreased to 10', await getBalance(id) === 10);
      check('TRACK_STOCK postOut: affect_stock=1 on ledger row', await getLastTxAffectStock(id, 'OUT') === 1);
    }

    // ── Case 4: TRACK_STOCK + allow_negative_stock=1 — IN unaffected, OUT skips check ──
    {
      const id = await makeProduct('TRACK_STOCK', true, 10);
      productIds.push(id);
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const inResult = await InventoryMovementService.postIn(conn, id, 5, new Date(), 'MANUAL', null, 'test', null);
        check('TRACK_STOCK+allowNeg postIn: stock_added=true (allow_negative_stock irrelevant to IN)', inResult.stock_added === true, JSON.stringify(inResult));
        await conn.commit();
      } finally { conn.release(); }
      check('TRACK_STOCK+allowNeg postIn: balance increased to 15', await getBalance(id) === 15);

      const conn2 = await pool.getConnection();
      try {
        await conn2.beginTransaction();
        // Requesting more than the balance must succeed (negative allowed), no throw.
        const outResult = await InventoryMovementService.postOut(conn2, id, 999, new Date(), 'SALE', null, 'test', null);
        check('TRACK_STOCK+allowNeg postOut: stock_checked=false, no throw even when qty > balance', outResult.stock_checked === false, JSON.stringify(outResult));
        await conn2.commit();
      } finally { conn2.release(); }
      check('TRACK_STOCK+allowNeg postOut: balance unchanged (skip means no balance update, still 15)', await getBalance(id) === 15);
      check('TRACK_STOCK+allowNeg postOut: affect_stock=0 on ledger row', await getLastTxAffectStock(id, 'OUT') === 0);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // S6.2 — InventoryService.adjustOrderItem
    // ══════════════════════════════════════════════════════════════════════════

    // ── NON_STOCK: no-op regardless of quantity change ──
    {
      const id = await makeProduct('NON_STOCK', false, 10);
      productIds.push(id);
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await InventoryService.adjustOrderItem(conn, id, 5, 8);
        await conn.commit();
      } finally { conn.release(); }
      check('adjustOrderItem NON_STOCK: no-op, balance unchanged (still 10)', await getBalance(id) === 10);
      check('adjustOrderItem NON_STOCK: no ledger row written', await getTxCount(id) === 0);
    }

    // ── CARCASS_PART: no-op regardless of quantity change ──
    {
      const id = await makeProduct('CARCASS_PART', false, 10);
      productIds.push(id);
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await InventoryService.adjustOrderItem(conn, id, 5, 8);
        await conn.commit();
      } finally { conn.release(); }
      check('adjustOrderItem CARCASS_PART: no-op, balance unchanged (still 10)', await getBalance(id) === 10);
      check('adjustOrderItem CARCASS_PART: no ledger row written', await getTxCount(id) === 0);
    }

    // ── TRACK_STOCK, quantity increased (more consumed) → ADJUSTMENT_DECREASE ──
    {
      const id = await makeProduct('TRACK_STOCK', false, 10);
      productIds.push(id);
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await InventoryService.adjustOrderItem(conn, id, 5, 8); // delta=3, newQty>oldQty
        await conn.commit();
      } finally { conn.release(); }
      check('adjustOrderItem TRACK_STOCK qty increase: balance decreased by delta (10→7)', await getBalance(id) === 7, `got ${await getBalance(id)}`);
      check('adjustOrderItem TRACK_STOCK qty increase: wrote ADJUSTMENT_DECREASE', await getLastTxAffectStock(id, 'ADJUSTMENT_DECREASE') === 1);
    }

    // ── TRACK_STOCK, quantity decreased (less consumed / returned) → ADJUSTMENT_INCREASE ──
    {
      const id = await makeProduct('TRACK_STOCK', false, 10);
      productIds.push(id);
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await InventoryService.adjustOrderItem(conn, id, 8, 5); // delta=3, newQty<oldQty
        await conn.commit();
      } finally { conn.release(); }
      check('adjustOrderItem TRACK_STOCK qty decrease: balance increased by delta (10→13)', await getBalance(id) === 13, `got ${await getBalance(id)}`);
      check('adjustOrderItem TRACK_STOCK qty decrease: wrote ADJUSTMENT_INCREASE', await getLastTxAffectStock(id, 'ADJUSTMENT_INCREASE') === 1);
    }

    // ── TRACK_STOCK + allow_negative_stock: no-op, same as NON_STOCK/CARCASS_PART ──
    {
      const id = await makeProduct('TRACK_STOCK', true, 10);
      productIds.push(id);
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await InventoryService.adjustOrderItem(conn, id, 5, 8);
        await conn.commit();
      } finally { conn.release(); }
      check('adjustOrderItem TRACK_STOCK+allowNeg: no-op, balance unchanged (still 10)', await getBalance(id) === 10);
      check('adjustOrderItem TRACK_STOCK+allowNeg: no ledger row written', await getTxCount(id) === 0);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // S6.2 — InventoryService.applyOrderInventory (AI order draft/confirm path)
    // ══════════════════════════════════════════════════════════════════════════
    const FAKE_ORDER_ID = 999000001;

    // ── NON_STOCK: action=NO_STOCK_SKIP, no ledger row at all (documented asymmetry) ──
    {
      const id = await makeProduct('NON_STOCK', false, 10);
      productIds.push(id);
      const conn = await pool.getConnection();
      let results;
      try {
        await conn.beginTransaction();
        results = await InventoryService.applyOrderInventory(conn, FAKE_ORDER_ID, [{ product_id: id, quantity: 3 }], { order_date: new Date() });
        await conn.commit();
      } finally { conn.release(); }
      check('applyOrderInventory NON_STOCK: action=NO_STOCK_SKIP', results[0].action === 'NO_STOCK_SKIP', JSON.stringify(results));
      check('applyOrderInventory NON_STOCK: no ledger row written (Bò Xô asymmetry preserved)', await getTxCount(id) === 0);
      check('applyOrderInventory NON_STOCK: balance unchanged (still 10)', await getBalance(id) === 10);
    }

    // ── CARCASS_PART: action=SKIP_STOCK_CHECK, ledger row written with affect_stock=0 ──
    {
      const id = await makeProduct('CARCASS_PART', false, 10);
      productIds.push(id);
      const conn = await pool.getConnection();
      let results;
      try {
        await conn.beginTransaction();
        results = await InventoryService.applyOrderInventory(conn, FAKE_ORDER_ID, [{ product_id: id, quantity: 3 }], { order_date: new Date() });
        await conn.commit();
      } finally { conn.release(); }
      check('applyOrderInventory CARCASS_PART: action=SKIP_STOCK_CHECK', results[0].action === 'SKIP_STOCK_CHECK', JSON.stringify(results));
      check('applyOrderInventory CARCASS_PART: ledger row written, affect_stock=0', await getLastTxAffectStock(id, 'OUT') === 0);
      check('applyOrderInventory CARCASS_PART: balance unchanged (still 10)', await getBalance(id) === 10);
      const [[lastNote]] = await pool.query(`SELECT note FROM stock_transactions WHERE product_id=? ORDER BY id DESC LIMIT 1`, [id]);
      check('applyOrderInventory CARCASS_PART: note says "carcass part"', /carcass part/i.test(lastNote.note), lastNote.note);
    }

    // ── TRACK_STOCK, sufficient stock: action=OUT, ledger row affect_stock=1 ──
    {
      const id = await makeProduct('TRACK_STOCK', false, 10);
      productIds.push(id);
      const conn = await pool.getConnection();
      let results;
      try {
        await conn.beginTransaction();
        results = await InventoryService.applyOrderInventory(conn, FAKE_ORDER_ID, [{ product_id: id, quantity: 3 }], { order_date: new Date() });
        await conn.commit();
      } finally { conn.release(); }
      check('applyOrderInventory TRACK_STOCK: action=OUT', results[0].action === 'OUT', JSON.stringify(results));
      check('applyOrderInventory TRACK_STOCK: ledger row affect_stock=1', await getLastTxAffectStock(id, 'OUT') === 1);
      check('applyOrderInventory TRACK_STOCK: balance decreased to 7', await getBalance(id) === 7);
    }

    // ── TRACK_STOCK, insufficient stock: throws applyOrderInventory's own message, no write ──
    {
      const id = await makeProduct('TRACK_STOCK', false, 10);
      productIds.push(id);
      const conn = await pool.getConnection();
      let threw = null;
      try {
        await conn.beginTransaction();
        await InventoryService.applyOrderInventory(conn, FAKE_ORDER_ID, [{ product_id: id, quantity: 999 }], { order_date: new Date() });
        await conn.commit();
      } catch (e) {
        threw = e;
        await conn.rollback();
      } finally { conn.release(); }
      check('applyOrderInventory TRACK_STOCK insufficient: throws', !!threw, threw && threw.message);
      check('applyOrderInventory TRACK_STOCK insufficient: message matches applyOrderInventory\'s own format', !!threw && /Không đủ tồn kho .* Tồn hiện tại: 10, cần bán: 999/.test(threw.message), threw && threw.message);
      check('applyOrderInventory TRACK_STOCK insufficient: no ledger row written', await getTxCount(id) === 0);
      check('applyOrderInventory TRACK_STOCK insufficient: balance unchanged (still 10)', await getBalance(id) === 10);
    }

    // ── TRACK_STOCK + allow_negative_stock: action=SKIP_STOCK_CHECK, no throw even if qty > balance ──
    {
      const id = await makeProduct('TRACK_STOCK', true, 10);
      productIds.push(id);
      const conn = await pool.getConnection();
      let results;
      try {
        await conn.beginTransaction();
        results = await InventoryService.applyOrderInventory(conn, FAKE_ORDER_ID, [{ product_id: id, quantity: 999 }], { order_date: new Date() });
        await conn.commit();
      } finally { conn.release(); }
      check('applyOrderInventory TRACK_STOCK+allowNeg: action=SKIP_STOCK_CHECK, no throw', results[0].action === 'SKIP_STOCK_CHECK', JSON.stringify(results));
      check('applyOrderInventory TRACK_STOCK+allowNeg: ledger row affect_stock=0', await getLastTxAffectStock(id, 'OUT') === 0);
      check('applyOrderInventory TRACK_STOCK+allowNeg: balance unchanged (still 10)', await getBalance(id) === 10);
      const [[lastNote2]] = await pool.query(`SELECT note FROM stock_transactions WHERE product_id=? ORDER BY id DESC LIMIT 1`, [id]);
      check('applyOrderInventory TRACK_STOCK+allowNeg: note says "stock deduct", not carcass part', /stock deduct/i.test(lastNote2.note) && !/carcass/i.test(lastNote2.note), lastNote2.note);
    }

  } finally {
    for (const id of productIds) {
      await pool.query(`DELETE FROM stock_transactions WHERE product_id = ?`, [id]);
      await pool.query(`DELETE FROM products WHERE id = ?`, [id]);
    }
    console.log('Cleanup done (throwaway policy-test products removed).');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
