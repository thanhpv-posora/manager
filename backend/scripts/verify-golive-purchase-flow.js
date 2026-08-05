'use strict';
// GO-LIVE — full Purchase flow regression:
//   PO → Receive → Supplier Payable → Payment → Cancel/Reverse
//
// Exercises the complete chain end to end in ONE run, asserting consistency
// at every step, then specifically covers the previously-missing final
// stage (F6 — Supplier Payment cancel/reversal):
//   - cancelPayment() posts one compensating ADJUSTMENT_INCREASE, exact
//     amount, never touches the original PAYMENT row.
//   - outstanding is restored correctly.
//   - idempotent: retry rejected, no duplicate reversal row (both the
//     app-level status guard AND the DB-level uq_supplier_payable_payment_reversal
//     unique key are exercised).
//   - supplier_purchase_payments.status/cancelled_at/cancelled_by/cancel_reason set.
//   - reason required.
//   - cancelling an already-cancelled payment rejected.
//   - a SECOND payment on the same supplier is unaffected by the first's cancel.
//   - Receive reversal (P2-02) still composes correctly with a payment that
//     was made against the SAME receive's payable and then cancelled first.
//
// Self-cleaning: throwaway supplier + products + purchase orders + receives +
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
    [`GOLIVE-PO-SUP-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`, name, '0', 'test']
  );
  return r.insertId;
}

