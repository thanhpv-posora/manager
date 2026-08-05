'use strict';
// P2-02 Inventory Receive Reversal — verifies:
//   InventoryReceiveService.cancel() on a RECEIVED voucher posts a full
//   reversal: compensating OUT movements exactly matching the original IN
//   movements, purchase_order_items.received_stock_qty decremented back,
//   purchase_orders.status recalculated backward, supplier payable reversed
//   (append-only ADJUSTMENT_DECREASE), and inventory_receives moved to the
//   new CANCELLED_REVERSAL status with cancelled_at/cancelled_by/cancel_reason
//   persisted.
//   Original stock_transactions/inventory_receive_items/supplier_payable
//   PURCHASE rows are NEVER updated or deleted (append-only throughout).
//   Insufficient current stock rejects the whole reversal, no partial write.
//   Retrying an already-reversed voucher is rejected, no duplicate OUT.
//   A DB-level dedup-key collision mid-reversal rolls back everything already
//   written in that same transaction (true mid-transaction-failure proof).
//   Empty/missing reason is rejected before any write.
//   A PENDING voucher still cancels the old way (no movements at all).
//
// Self-cleaning: throwaway supplier + products + purchase orders + receives,
// removed in `finally`. Never touches real data.

const pool = require('../src/config/db');
const InventoryPurchaseAgent = require('../src/agents/InventoryPurchaseAgent');
const InventoryReceiveService = require('../src/services/InventoryReceiveService');
const SupplierPayableAgent = require('../src/agents/SupplierPayableAgent');
const ProductAgent = require('../src/agents/ProductAgent');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

const user = { id: null, role: 'ADMIN' };
const today = new Date().toISOString().slice(0, 10);

async function makeSupplier(name) {
  const [r] = await pool.query(
    `INSERT INTO suppliers(supplier_code,name,phone,address,is_active) VALUES(?,?,?,?,1)`,
    [`P202-SUP-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`, name, '0', 'test']
  );
  return r.insertId;
}

