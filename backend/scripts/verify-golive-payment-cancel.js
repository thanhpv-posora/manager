'use strict';
// GO-LIVE — Payment Cancel / Payment Reversal gap fixes. Verifies:
//   F1: payments.status/is_locked/locked_at/locked_by/lock_note/updated_at/
//       payment_calendar_type/payment_lunar_date_text and orders.is_locked/
//       locked_at/locked_by/lock_note (V65.47) are present via
//       SchemaMigrationAgent, not just by luck on this one DB.
//   F2 (H-12): payment_allocations/payment_unapplied_credits are snapshotted
//       to audit_logs BEFORE being removed on cancel — the "which bills did
//       this cover" fact survives even though the detail rows themselves are
//       gone (no read path changed, so nothing regresses).
//   F3: debt_installment_payments rows tied to the cancelled payment are
//       removed (previously never touched — permanent over-statement of
//       installment plan progress) and also snapshotted first.
//   F4: cancel() no longer silently destroys the original amount —
//       original_amount/original_cash_amount/original_bank_amount preserved,
//       cancelled_at/cancelled_by/cancel_reason recorded — while amount/
//       cash_amount/bank_amount still zero out exactly as before (backward
//       compatible with every existing SUM(amount) reporting query).
//   F5: empty/missing reason is rejected before any write.
//   Regression: debt ledger stays append-only and in sync with
//       orders.debt_amount throughout (same invariant verify-s8-1a already
//       checks), double-cancel is rejected, update() gets the same
//       snapshot-before-delete treatment as cancel().
//
// Self-cleaning: throwaway customer + products + orders + payments,
// removed in `finally`. Never touches real data.

const pool = require('../src/config/db');
const OrderAgent = require('../src/agents/OrderAgent');
const PaymentAgent = require('../src/agents/PaymentAgent');
const ProductAgent = require('../src/agents/ProductAgent');
const SchemaMigrationAgent = require('../src/agents/SchemaMigrationAgent');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

const user = { id: null, role: 'ADMIN' };
const today = new Date().toISOString().slice(0, 10);