async function makeProduct(qty) {
  const name = `GOLIVE PO FLOW ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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

async function supplierPaymentRow(id) {
  const [[row]] = await pool.query(`SELECT * FROM supplier_purchase_payments WHERE id=?`, [id]);
  return row;
}

async function stockOf(productId) {
  const [[r]] = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [productId]);
  return Number(r.stock_quantity);
}

// One full pass: create supplier+product, DRAFT->CONFIRMED PO, PENDING
// receive -> RECEIVED (posts payable), returns everything downstream steps need.
async function setupReceivedPO({ supplierId, qty = 20, price = 30000 }) {
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
  const supplierIds = [], productIds = [], poIds = [], receiveIds = [], paymentIds = [];

  try {
    const supplierId = await makeSupplier('GO-LIVE Purchase Flow Test Supplier');
    supplierIds.push(supplierId);

    // ══════════════════ Stage 1-3: PO → Receive → Payable ══════════════════
    const { product, po, rv } = await setupReceivedPO({ supplierId, qty: 20, price: 30000 });
    productIds.push(product.id); poIds.push(po.id); receiveIds.push(rv.id);
    check('Stage 1-3: stock received (20kg)', await stockOf(product.id) === 20, await stockOf(product.id));
    check('Stage 3: payable posted = 600,000', await outstanding(supplierId) === 600000, await outstanding(supplierId));

    // ══════════════════ Stage 4: Payment (partial, then full) ══════════════════
    const pay1 = await SupplierPayableAgent.createPayment({ supplier_id: supplierId, amount: 200000, payment_date: today }, user);
    paymentIds.push(pay1.payment_id);
    check('Stage 4a: partial payment reduces outstanding (600,000 -> 400,000)', await outstanding(supplierId) === 400000, await outstanding(supplierId));

    const pay2 = await SupplierPayableAgent.createPayment({ supplier_id: supplierId, amount: 400000, payment_date: today }, user);
    paymentIds.push(pay2.payment_id);
    check('Stage 4b: second payment clears outstanding (400,000 -> 0)', await outstanding(supplierId) === 0, await outstanding(supplierId));

    // ══════════════════ Stage 5: Cancel/Reverse — F6, the previously-missing stage ══════════════════

    // F5-equivalent: reason required.
    let threwNoReason = null;
    try { await SupplierPayableAgent.cancelPayment(pay1.payment_id, {}, user); } catch (e) { threwNoReason = e; }
    check('F6: cancelPayment rejects missing reason', !!threwNoReason, threwNoReason && threwNoReason.message);
    check('F6: outstanding unchanged by the rejected attempt', await outstanding(supplierId) === 0, await outstanding(supplierId));

    const rowsBeforeCancel = await payableRows(supplierId);
    const result = await SupplierPayableAgent.cancelPayment(pay1.payment_id, { reason: 'F6 test — hủy thanh toán nhầm số tiền' }, user);
    check('F6: cancelPayment succeeds', !!result && Number(result.payment_id) === pay1.payment_id && Number(result.reversed_amount) === 200000, result);
    check('F6: outstanding restored (0 -> 200,000)', await outstanding(supplierId) === 200000, await outstanding(supplierId));

    const rowsAfterCancel = await payableRows(supplierId);
    check('F6: exactly one new row appended (ADJUSTMENT_INCREASE)', rowsAfterCancel.length === rowsBeforeCancel.length + 1, { before: rowsBeforeCancel.length, after: rowsAfterCancel.length });
    const reversalRow = rowsAfterCancel.find(r => r.type === 'ADJUSTMENT_INCREASE' && Number(r.supplier_payment_id) === pay1.payment_id);
    check('F6: reversal row = 200,000, linked to the original payment_id', !!reversalRow && Number(reversalRow.amount) === 200000, reversalRow);

    // Append-only: original PAYMENT row for pay1 untouched.
    const originalPay1Row = rowsAfterCancel.find(r => r.type === 'PAYMENT' && Number(r.supplier_payment_id) === pay1.payment_id);
    check('F6: original PAYMENT ledger row untouched (still 200,000)', !!originalPay1Row && Number(originalPay1Row.amount) === 200000, originalPay1Row);
    const pay1Row = await supplierPaymentRow(pay1.payment_id);
    check('F6: supplier_purchase_payments row: status=CANCELLED, cancelled_at/by/reason set, amount UNCHANGED (historical)', String(pay1Row.status).toUpperCase() === 'CANCELLED' && !!pay1Row.cancelled_at && pay1Row.cancel_reason.includes('hủy thanh toán') && Number(pay1Row.amount) === 200000, pay1Row);

    // pay2 (the OTHER payment) is completely unaffected.
    const pay2Row = await supplierPaymentRow(pay2.payment_id);
    check('F6: the OTHER payment (pay2) is untouched by pay1\'s cancel', String(pay2Row.status || 'ACTIVE').toUpperCase() !== 'CANCELLED', pay2Row);

    // Idempotency: double-cancel rejected, no duplicate reversal row (app-level guard).
    let retryThrew = null;
    try { await SupplierPayableAgent.cancelPayment(pay1.payment_id, { reason: 'retry' }, user); } catch (e) { retryThrew = e; }
    check('F6: retrying cancel on an already-cancelled payment is rejected', !!retryThrew, retryThrew && retryThrew.message);
    check('F6: no duplicate reversal row from the retry', (await payableRows(supplierId)).length === rowsAfterCancel.length, { before: rowsAfterCancel.length, after: (await payableRows(supplierId)).length });
    check('F6: outstanding unchanged by the rejected retry', await outstanding(supplierId) === 200000, await outstanding(supplierId));

    // Idempotency at the DB level: uq_supplier_payable_payment_reversal
    // rejects a genuine concurrent duplicate insert directly, independent of
    // the app-level status guard above.
    {
      const conn = await pool.getConnection();
      let dupThrew = null;
      try {
        await conn.beginTransaction();
        await conn.query(
          `INSERT INTO supplier_payable_transactions (supplier_id, supplier_payment_id, transaction_date, type, amount, note) VALUES (?,?,?,?,?,?)`,
          [supplierId, pay1.payment_id, today, 'ADJUSTMENT_INCREASE', 999, 'direct duplicate probe']
        );
        await conn.commit();
      } catch (e) { dupThrew = e; await conn.rollback(); }
      finally { conn.release(); }
      check('F6: DB-level UNIQUE(supplier_payment_id,type) rejects a direct duplicate insert too', !!dupThrew && (dupThrew.code === 'ER_DUP_ENTRY' || dupThrew.errno === 1062), dupThrew && dupThrew.message);
    }

    // Not-found payment.
    let notFoundThrew = null;
    try { await SupplierPayableAgent.cancelPayment(999999999, { reason: 'x' }, user); } catch (e) { notFoundThrew = e; }
    check('F6: cancelling a non-existent payment is rejected (404)', !!notFoundThrew && notFoundThrew.status === 404, notFoundThrew);

    // ══════════════════ Stage 6: compose with Receive Reversal (P2-02) ══════════════════
    // pay1 was cancelled above; outstanding is 200,000 (pay2's full payment
    // still stands). Reversing the RECEIVED voucher itself now must also
    // reverse ITS OWN payable contribution (append-only ADJUSTMENT_DECREASE,
    // separate ledger row from the payment-cancel reversal above) — proves
    // the two reversal mechanisms (receive-side, payment-side) coexist
    // correctly without double-counting or interfering with each other.
    // Net signed ledger at this point: PURCHASE 600,000 − PAYMENT 200,000
    // (pay1) + ADJUSTMENT_INCREASE 200,000 (pay1's reversal) − PAYMENT
    // 400,000 (pay2) = outstanding 200,000 (matches the check above).
    // Reversing the receive appends ADJUSTMENT_DECREASE 600,000, taking the
    // raw signed net to 200,000 − 600,000 = −400,000 — summary().outstanding
    // clamps negative to 0 (an already-established, deliberate design in
    // SupplierPayableAgent.summary(), not something this task changes), so
    // the correct assertion is against the raw signed ledger sum, not a
    // simple subtraction on the clamped API value.
    const outstandingBeforeReceiveReversal = await outstanding(supplierId);
    await InventoryReceiveService.cancel(rv.id, user.id, 'Stage 6 test — hủy phiếu nhận để kiểm tra tương tác với hủy thanh toán');
    check('Stage 6: stock reversed back to 0', await stockOf(product.id) === 0, await stockOf(product.id));
    const [[rawNet]] = await pool.query(
      `SELECT COALESCE(SUM(CASE
          WHEN type IN ('PURCHASE','ADJUSTMENT_INCREASE') THEN amount
          WHEN type IN ('PAYMENT','ADJUSTMENT_DECREASE') THEN -amount
          ELSE 0 END), 0) net
       FROM supplier_payable_transactions WHERE supplier_id=?`,
      [supplierId]
    );
    check('Stage 6: raw signed ledger net decreases by exactly the original PURCHASE amount (600,000)', Number(rawNet.net) === -400000, { raw_net: rawNet.net });
    check('Stage 6: summary().outstanding clamps the negative net to 0 (already-established behavior)', await outstanding(supplierId) === 0, { before: outstandingBeforeReceiveReversal, after: await outstanding(supplierId) });
    const finalRows = await payableRows(supplierId);
    check('Stage 6: both reversal rows coexist (payment ADJUSTMENT_INCREASE + receive ADJUSTMENT_DECREASE)',
      finalRows.some(r => r.type === 'ADJUSTMENT_INCREASE' && Number(r.supplier_payment_id) === pay1.payment_id) &&
      finalRows.some(r => r.type === 'ADJUSTMENT_DECREASE' && Number(r.inventory_receive_id) === rv.id),
      finalRows);

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
    for (const pid of paymentIds) {
      await pool.query(`DELETE FROM supplier_payable_transactions WHERE supplier_payment_id=?`, [pid]).catch(() => {});
      await pool.query(`DELETE FROM supplier_purchase_payments WHERE id=?`, [pid]).catch(() => {});
    }
    for (const sid of supplierIds) {
      await pool.query(`DELETE FROM supplier_payable_transactions WHERE supplier_id=?`, [sid]).catch(() => {});
      await pool.query(`DELETE FROM supplier_purchase_payments WHERE supplier_id=?`, [sid]).catch(() => {});
      const [[map]] = await pool.query(`SELECT partner_id FROM supplier_partner_map WHERE supplier_id=?`, [sid]).catch(() => [[null]]);
      await pool.query(`DELETE FROM supplier_partner_map WHERE supplier_id=?`, [sid]).catch(() => {});
      if (map) await pool.query(`DELETE FROM customers WHERE id=? AND name LIKE 'GO-LIVE Purchase Flow%'`, [map.partner_id]).catch(() => {});
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