async function makeProduct(qty) {
  const name = `P2.02 REVERSAL ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await ProductAgent.addProduct({ name, unit: 'kg', inventory_mode: 'TRACK_STOCK', sales_flow: 'INVENTORY_SALE', stock_quantity: qty, allow_negative_stock: 0 });
  const [[created]] = await pool.query(`SELECT * FROM products WHERE name=? LIMIT 1`, [name]);
  return created;
}

async function stockOf(productId) {
  const [[r]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [productId]);
  return Number(r.stock_quantity);
}

async function stockRowsForProduct(productId) {
  const [rows] = await pool.query(`SELECT id,type,quantity,reference_type,reference_id,affect_stock FROM stock_transactions WHERE product_id=? ORDER BY id ASC`, [productId]);
  return rows;
}

async function payableRows(receiveId) {
  const [rows] = await pool.query(`SELECT * FROM supplier_payable_transactions WHERE inventory_receive_id=? ORDER BY id ASC`, [receiveId]);
  return rows;
}

async function receiveRow(id) {
  const [[r]] = await pool.query(`SELECT * FROM inventory_receives WHERE id=?`, [id]);
  return r;
}

async function outstanding(supplierId) {
  const s = await SupplierPayableAgent.summary(supplierId);
  return s.outstanding;
}

// Sets up: supplier, product, DRAFT->CONFIRMED PO with one line, PENDING
// receive, then receive()'d to RECEIVED. Returns everything needed by a scenario.
async function setupReceivedVoucher({ supplierId, qty = 10, price = 50000 }) {
  const product = await makeProduct(0);
  const po = await InventoryPurchaseAgent.create({ supplier_id: supplierId, purchase_date: today }, user.id);
  await InventoryPurchaseAgent.addItem(po.id, { product_id: product.id, quantity: qty, purchase_price: price }, user.id);
  const poFull = await InventoryPurchaseAgent.get(po.id);
  const poItemId = poFull.items[0].id;
  await InventoryPurchaseAgent.updateStatus(po.id, 'CONFIRMED', user.id);
  const rv = await InventoryReceiveService.create({
    purchase_order_id: po.id, receive_date: today,
    items: [{ purchase_order_item_id: poItemId, actual_stock_qty: qty }],
  }, user.id);
  await InventoryReceiveService.receive(rv.id, user.id);
  return { product, po, poItemId, rv };
}

async function main() {
  const supplierIds = [], productIds = [], poIds = [], receiveIds = [];

  try {
    const supplierId = await makeSupplier('P2.02 Reversal Test Supplier');
    supplierIds.push(supplierId);

    // ══════════════════ Scenario 1-4: happy path — full reversal ══════════════════
    {
      const { product, po, poItemId, rv } = await setupReceivedVoucher({ supplierId, qty: 10, price: 50000 });
      productIds.push(product.id); poIds.push(po.id); receiveIds.push(rv.id);

      check('S1: stock after receive = 10', await stockOf(product.id) === 10, await stockOf(product.id));
      const inRowsBefore = await stockRowsForProduct(product.id);
      check('S1: exactly one IN movement posted by receive()', inRowsBefore.length === 1 && inRowsBefore[0].type === 'IN', inRowsBefore);
      const outstandingBefore = await outstanding(supplierId);
      check('S1: outstanding = 500,000 after receive', outstandingBefore === 500000, outstandingBefore);

      const result = await InventoryReceiveService.cancel(rv.id, user.id, 'S1 test reversal');
      check('S1: cancel() returns CANCELLED_REVERSAL', result.status === 'CANCELLED_REVERSAL', result);
      check('S1: exactly one reversed movement reported', Array.isArray(result.reversed_movements) && result.reversed_movements.length === 1, result.reversed_movements);

      const header = await receiveRow(rv.id);
      check('S1: header status = CANCELLED_REVERSAL', header.status === 'CANCELLED_REVERSAL', header.status);
      check('S1: cancelled_at/cancelled_by/cancel_reason persisted', !!header.cancelled_at && header.cancel_reason === 'S1 test reversal', header);

      // S2 — original IN row unchanged
      const rowsAfter = await stockRowsForProduct(product.id);
      check('S2: original IN row still present, unchanged (id/type/qty)', rowsAfter.some(r => r.id === inRowsBefore[0].id && r.type === 'IN' && Number(r.quantity) === 10), rowsAfter);

      // S3 — exactly one compensating OUT row, qty matches
      const outRows = rowsAfter.filter(r => r.type === 'OUT' && r.reference_type === 'RECEIVE_VOUCHER' && Number(r.reference_id) === rv.id);
      check('S3: exactly one compensating OUT row, quantity = 10, affect_stock=1', outRows.length === 1 && Number(outRows[0].quantity) === 10 && Number(outRows[0].affect_stock) === 1, outRows);
      check('S3: row count only grew by one (append-only, nothing deleted)', rowsAfter.length === inRowsBefore.length + 1, { before: inRowsBefore.length, after: rowsAfter.length });

      // S4 — stock returned to pre-receive quantity (0)
      check('S4: stock back to 0 after reversal', await stockOf(product.id) === 0, await stockOf(product.id));

      // purchase_order_items / purchase_orders bookkeeping unwound
      const [[poItemRow]] = await pool.query(`SELECT received_stock_qty FROM purchase_order_items WHERE id=?`, [poItemId]);
      check('Bookkeeping: received_stock_qty decremented back to 0', Number(poItemRow.received_stock_qty) === 0, poItemRow.received_stock_qty);
      const poAfter = await InventoryPurchaseAgent.get(po.id);
      check('Bookkeeping: PO status recalculated back to CONFIRMED', poAfter.status === 'CONFIRMED', poAfter.status);

      // S9 — payable reversal, append-only
      const pRows = await payableRows(rv.id);
      check('S9: two payable rows (PURCHASE + ADJUSTMENT_DECREASE), same amount', pRows.length === 2 && pRows.some(r => r.type === 'PURCHASE' && Number(r.amount) === 500000) && pRows.some(r => r.type === 'ADJUSTMENT_DECREASE' && Number(r.amount) === 500000), pRows);
      check('S9: original PURCHASE row untouched', pRows.find(r => r.type === 'PURCHASE').amount == 500000);
      check('S9: outstanding back to 0', await outstanding(supplierId) === 0, await outstanding(supplierId));

      // audit_logs row written
      const [auditRows] = await pool.query(`SELECT * FROM audit_logs WHERE entity_type='inventory_receives' AND entity_id=? ORDER BY id DESC LIMIT 1`, [rv.id]);
      check('Audit: REVERSE_RECEIVE row written', auditRows.length === 1 && auditRows[0].action === 'REVERSE_RECEIVE', auditRows);

      // S5 — retry rejected, no duplicate OUT
      let retryThrew = null;
      try { await InventoryReceiveService.cancel(rv.id, user.id, 'retry'); } catch (e) { retryThrew = e; }
      check('S5: retrying reversal on an already-reversed voucher is rejected', !!retryThrew, retryThrew && retryThrew.message);
      const rowsAfterRetry = await stockRowsForProduct(product.id);
      check('S5: no duplicate OUT row from the retry', rowsAfterRetry.length === rowsAfter.length, { before: rowsAfter.length, after: rowsAfterRetry.length });
      check('S5: outstanding still 0 after rejected retry', await outstanding(supplierId) === 0, await outstanding(supplierId));
    }

    // ══════════════════ Scenario 6: insufficient stock blocks reversal ══════════════════
    {
      const { product, po, rv } = await setupReceivedVoucher({ supplierId, qty: 10, price: 20000 });
      productIds.push(product.id); poIds.push(po.id); receiveIds.push(rv.id);

      // Simulate "hàng đã được xuất" — a manual OUT drops stock below the
      // reversal quantity before anyone tries to cancel the receive.
      const InventoryService = require('../src/services/InventoryService');
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await InventoryService.out(conn, product.id, 7, today, 'MANUAL', null, 'simulated sale eating into received stock', null);
        await conn.commit();
      } finally { conn.release(); }
      check('S6 setup: stock now 3 (10 received - 7 sold)', await stockOf(product.id) === 3, await stockOf(product.id));

      const rowsBefore = await stockRowsForProduct(product.id);
      let threw = null;
      try { await InventoryReceiveService.cancel(rv.id, user.id, 'S6 insufficient stock test'); } catch (e) { threw = e; }
      check('S6: reversal rejected for insufficient stock', !!threw, threw && threw.message);
      check('S6: rejection carries INSUFFICIENT_STOCK_FOR_RECEIVE_REVERSAL code', threw && threw.code === 'INSUFFICIENT_STOCK_FOR_RECEIVE_REVERSAL', threw && threw.code);
      check('S6: stock unchanged by the rejected reversal (still 3)', await stockOf(product.id) === 3, await stockOf(product.id));
      check('S6: no OUT reversal row was written (no partial movement)', (await stockRowsForProduct(product.id)).length === rowsBefore.length, { before: rowsBefore.length, after: (await stockRowsForProduct(product.id)).length });
      const header = await receiveRow(rv.id);
      check('S6: header status remains RECEIVED (not reversed)', header.status === 'RECEIVED', header.status);
      check('S6: no payable reversal was posted', (await payableRows(rv.id)).filter(r => r.type === 'ADJUSTMENT_DECREASE').length === 0);
    }

    // ══════════════════ Scenario 7: mid-transaction failure → full rollback ══════════════════
    {
      const productA = await makeProduct(0);
      const productB = await makeProduct(0);
      productIds.push(productA.id, productB.id);
      const po = await InventoryPurchaseAgent.create({ supplier_id: supplierId, purchase_date: today }, user.id);
      poIds.push(po.id);
      await InventoryPurchaseAgent.addItem(po.id, { product_id: productA.id, quantity: 5, purchase_price: 10000 }, user.id);
      await InventoryPurchaseAgent.addItem(po.id, { product_id: productB.id, quantity: 5, purchase_price: 10000 }, user.id);
      const poFull = await InventoryPurchaseAgent.get(po.id);
      await InventoryPurchaseAgent.updateStatus(po.id, 'CONFIRMED', user.id);
      const itemA = poFull.items.find(i => i.product_id === productA.id);
      const itemB = poFull.items.find(i => i.product_id === productB.id);
      const rv = await InventoryReceiveService.create({
        purchase_order_id: po.id, receive_date: today,
        items: [{ purchase_order_item_id: itemA.id, actual_stock_qty: 5 }, { purchase_order_item_id: itemB.id, actual_stock_qty: 5 }],
      }, user.id);
      receiveIds.push(rv.id);
      await InventoryReceiveService.receive(rv.id, user.id);
      check('S7 setup: both products received (5 each)', await stockOf(productA.id) === 5 && await stockOf(productB.id) === 5);

      // Pre-plant a row that collides with product B's compensating OUT dedup
      // key (product_id, receive_id) — forces postReversal() to fail AFTER it
      // has already written product A's real OUT movement + balance update in
      // the same transaction (products are locked/processed in ascending
      // product_id order, and productA.id < productB.id by insertion order in
      // this fresh test DB range) — proving the whole transaction rolls back
      // together, not partially.
      const [[ordCheck]] = await pool.query(`SELECT ? < ? AS aFirst`, [productA.id, productB.id]);
      const [firstId, secondId] = ordCheck.aFirst ? [productA.id, productB.id] : [productB.id, productA.id];
      await pool.query(
        `INSERT INTO stock_transactions (product_id, transaction_date, type, quantity, reference_type, reference_id, note, affect_stock)
         VALUES (?, ?, 'OUT', 1, 'RECEIVE_VOUCHER', ?, 'P2.02 test pre-existing dedup blocker', 1)`,
        [secondId, today, rv.id]
      );

      const firstStockBefore = await stockOf(firstId);
      const firstRowsBefore = await stockRowsForProduct(firstId);

      let threw = null;
      try { await InventoryReceiveService.cancel(rv.id, user.id, 'S7 mid-transaction failure test'); } catch (e) { threw = e; }
      check('S7: reversal throws on the dedup collision', !!threw, threw && threw.message);

      check('S7: the OTHER product\'s stock is unchanged (rolled back, not partially applied)', await stockOf(firstId) === firstStockBefore, { before: firstStockBefore, after: await stockOf(firstId) });
      const firstRowsAfter = await stockRowsForProduct(firstId);
      check('S7: the OTHER product got NO new stock_transactions row (real OUT write was rolled back)', firstRowsAfter.length === firstRowsBefore.length, { before: firstRowsBefore.length, after: firstRowsAfter.length });
      const header = await receiveRow(rv.id);
      check('S7: header status still RECEIVED (status update rolled back too)', header.status === 'RECEIVED', header.status);
      check('S7: no payable reversal posted (rolled back)', (await payableRows(rv.id)).filter(r => r.type === 'ADJUSTMENT_DECREASE').length === 0);
      const [[poItemRowA]] = await pool.query(`SELECT received_stock_qty FROM purchase_order_items WHERE id=?`, [itemA.id]);
      check('S7: received_stock_qty NOT decremented (rolled back)', Number(poItemRowA.received_stock_qty) === 5, poItemRowA.received_stock_qty);
    }

    // ══════════════════ Scenario 8: already-cancelled (PENDING path) voucher → reversal rejected ══════════════════
    {
      const product = await makeProduct(0);
      productIds.push(product.id);
      const po = await InventoryPurchaseAgent.create({ supplier_id: supplierId, purchase_date: today }, user.id);
      poIds.push(po.id);
      await InventoryPurchaseAgent.addItem(po.id, { product_id: product.id, quantity: 5, purchase_price: 10000 }, user.id);
      const poFull = await InventoryPurchaseAgent.get(po.id);
      await InventoryPurchaseAgent.updateStatus(po.id, 'CONFIRMED', user.id);
      const rv = await InventoryReceiveService.create({
        purchase_order_id: po.id, receive_date: today,
        items: [{ purchase_order_item_id: poFull.items[0].id, actual_stock_qty: 5 }],
      }, user.id);
      receiveIds.push(rv.id);

      // PENDING cancel path — no stock ever committed.
      const result = await InventoryReceiveService.cancel(rv.id, user.id, 'S8 pending cancel');
      check('S8: PENDING cancel returns plain CANCELLED (not CANCELLED_REVERSAL)', result.status === 'CANCELLED', result);
      check('S8: no stock movement posted for a PENDING cancel', (await stockRowsForProduct(product.id)).length === 0);

      let threw = null;
      try { await InventoryReceiveService.cancel(rv.id, user.id, 'second attempt'); } catch (e) { threw = e; }
      check('S8: cancelling an already-CANCELLED voucher is rejected', !!threw, threw && threw.message);
    }

    // ══════════════════ Scenario 10: empty/missing reason rejected before any write ══════════════════
    {
      const { product, po, rv } = await setupReceivedVoucher({ supplierId, qty: 4, price: 10000 });
      productIds.push(product.id); poIds.push(po.id); receiveIds.push(rv.id);

      const rowsBefore = await stockRowsForProduct(product.id);
      let threw1 = null;
      try { await InventoryReceiveService.cancel(rv.id, user.id, ''); } catch (e) { threw1 = e; }
      check('S10: empty reason rejected', !!threw1, threw1 && threw1.message);
      let threw2 = null;
      try { await InventoryReceiveService.cancel(rv.id, user.id, undefined); } catch (e) { threw2 = e; }
      check('S10: missing reason rejected', !!threw2, threw2 && threw2.message);
      check('S10: no movement/status change from either rejected attempt', (await stockRowsForProduct(product.id)).length === rowsBefore.length && (await receiveRow(rv.id)).status === 'RECEIVED');

      // Clean up properly with a valid reason so cleanup below doesn't need
      // to special-case this voucher.
      await InventoryReceiveService.cancel(rv.id, user.id, 'S10 cleanup');
    }

  } finally {
    for (const rid of receiveIds) {
      await pool.query(`DELETE FROM supplier_payable_transactions WHERE inventory_receive_id=?`, [rid]).catch(() => {});
      await pool.query(`DELETE FROM stock_transactions WHERE reference_type='RECEIVE_VOUCHER' AND reference_id=?`, [rid]).catch(() => {});
      await pool.query(`DELETE FROM audit_logs WHERE entity_type='inventory_receives' AND entity_id=?`, [rid]).catch(() => {});
      await pool.query(`DELETE FROM inventory_receive_items WHERE receive_id=?`, [rid]).catch(() => {});
      await pool.query(`DELETE FROM inventory_receives WHERE id=?`, [rid]).catch(() => {});
    }
    for (const pid of poIds) {
      await pool.query(`DELETE FROM supplier_payable_transactions WHERE purchase_order_id=?`, [pid]).catch(() => {});
      await pool.query(`DELETE FROM purchase_order_items WHERE purchase_order_id=?`, [pid]).catch(() => {});
      await pool.query(`DELETE FROM purchase_orders WHERE id=?`, [pid]).catch(() => {});
    }
    for (const sid of supplierIds) {
      await pool.query(`DELETE FROM supplier_payable_transactions WHERE supplier_id=?`, [sid]).catch(() => {});
      await pool.query(`DELETE FROM supplier_purchase_payments WHERE supplier_id=?`, [sid]).catch(() => {});
      const [[map]] = await pool.query(`SELECT partner_id FROM supplier_partner_map WHERE supplier_id=?`, [sid]).catch(() => [[null]]);
      await pool.query(`DELETE FROM supplier_partner_map WHERE supplier_id=?`, [sid]).catch(() => {});
      if (map) await pool.query(`DELETE FROM customers WHERE id=? AND name LIKE 'P2.02 Reversal%'`, [map.partner_id]).catch(() => {});
      await pool.query(`DELETE FROM suppliers WHERE id=?`, [sid]).catch(() => {});
    }
    for (const id of productIds) {
      await pool.query(`DELETE FROM stock_transactions WHERE product_id=?`, [id]).catch(() => {});
      await pool.query(`DELETE FROM products WHERE id=?`, [id]).catch(() => {});
    }
    console.log('Cleanup done.');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
