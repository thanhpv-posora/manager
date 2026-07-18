'use strict';
// S10.1 Supplier Payable Core — verifies:
//   Payable is recognized ONLY when a receive voucher becomes RECEIVED (never
//   DRAFT PO, CONFIRMED PO alone, or PENDING receive) — proven, not assumed.
//   Amount = SUM(actual_stock_qty * frozen purchase_order_items.purchase_price)
//   per receive voucher, one PURCHASE row per inventory_receive_id (DB-unique).
//   Short Close and cancelling a PENDING receive create zero payable, by
//   construction (payable only ever posts inside receive()).
//   Payment: idempotent (idempotency_key UNIQUE), rejects overpayment before
//   any write, never makes outstanding negative.
//   Inventory IN + Stock Ledger + Supplier Payable commit/rollback together.
//   Legacy lot-based supplier_payments table is never touched.
//
// Self-cleaning: throwaway suppliers + products + purchase orders + receives +
// payments, removed in `finally`. Never touches real data.

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
    [`S101-SUP-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`, name, '0', 'test']
  );
  return r.insertId;
}

async function makeProduct(qty) {
  const name = `S10.1 PAYABLE ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await ProductAgent.addProduct({ name, unit: 'kg', inventory_mode: 'TRACK_STOCK', sales_flow: 'INVENTORY_SALE', stock_quantity: qty, allow_negative_stock: 0 });
  const [[created]] = await pool.query(`SELECT * FROM products WHERE name=? LIMIT 1`, [name]);
  return created;
}

async function outstanding(supplierId) {
  const s = await SupplierPayableAgent.summary(supplierId);
  return s.outstanding;
}

async function payableRows(supplierId) {
  const [rows] = await pool.query(`SELECT * FROM supplier_payable_transactions WHERE supplier_id=? ORDER BY id ASC`, [supplierId]);
  return rows;
}

async function stockOf(productId) {
  const [[r]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [productId]);
  return Number(r.stock_quantity);
}

async function main() {
  const supplierIds = [], productIds = [], poIds = [], receiveIds = [], paymentIds = [];

  try {
    // ══════════════════════ Baseline: legacy Bò Xô supplier_payments untouched ══════════════════════
    const [[legacyBefore]] = await pool.query(`SELECT COUNT(*) cnt FROM supplier_payments`);

    // ══════════════════════ Main supplier + product + PO ══════════════════════
    const supplierId = await makeSupplier('S10.1 Payable Test Supplier A');
    supplierIds.push(supplierId);
    const product = await makeProduct(0);
    productIds.push(product.id);

    const po = await InventoryPurchaseAgent.create({ supplier_id: supplierId, purchase_date: today }, user.id);
    poIds.push(po.id);
    await InventoryPurchaseAgent.addItem(po.id, { product_id: product.id, quantity: 20, purchase_price: 50000 }, user.id);
    const poFull = await InventoryPurchaseAgent.get(po.id);
    const poItemId = poFull.items[0].id;

    // ══════════════════════ 1. DRAFT PO → no payable ══════════════════════
    check('1. DRAFT PO: outstanding = 0', await outstanding(supplierId) === 0, await outstanding(supplierId));

    // ══════════════════════ 2. CONFIRMED PO, no receive → no payable ══════════════════════
    await InventoryPurchaseAgent.updateStatus(po.id, 'CONFIRMED', user.id);
    check('2. CONFIRMED PO, no receive: outstanding = 0', await outstanding(supplierId) === 0, await outstanding(supplierId));

    // ══════════════════════ 3. PENDING receive → no payable ══════════════════════
    const rv1 = await InventoryReceiveService.create({
      purchase_order_id: po.id, receive_date: today,
      items: [{ purchase_order_item_id: poItemId, actual_stock_qty: 8 }],
    }, user.id);
    receiveIds.push(rv1.id);
    check('3. PENDING receive created: outstanding still = 0', await outstanding(supplierId) === 0, await outstanding(supplierId));

    // ══════════════════════ 4. Receive part 1 → payable = received amount only ══════════════════════
    await InventoryReceiveService.receive(rv1.id, user.id);
    check('4. Receive part 1 (8kg @ 50,000): outstanding = 400,000', await outstanding(supplierId) === 400000, await outstanding(supplierId));
    check('4. Stock deducted... no — Inventory IN adds stock (0 -> 8)', await stockOf(product.id) === 8, await stockOf(product.id));
    const rowsAfter1 = await payableRows(supplierId);
    check('4. Exactly one PURCHASE row, tagged to this receive voucher', rowsAfter1.length === 1 && rowsAfter1[0].type === 'PURCHASE' && Number(rowsAfter1[0].inventory_receive_id) === rv1.id, rowsAfter1);

    // ══════════════════════ 5. Receive part 2 → second payable appended, total = both ══════════════════════
    const rv2 = await InventoryReceiveService.create({
      purchase_order_id: po.id, receive_date: today,
      items: [{ purchase_order_item_id: poItemId, actual_stock_qty: 12 }],
    }, user.id);
    receiveIds.push(rv2.id);
    await InventoryReceiveService.receive(rv2.id, user.id);
    check('5. Receive part 2 (12kg @ 50,000): outstanding = 1,000,000 (400k + 600k)', await outstanding(supplierId) === 1000000, await outstanding(supplierId));
    const rowsAfter2 = await payableRows(supplierId);
    check('5. Two PURCHASE rows total, one per receive voucher', rowsAfter2.filter(r => r.type === 'PURCHASE').length === 2, rowsAfter2);
    const poFullAfter = await InventoryPurchaseAgent.get(po.id);
    check('5. PO status = RECEIVED (fully received)', poFullAfter.status === 'RECEIVED', poFullAfter.status);

    // ══════════════════════ 6. Short Close → no payable for unreceived remainder ══════════════════════
    {
      const supplierId2 = await makeSupplier('S10.1 Payable Test Supplier ShortClose');
      supplierIds.push(supplierId2);
      const product2 = await makeProduct(0);
      productIds.push(product2.id);
      const po2 = await InventoryPurchaseAgent.create({ supplier_id: supplierId2, purchase_date: today }, user.id);
      poIds.push(po2.id);
      await InventoryPurchaseAgent.addItem(po2.id, { product_id: product2.id, quantity: 20, purchase_price: 30000 }, user.id);
      const po2Full = await InventoryPurchaseAgent.get(po2.id);
      await InventoryPurchaseAgent.updateStatus(po2.id, 'CONFIRMED', user.id);
      const rv3 = await InventoryReceiveService.create({
        purchase_order_id: po2.id, receive_date: today,
        items: [{ purchase_order_item_id: po2Full.items[0].id, actual_stock_qty: 5 }],
      }, user.id);
      receiveIds.push(rv3.id);
      await InventoryReceiveService.receive(rv3.id, user.id);
      check('6a. Partial receive (5kg @ 30,000): outstanding = 150,000', await outstanding(supplierId2) === 150000, await outstanding(supplierId2));

      await InventoryPurchaseAgent.shortClose(po2.id, 'S10.1 test short close', user.id);
      check('6b. After Short Close: outstanding UNCHANGED at 150,000 (no payable for the 15kg unreceived remainder)', await outstanding(supplierId2) === 150000, await outstanding(supplierId2));
      const po2FullAfter = await InventoryPurchaseAgent.get(po2.id);
      check('6c. PO status = SHORT_CLOSED', po2FullAfter.status === 'SHORT_CLOSED', po2FullAfter.status);
    }

    // ══════════════════════ 7. Duplicate receive retry → no duplicate payable ══════════════════════
    {
      // 7a. Outer guard: receive() on an already-RECEIVED voucher is rejected.
      let threw = null;
      try { await InventoryReceiveService.receive(rv1.id, user.id); } catch (e) { threw = e; }
      check('7a. Re-calling receive() on an already-RECEIVED voucher is rejected', !!threw, threw && threw.message);
      check('7a. No duplicate PURCHASE row from the rejected retry', (await payableRows(supplierId)).filter(r => r.type === 'PURCHASE').length === 2);

      // 7b. Direct idempotency proof of postPurchasePayable() itself (DB-uniqueness, not just app logic).
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const before = await conn.query(`SELECT COUNT(*) cnt FROM supplier_payable_transactions WHERE inventory_receive_id=? AND type='PURCHASE'`, [rv1.id]);
        const first = await SupplierPayableAgent.postPurchasePayable(conn, { supplierId, purchaseOrderId: po.id, inventoryReceiveId: rv1.id, transactionDate: today, amount: 999999, note: 'retry-test' });
        const second = await SupplierPayableAgent.postPurchasePayable(conn, { supplierId, purchaseOrderId: po.id, inventoryReceiveId: rv1.id, transactionDate: today, amount: 999999, note: 'retry-test-2' });
        await conn.commit();
        check('7b. postPurchasePayable() called twice for the same inventory_receive_id returns the SAME existing row (DB-unique, not a new insert)', first.id === second.id, { first, second });
      } finally { conn.release(); }
      check('7b. Still exactly one PURCHASE row for rv1 after the direct double-call', (await payableRows(supplierId)).filter(r => r.type === 'PURCHASE' && Number(r.inventory_receive_id) === rv1.id).length === 1);
    }

    // ══════════════════════ 8. Supplier payment → outstanding decreases correctly ══════════════════════
    const payKey1 = `S101-PAYTEST-${Date.now()}-a`;
    const pay1 = await SupplierPayableAgent.createPayment({ supplier_id: supplierId, amount: 400000, payment_date: today, idempotency_key: payKey1 }, user);
    paymentIds.push(pay1.payment_id);
    check('8. Payment 400,000: outstanding decreases (1,000,000 -> 600,000)', await outstanding(supplierId) === 600000, await outstanding(supplierId));

    // ══════════════════════ 9. Overpayment → rejected, no ledger change ══════════════════════
    const rowsBeforeOverpay = await payableRows(supplierId);
    let overpayThrew = null;
    try { await SupplierPayableAgent.createPayment({ supplier_id: supplierId, amount: 999999999, payment_date: today }, user); }
    catch (e) { overpayThrew = e; }
    check('9. Overpayment rejected', !!overpayThrew, overpayThrew && overpayThrew.message);
    check('9. Outstanding unchanged after rejected overpayment', await outstanding(supplierId) === 600000, await outstanding(supplierId));
    check('9. No new ledger row from the rejected overpayment', (await payableRows(supplierId)).length === rowsBeforeOverpay.length);

    // ══════════════════════ 10. Duplicate payment retry → one payment only ══════════════════════
    const payKey2 = `S101-PAYTEST-${Date.now()}-b`;
    const dup1 = await SupplierPayableAgent.createPayment({ supplier_id: supplierId, amount: 100000, payment_date: today, idempotency_key: payKey2 }, user);
    paymentIds.push(dup1.payment_id);
    const dup2 = await SupplierPayableAgent.createPayment({ supplier_id: supplierId, amount: 100000, payment_date: today, idempotency_key: payKey2 }, user);
    check('10. Duplicate payment retry (same idempotency_key) returns the SAME payment_id', dup1.payment_id === dup2.payment_id, { dup1, dup2 });
    check('10. Outstanding reflects only ONE 100,000 payment (600,000 -> 500,000)', await outstanding(supplierId) === 500000, await outstanding(supplierId));
    const [[payCountRow]] = await pool.query(`SELECT COUNT(*) cnt FROM supplier_purchase_payments WHERE idempotency_key=?`, [payKey2]);
    check('10. Exactly one row in supplier_purchase_payments for this idempotency_key', Number(payCountRow.cnt) === 1, payCountRow.cnt);

    // ══════════════════════ 11. Multiple suppliers → balances isolated ══════════════════════
    {
      const supplierIdB = await makeSupplier('S10.1 Payable Test Supplier B');
      supplierIds.push(supplierIdB);
      const productB = await makeProduct(0);
      productIds.push(productB.id);
      const poB = await InventoryPurchaseAgent.create({ supplier_id: supplierIdB, purchase_date: today }, user.id);
      poIds.push(poB.id);
      await InventoryPurchaseAgent.addItem(poB.id, { product_id: productB.id, quantity: 10, purchase_price: 20000 }, user.id);
      const poBFull = await InventoryPurchaseAgent.get(poB.id);
      await InventoryPurchaseAgent.updateStatus(poB.id, 'CONFIRMED', user.id);
      const rvB = await InventoryReceiveService.create({
        purchase_order_id: poB.id, receive_date: today,
        items: [{ purchase_order_item_id: poBFull.items[0].id, actual_stock_qty: 10 }],
      }, user.id);
      receiveIds.push(rvB.id);
      await InventoryReceiveService.receive(rvB.id, user.id);
      check('11. Supplier B outstanding = 200,000, independent of Supplier A', await outstanding(supplierIdB) === 200000, await outstanding(supplierIdB));
      check('11. Supplier A outstanding UNCHANGED by Supplier B activity (still 500,000)', await outstanding(supplierId) === 500000, await outstanding(supplierId));
    }

    // ══════════════════════ 12. Legacy Bò Xô supplier_payments unchanged ══════════════════════
    const [[legacyAfter]] = await pool.query(`SELECT COUNT(*) cnt FROM supplier_payments`);
    check('12. Legacy lot-based supplier_payments row count unchanged', Number(legacyAfter.cnt) === Number(legacyBefore.cnt), { before: legacyBefore.cnt, after: legacyAfter.cnt });

    // ══════════════════════ 13. Inventory IN + Supplier Payable commit/rollback together ══════════════════════
    {
      const supplierId3 = await makeSupplier('S10.1 Payable Test Supplier Atomicity');
      supplierIds.push(supplierId3);
      const productA = await makeProduct(0);
      const productB2 = await makeProduct(0);
      productIds.push(productA.id, productB2.id);
      const po3 = await InventoryPurchaseAgent.create({ supplier_id: supplierId3, purchase_date: today }, user.id);
      poIds.push(po3.id);
      await InventoryPurchaseAgent.addItem(po3.id, { product_id: productA.id, quantity: 10, purchase_price: 10000 }, user.id);
      await InventoryPurchaseAgent.addItem(po3.id, { product_id: productB2.id, quantity: 10, purchase_price: 10000 }, user.id);
      const po3Full = await InventoryPurchaseAgent.get(po3.id);
      await InventoryPurchaseAgent.updateStatus(po3.id, 'CONFIRMED', user.id);
      const itemA = po3Full.items.find(i => i.product_id === productA.id);
      const itemB = po3Full.items.find(i => i.product_id === productB2.id);
      const rv4 = await InventoryReceiveService.create({
        purchase_order_id: po3.id, receive_date: today,
        items: [
          { purchase_order_item_id: itemA.id, actual_stock_qty: 5 },
          { purchase_order_item_id: itemB.id, actual_stock_qty: 5 },
        ],
      }, user.id);
      receiveIds.push(rv4.id);

      // Deliberately break line B's PO-item link AFTER voucher creation so receive()
      // processes line A successfully (posts Inventory IN) THEN throws on line B —
      // proving the whole transaction (including line A's already-applied stock
      // change) rolls back together, not partially.
      await pool.query(`DELETE FROM purchase_order_items WHERE id=?`, [itemB.id]);

      let atomicityThrew = null;
      try { await InventoryReceiveService.receive(rv4.id, user.id); } catch (e) { atomicityThrew = e; }
      check('13a. receive() throws when a line becomes invalid mid-transaction', !!atomicityThrew, atomicityThrew && atomicityThrew.message);
      check('13b. Line A stock NOT applied (rolled back together, stays 0)', await stockOf(productA.id) === 0, await stockOf(productA.id));
      const [rv4Row] = await pool.query(`SELECT status FROM inventory_receives WHERE id=?`, [rv4.id]);
      check('13c. Receive voucher status still PENDING (not RECEIVED)', rv4Row[0].status === 'PENDING', rv4Row[0].status);
      check('13d. No supplier payable posted from the rolled-back attempt', await outstanding(supplierId3) === 0, await outstanding(supplierId3));
      const [stockTxA] = await pool.query(`SELECT * FROM stock_transactions WHERE product_id=? AND reference_id=?`, [productA.id, rv4.id]);
      check('13e. No stock_transactions row for line A (rolled back, not just balance reverted)', stockTxA.length === 0, stockTxA);
    }

    // ══════════════════════ 14. Signed ledger aggregate matches summary API ══════════════════════
    {
      const [[raw]] = await pool.query(
        `SELECT COALESCE(SUM(CASE
            WHEN type IN ('PURCHASE','ADJUSTMENT_INCREASE') THEN amount
            WHEN type IN ('PAYMENT','ADJUSTMENT_DECREASE') THEN -amount
            ELSE 0 END),0) net
         FROM supplier_payable_transactions WHERE supplier_id=?`,
        [supplierId]
      );
      const apiOutstanding = await outstanding(supplierId);
      check('14. Raw signed SUM matches summary() API outstanding', Number(raw.net) === apiOutstanding, { raw: raw.net, api: apiOutstanding });
    }

  } finally {
    for (const rid of receiveIds) {
      await pool.query(`DELETE FROM supplier_payable_transactions WHERE inventory_receive_id=?`, [rid]).catch(() => {});
      await pool.query(`DELETE FROM stock_transactions WHERE reference_type='RECEIVE_VOUCHER' AND reference_id=?`, [rid]).catch(() => {});
      await pool.query(`DELETE FROM inventory_receive_items WHERE receive_id=?`, [rid]).catch(() => {});
      await pool.query(`DELETE FROM inventory_receives WHERE id=?`, [rid]).catch(() => {});
    }
    for (const pid of poIds) {
      await pool.query(`DELETE FROM supplier_payable_transactions WHERE purchase_order_id=?`, [pid]).catch(() => {});
      await pool.query(`DELETE FROM purchase_order_items WHERE purchase_order_id=?`, [pid]).catch(() => {});
      await pool.query(`DELETE FROM purchase_orders WHERE id=?`, [pid]).catch(() => {});
    }
    for (const pid of paymentIds) {
      await pool.query(`DELETE FROM supplier_payable_transactions WHERE supplier_payment_id=?`, [pid]).catch(() => {});
      await pool.query(`DELETE FROM supplier_purchase_payments WHERE id=?`, [pid]).catch(() => {});
    }
    for (const sid of supplierIds) {
      await pool.query(`DELETE FROM supplier_payable_transactions WHERE supplier_id=?`, [sid]).catch(() => {});
      await pool.query(`DELETE FROM supplier_purchase_payments WHERE supplier_id=?`, [sid]).catch(() => {});
      // Defensive: an unrelated pre-existing migration (BP-001B in bootstrap.js)
      // auto-links any unmapped supplier to a mirroring customers/partner row
      // whenever ensureSchema() runs (e.g. a dev-server restart mid-test-run).
      // Clean that up too so this script is self-cleaning regardless.
      const [[map]] = await pool.query(`SELECT partner_id FROM supplier_partner_map WHERE supplier_id=?`, [sid]);
      await pool.query(`DELETE FROM supplier_partner_map WHERE supplier_id=?`, [sid]).catch(() => {});
      if (map) await pool.query(`DELETE FROM customers WHERE id=? AND name LIKE 'S10.1 Payable%'`, [map.partner_id]).catch(() => {});
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