async function makeProduct(qty) {
  const name = `GOLIVE PAY ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await ProductAgent.addProduct({ name, unit: 'kg', inventory_mode: 'TRACK_STOCK', sales_flow: 'INVENTORY_SALE', stock_quantity: qty, allow_negative_stock: 0 });
  const [[created]] = await pool.query(`SELECT * FROM products WHERE name=? LIMIT 1`, [name]);
  return created;
}

async function debtLedgerSum(customerId) {
  const [[row]] = await pool.query(
    `SELECT COALESCE(SUM(CASE
       WHEN type IN ('SALE','ADJUSTMENT_INCREASE') THEN amount
       WHEN type IN ('PAYMENT','ADJUSTMENT_DECREASE') THEN -amount
       ELSE 0 END),0) signed_sum
     FROM debt_transactions WHERE customer_id=?`,
    [customerId]
  );
  return Number(row.signed_sum);
}

async function orderRow(orderId) {
  const [[row]] = await pool.query(`SELECT * FROM orders WHERE id=?`, [orderId]);
  return row;
}

async function paymentRow(paymentId) {
  const [[row]] = await pool.query(`SELECT * FROM payments WHERE id=?`, [paymentId]);
  return row;
}

async function main() {
  const productIds = [];
  const orderIds = [];
  const paymentIds = [];
  let customerId = null;

  try {
    // ══════════════════ F1: migration parity, asserted programmatically ══════════════════
    {
      const checks = await SchemaMigrationAgent.check();
      const required = [
        ['orders', 'is_locked'], ['orders', 'locked_at'], ['orders', 'locked_by'], ['orders', 'lock_note'],
        ['payments', 'status'], ['payments', 'is_locked'], ['payments', 'locked_at'], ['payments', 'locked_by'],
        ['payments', 'lock_note'], ['payments', 'updated_at'], ['payments', 'payment_calendar_type'], ['payments', 'payment_lunar_date_text'],
        ['payments', 'original_amount'], ['payments', 'cancelled_at'], ['payments', 'cancelled_by'], ['payments', 'cancel_reason'],
        ['supplier_purchase_payments', 'status'], ['supplier_purchase_payments', 'cancelled_at'],
      ];
      for (const [table, column] of required) {
        const row = checks.find(c => c.table === table && c.column === column);
        check(`F1: SchemaMigrationAgent.check() reports ${table}.${column} = OK`, !!row && row.status === 'OK', row);
      }
      const idxRow = checks.find(c => c.table === 'supplier_payable_transactions' && c.index_name === 'uq_supplier_payable_payment_reversal');
      check('F1: uq_supplier_payable_payment_reversal index = OK', !!idxRow && idxRow.status === 'OK', idxRow);
    }

    const [custIns] = await pool.query(
      `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type,default_sales_flow)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      [`GOLIVE-PAY-CUST-${Date.now()}`, 'GO-LIVE Payment Cancel Test Customer', '0', 'test', 'PRIVATE_PRICE', 0, 0, 'SOLAR', 'INVENTORY_SALE']
    );
    customerId = custIns.insertId;

    // ══════════════════ F5: empty/missing reason rejected before any write ══════════════════
    {
      const p = await makeProduct(50);
      productIds.push(p.id);
      const r = await OrderAgent.create({
        customer_id: customerId, order_date: today,
        items: [{ product_id: p.id, product_name: 'x', unit: 'kg', quantity: 5, sale_price: 30000, manual_price: true }],
      }, user);
      orderIds.push(r.order_id);
      const pay = await PaymentAgent.create({ customer_id: customerId, order_id: r.order_id, cash_amount: 150000, bank_amount: 0, payment_date: today }, user);
      paymentIds.push(pay.payment_id);

      let threw1 = null;
      try { await PaymentAgent.cancel(pay.payment_id, {}, user); } catch (e) { threw1 = e; }
      check('F5: missing reason rejected', !!threw1, threw1 && threw1.message);
      let threw2 = null;
      try { await PaymentAgent.cancel(pay.payment_id, { reason: '   ' }, user); } catch (e) { threw2 = e; }
      check('F5: whitespace-only reason rejected', !!threw2, threw2 && threw2.message);
      const before = await paymentRow(pay.payment_id);
      check('F5: payment untouched by rejected attempts (still ACTIVE, amount unchanged)', String(before.status || 'ACTIVE').toUpperCase() !== 'CANCELLED' && Number(before.amount) === 150000, before);
    }

    // ══════════════════ F2/F3/F4: full cancel with allocations + installment row ══════════════════
    {
      const p1 = await makeProduct(50);
      const p2 = await makeProduct(50);
      productIds.push(p1.id, p2.id);

      const r1 = await OrderAgent.create({
        customer_id: customerId, order_date: today,
        items: [{ product_id: p1.id, product_name: 'x', unit: 'kg', quantity: 5, sale_price: 40000, manual_price: true }],
      }, user);
      const r2 = await OrderAgent.create({
        customer_id: customerId, order_date: today,
        items: [{ product_id: p2.id, product_name: 'y', unit: 'kg', quantity: 3, sale_price: 50000, manual_price: true }],
      }, user);
      orderIds.push(r1.order_id, r2.order_id);
      // r1 debt = 200,000; r2 debt = 150,000. Pay 350,000 in one receipt so it
      // spans BOTH bills — proves the snapshot/delete covers multiple
      // payment_allocations rows for one payment, not just one.
      const pay = await PaymentAgent.create({
        customer_id: customerId, cash_amount: 350000, bank_amount: 0, payment_date: today,
      }, user);
      paymentIds.push(pay.payment_id);

      const [allocBefore] = await pool.query(`SELECT * FROM payment_allocations WHERE payment_id=?`, [pay.payment_id]);
      check('Setup: payment allocated across both bills (2 allocation rows)', allocBefore.length === 2, allocBefore);
      check('Setup: order r1 fully paid', Number((await orderRow(r1.order_id)).debt_amount) === 0);
      check('Setup: order r2 fully paid', Number((await orderRow(r2.order_id)).debt_amount) === 0);

      // Manually attach a debt_installment_payments row to this payment_id to
      // exercise F3's revert path — the mechanism under test is
      // revertPaymentEffects()'s snapshot+delete, independent of how the row
      // was created (full installment-plan setup is a separate feature).
      const [planIns] = await pool.query(
        `INSERT INTO debt_monthly_installments(customer_id, installment_amount, installment_month, installment_year, status)
         VALUES(?,?,?,?,'ACTIVE')`,
        [customerId, 100000, new Date().getMonth() + 1, new Date().getFullYear()]
      );
      const planId = planIns.insertId;
      await pool.query(
        `INSERT INTO debt_installment_payments(plan_id,customer_id,payment_id,payment_date,amount,payment_method,cash_amount,bank_amount,note,created_by)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
        [planId, customerId, pay.payment_id, today, 25000, 'CASH', 25000, 0, 'F3 test installment contribution', null]
      );
      const [instBefore] = await pool.query(`SELECT * FROM debt_installment_payments WHERE payment_id=?`, [pay.payment_id]);
      check('Setup: debt_installment_payments row attached to this payment', instBefore.length === 1, instBefore);

      const auditCountBefore = (await pool.query(`SELECT COUNT(*) cnt FROM audit_logs WHERE entity_type='payments' AND entity_id=?`, [pay.payment_id]))[0][0].cnt;

      const debtSumBefore = await debtLedgerSum(customerId);
      const result = await PaymentAgent.cancel(pay.payment_id, { reason: 'F2/F3/F4 test cancel' }, user);
      check('cancel() succeeds', !!result && Number(result.payment_id) === pay.payment_id, result);

      // F4: amount zeroed (backward compat) but original preserved + audit metadata set.
      const after = await paymentRow(pay.payment_id);
      check('F4: status = CANCELLED', String(after.status).toUpperCase() === 'CANCELLED', after.status);
      check('F4: amount/cash_amount/bank_amount zeroed (backward compat with SUM(amount) reports)', Number(after.amount) === 0 && Number(after.cash_amount) === 0 && Number(after.bank_amount) === 0, after);
      check('F4: original_amount preserved = 350,000', Number(after.original_amount) === 350000, after.original_amount);
      check('F4: original_cash_amount preserved = 350,000', Number(after.original_cash_amount) === 350000, after.original_cash_amount);
      check('F4: cancelled_at/cancelled_by/cancel_reason recorded', !!after.cancelled_at && after.cancel_reason === 'F2/F3/F4 test cancel', { cancelled_at: after.cancelled_at, cancel_reason: after.cancel_reason });

      // F2: allocations gone from the live table but snapshotted first.
      const [allocAfter] = await pool.query(`SELECT * FROM payment_allocations WHERE payment_id=?`, [pay.payment_id]);
      check('F2: payment_allocations rows removed from live table', allocAfter.length === 0, allocAfter);

      // F3: installment row gone.
      const [instAfter] = await pool.query(`SELECT * FROM debt_installment_payments WHERE payment_id=?`, [pay.payment_id]);
      check('F3: debt_installment_payments row removed', instAfter.length === 0, instAfter);

      // F2/F3: snapshot exists in audit_logs with both row sets intact.
      const [auditRows] = await pool.query(
        `SELECT * FROM audit_logs WHERE entity_type='payments' AND entity_id=? AND action='PAYMENT_REVERT_SNAPSHOT' ORDER BY id DESC LIMIT 1`,
        [pay.payment_id]
      );
      check('F2/F3: PAYMENT_REVERT_SNAPSHOT audit row written', auditRows.length === 1, auditRows);
      if (auditRows.length) {
        const snap = JSON.parse(auditRows[0].note);
        check('F2: snapshot preserves both payment_allocations rows', Array.isArray(snap.payment_allocations) && snap.payment_allocations.length === 2, snap.payment_allocations);
        check('F3: snapshot preserves the debt_installment_payments row (amount=25,000)', Array.isArray(snap.debt_installment_payments) && snap.debt_installment_payments.length === 1 && Number(snap.debt_installment_payments[0].amount) === 25000, snap.debt_installment_payments);
      }
      const auditCountAfter = (await pool.query(`SELECT COUNT(*) cnt FROM audit_logs WHERE entity_type='payments' AND entity_id=?`, [pay.payment_id]))[0][0].cnt;
      check('Audit row count increased by exactly one', Number(auditCountAfter) === Number(auditCountBefore) + 1, { before: auditCountBefore, after: auditCountAfter });

      // Regression: debt reinstated correctly, ledger append-only (net back to pre-payment level).
      check('Regression: order r1 debt reinstated to 200,000', Number((await orderRow(r1.order_id)).debt_amount) === 200000, (await orderRow(r1.order_id)).debt_amount);
      check('Regression: order r2 debt reinstated to 150,000', Number((await orderRow(r2.order_id)).debt_amount) === 150000, (await orderRow(r2.order_id)).debt_amount);
      check('Regression: debt ledger sum back to pre-payment level (350,000)', await debtLedgerSum(customerId) === debtSumBefore + 350000, { before: debtSumBefore, after: await debtLedgerSum(customerId) });

      // Idempotency: double-cancel rejected, no duplicate reversal/snapshot.
      let retryThrew = null;
      try { await PaymentAgent.cancel(pay.payment_id, { reason: 'retry' }, user); } catch (e) { retryThrew = e; }
      check('Idempotency: cancelling an already-CANCELLED payment is rejected', !!retryThrew, retryThrew && retryThrew.message);
      const auditCountAfterRetry = (await pool.query(`SELECT COUNT(*) cnt FROM audit_logs WHERE entity_type='payments' AND entity_id=?`, [pay.payment_id]))[0][0].cnt;
      check('Idempotency: no duplicate audit snapshot from the rejected retry', Number(auditCountAfterRetry) === Number(auditCountAfter), { after: auditCountAfter, afterRetry: auditCountAfterRetry });
      check('Idempotency: debt ledger unchanged by the rejected retry', await debtLedgerSum(customerId) === debtSumBefore + 350000);

      await pool.query(`DELETE FROM debt_monthly_installments WHERE id=?`, [planId]);
    }

    // ══════════════════ update() gets the same snapshot-before-delete treatment ══════════════════
    {
      const p = await makeProduct(50);
      productIds.push(p.id);
      const r = await OrderAgent.create({
        customer_id: customerId, order_date: today,
        items: [{ product_id: p.id, product_name: 'x', unit: 'kg', quantity: 4, sale_price: 25000, manual_price: true }],
      }, user);
      orderIds.push(r.order_id);
      const pay = await PaymentAgent.create({ customer_id: customerId, order_id: r.order_id, cash_amount: 100000, bank_amount: 0, payment_date: today }, user);
      paymentIds.push(pay.payment_id);
      const [allocBefore] = await pool.query(`SELECT * FROM payment_allocations WHERE payment_id=?`, [pay.payment_id]);
      check('update() setup: allocation exists before edit', allocBefore.length === 1, allocBefore);

      await PaymentAgent.update(pay.payment_id, { cash_amount: 100000, bank_amount: 0, payment_date: today }, user);
      const [auditRows] = await pool.query(
        `SELECT * FROM audit_logs WHERE entity_type='payments' AND entity_id=? AND action='PAYMENT_REVERT_SNAPSHOT'`,
        [pay.payment_id]
      );
      check('update(): PAYMENT_REVERT_SNAPSHOT written for the pre-edit allocation too', auditRows.length === 1, auditRows);
    }

  } finally {
    for (const pid of paymentIds) {
      await pool.query(`DELETE FROM debt_installment_payments WHERE payment_id=?`, [pid]).catch(() => {});
      await pool.query(`DELETE FROM payment_allocations WHERE payment_id=?`, [pid]).catch(() => {});
      await pool.query(`DELETE FROM payment_unapplied_credits WHERE payment_id=?`, [pid]).catch(() => {});
      await pool.query(`DELETE FROM audit_logs WHERE entity_type='payments' AND entity_id=?`, [pid]).catch(() => {});
      await pool.query(`DELETE FROM debt_transactions WHERE payment_id=?`, [pid]).catch(() => {});
      await pool.query(`DELETE FROM payments WHERE id=?`, [pid]).catch(() => {});
    }
    for (const oid of orderIds) {
      await pool.query(`DELETE FROM payment_allocations WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM order_items WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM debt_transactions WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM orders WHERE id=?`, [oid]).catch(() => {});
    }
    for (const id of productIds) {
      await pool.query(`DELETE FROM stock_transactions WHERE product_id=?`, [id]).catch(() => {});
      await pool.query(`DELETE FROM products WHERE id=?`, [id]).catch(() => {});
    }
    if (customerId) {
      await pool.query(`DELETE FROM debt_monthly_installments WHERE customer_id=?`, [customerId]).catch(() => {});
      await pool.query(`DELETE FROM debt_transactions WHERE customer_id=?`, [customerId]).catch(() => {});
      await pool.query(`DELETE FROM customer_product_catalogs WHERE customer_id=?`, [customerId]).catch(() => {});
      await pool.query(`DELETE FROM customer_product_prices WHERE customer_id=?`, [customerId]).catch(() => {});
      await pool.query(`DELETE FROM customers WHERE id=?`, [customerId]).catch(() => {});
    }
    console.log('Cleanup done.');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
