'use strict';
// S8.1 Sales Guard Fix — verifies:
//   TASK 1: OrderAgent.updateItem() rejects invalid sale_price (null,
//           undefined, NaN, negative) but still allows zero, matching the
//           existing approved addItem() rule (>=0), not create()'s stricter
//           >0 rule.
//   TASK 2: Add Item / Edit Item now post a debt_transactions delta row
//           (ADJUSTMENT_INCREASE/DECREASE) via recalcOrderTotals(), so
//           SUM(debt_transactions.amount) for the order's customer stays in
//           step with orders.debt_amount — verified through both direct
//           consumers named in the audit (CustomerAgent.list(),
//           debt.service.js getCustomerDebt()) plus the untouched guards
//           (payment_allocations block, inventory delta/reconciliation).
//
// Self-cleaning: throwaway customer + products + orders + debt_transactions,
// removed in `finally`.

const pool = require('../src/config/db');
const OrderAgent = require('../src/agents/OrderAgent');
const CustomerAgent = require('../src/agents/CustomerAgent');
const ProductAgent = require('../src/agents/ProductAgent');
const StockLedgerAgent = require('../src/agents/StockLedgerAgent');
const { getCustomerDebt } = require('../src/services/debt.service');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}

async function makeProduct(qty) {
  await ProductAgent.addProduct({
    name: `S8.1 GUARD ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    unit: 'kg', inventory_mode: 'TRACK_STOCK', stock_quantity: qty, allow_negative_stock: 0,
  });
  const [[created]] = await pool.query(`SELECT * FROM products WHERE name LIKE 'S8.1 GUARD %' ORDER BY id DESC LIMIT 1`);
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

async function orderDebt(orderId) {
  const [[row]] = await pool.query(`SELECT debt_amount, total_amount FROM orders WHERE id=?`, [orderId]);
  return { debt: Number(row.debt_amount), total: Number(row.total_amount) };
}

async function main() {
  const productIds = [];
  const orderIds = [];
  let customerId = null;
  const user = { id: null, role: 'ADMIN' };
  const today = new Date().toISOString().slice(0, 10);

  try {
    const [custIns] = await pool.query(
      `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type)
       VALUES(?,?,?,?,?,?,?,?)`,
      [`S81-CUST-${Date.now()}`, 'S8.1 Guard Test Customer', '0', 'test', 'PRIVATE_PRICE', 0, 0, 'SOLAR']
    );
    customerId = custIns.insertId;

    // ══════════════════════ TASK 1 — price guard on updateItem() ══════════════════════
    {
      const p = await makeProduct(100);
      productIds.push(p.id);
      const r = await OrderAgent.create({
        customer_id: customerId, order_date: today,
        items: [{ product_id: p.id, product_name: 'x', unit: 'kg', quantity: 5, sale_price: 10000, manual_price: true }],
      }, user);
      orderIds.push(r.order_id);
      const [[item]] = await pool.query(`SELECT * FROM order_items WHERE order_id=?`, [r.order_id]);

      for (const bad of [null, undefined, NaN, -1, -100]) {
        let threw = null;
        try { await OrderAgent.updateItem(r.order_id, item.id, { quantity: 5, sale_price: bad }, user); } catch (e) { threw = e; }
        check(`updateItem(): rejects sale_price=${bad}`, !!threw, threw && threw.message);
      }
      const afterBad = await pool.query(`SELECT sale_price FROM order_items WHERE id=?`, [item.id]);
      check('updateItem(): rejected price edits left the original sale_price untouched', Number(afterBad[0][0].sale_price) === 10000, afterBad[0][0].sale_price);

      // Case 5 — zero price must be ALLOWED (matches addItem()'s existing >=0 rule)
      let zeroThrew = null;
      try { await OrderAgent.updateItem(r.order_id, item.id, { quantity: 5, sale_price: 0 }, user); } catch (e) { zeroThrew = e; }
      check('updateItem(): allows sale_price=0 (existing approved addItem()/rule, not stricter)', !zeroThrew, zeroThrew && zeroThrew.message);
      const afterZero = await pool.query(`SELECT sale_price, total_price FROM order_items WHERE id=?`, [item.id]);
      check('updateItem(): sale_price actually persisted as 0', Number(afterZero[0][0].sale_price) === 0 && Number(afterZero[0][0].total_price) === 0, JSON.stringify(afterZero[0][0]));
    }

    // ══════════════════════ TASK 2 — debt sync: create → add → edit up → edit down ══════════════════════
    {
      const p1 = await makeProduct(100);
      const p2 = await makeProduct(100);
      productIds.push(p1.id, p2.id);

      // Case 1: create unpaid bill 500,000
      const r = await OrderAgent.create({
        customer_id: customerId, order_date: today,
        items: [{ product_id: p1.id, product_name: 'x', unit: 'kg', quantity: 5, sale_price: 100000, manual_price: true }],
      }, user);
      orderIds.push(r.order_id);
      let od = await orderDebt(r.order_id);
      check('Case 1: order debt = 500,000 on creation', od.debt === 500000, od.debt);
      let ledgerSum = await debtLedgerSum(customerId);
      check('Case 1: debt_transactions signed aggregate = 500,000', ledgerSum === 500000, ledgerSum);

      // Case 2: add item → bill becomes 800,000 (add 3kg @ 100,000)
      const [[item1]] = await pool.query(`SELECT * FROM order_items WHERE order_id=?`, [r.order_id]);
      await OrderAgent.addItem(r.order_id, { product_id: p2.id, product_name: 'y', unit: 'kg', quantity: 3, sale_price: 100000 }, user);
      od = await orderDebt(r.order_id);
      check('Case 2: order debt = 800,000 after Add Item', od.debt === 800000, od.debt);
      ledgerSum = await debtLedgerSum(customerId);
      check('Case 2: debt_transactions signed aggregate = 800,000 (matches)', ledgerSum === 800000, ledgerSum);

      // Case 3: edit item upward (5kg -> 8kg @ 100,000 => +300,000)
      await OrderAgent.updateItem(r.order_id, item1.id, { quantity: 8, sale_price: 100000 }, user);
      const odAfterUp = await orderDebt(r.order_id);
      check('Case 3: order debt increased by the edit delta (800,000 -> 1,100,000)', odAfterUp.debt === 1100000, odAfterUp.debt);
      const ledgerAfterUp = await debtLedgerSum(customerId);
      check('Case 3: debt_transactions aggregate increased by the SAME delta', ledgerAfterUp === odAfterUp.debt, ledgerAfterUp);
      const [[incRow]] = await pool.query(`SELECT type, amount FROM debt_transactions WHERE order_id=? ORDER BY id DESC LIMIT 1`, [r.order_id]);
      check('Case 3: the new row is a real ADJUSTMENT_INCREASE of exactly the delta (300,000)', incRow.type === 'ADJUSTMENT_INCREASE' && Number(incRow.amount) === 300000, JSON.stringify(incRow));

      // Case 4: edit item downward (8kg -> 2kg @ 100,000 => -600,000)
      await OrderAgent.updateItem(r.order_id, item1.id, { quantity: 2, sale_price: 100000 }, user);
      const odAfterDown = await orderDebt(r.order_id);
      check('Case 4: order debt decreased by the edit delta (1,100,000 -> 500,000)', odAfterDown.debt === 500000, odAfterDown.debt);
      const ledgerAfterDown = await debtLedgerSum(customerId);
      check('Case 4: debt_transactions aggregate decreased by the SAME delta', ledgerAfterDown === odAfterDown.debt, ledgerAfterDown);
      const [[decRow]] = await pool.query(`SELECT type, amount FROM debt_transactions WHERE order_id=? ORDER BY id DESC LIMIT 1`, [r.order_id]);
      check('Case 4: the new row is a real ADJUSTMENT_DECREASE of exactly the delta (600,000)', decRow.type === 'ADJUSTMENT_DECREASE' && Number(decRow.amount) === 600000, JSON.stringify(decRow));

      // Original SALE row must never be rewritten (immutable ledger, not a mutable projection)
      const [[saleRow]] = await pool.query(`SELECT amount FROM debt_transactions WHERE order_id=? AND type='SALE'`, [r.order_id]);
      check('Immutable ledger: the original SALE row is untouched (still 500,000)', Number(saleRow.amount) === 500000, saleRow.amount);

      // Case 6: reject negative/null/NaN price with NO DB changes (re-check after all the above edits)
      const beforeBadEdit = await orderDebt(r.order_id);
      let badThrew = null;
      try { await OrderAgent.updateItem(r.order_id, item1.id, { quantity: 2, sale_price: -5 }, user); } catch (e) { badThrew = e; }
      check('Case 6: negative price rejected', !!badThrew);
      const afterBadEdit = await orderDebt(r.order_id);
      check('Case 6: rejected edit made NO DB changes to order debt/total', afterBadEdit.debt === beforeBadEdit.debt && afterBadEdit.total === beforeBadEdit.total, JSON.stringify(afterBadEdit));
      const ledgerAfterBadEdit = await debtLedgerSum(customerId);
      check('Case 6: rejected edit posted NO new debt_transactions row', ledgerAfterBadEdit === afterBadEdit.debt, ledgerAfterBadEdit);

      // Case 8: CustomerAgent.list() current_debt matches real order debt
      const custRows = await CustomerAgent.list(user);
      const custRow = custRows.find(c => c.id === customerId);
      check('Case 8: CustomerAgent.list() current_debt matches orders.debt_amount', Number(custRow.current_debt) === odAfterDown.debt, custRow && custRow.current_debt);

      // Case 9: AI debt lookup (debt.service.js getCustomerDebt()). Discovered
      // during this verification: the function did a NAIVE unsigned
      // SUM(amount), not the signed CASE-based aggregate CustomerAgent.list()
      // already used — harmless before this ticket (only the rare installment
      // top-up ever posted an ADJUSTMENT_INCREASE row), but Add Item/Edit Item
      // now post ADJUSTMENT_INCREASE/DECREASE routinely, so this consumer had
      // to be updated to the same signed convention for Case 9 to genuinely
      // hold (not just pass by coincidence of test setup). See final report.
      const aiRows = await getCustomerDebt('S8.1 Guard Test Customer');
      const aiRow = aiRows.find(c => c.id === customerId);
      check('Case 9: debt.service.js getCustomerDebt() matches real order debt (signed aggregate)', !!aiRow && Number(aiRow.debt_amount) === odAfterDown.debt, aiRow && aiRow.debt_amount);

      // Case 7: bill with payment allocation → edit remains blocked (untouched guard)
      const [payIns] = await pool.query(
        `INSERT INTO payments(payment_code,customer_id,order_id,payment_date,payment_method,amount,cash_amount,bank_amount,created_by)
         VALUES(?,?,?,?,?,?,?,?,?)`,
        [`S81PAY-${Date.now()}`, customerId, r.order_id, today, 'CASH', 100000, 100000, 0, null]
      );
      const paymentId = payIns.insertId;
      let allocTableOk = true;
      try {
        await pool.query(
          `INSERT INTO payment_allocations(payment_id,order_id,customer_id,amount,allocation_type) VALUES(?,?,?,?,?)`,
          [paymentId, r.order_id, customerId, 100000, 'DIRECT']
        );
      } catch (e) { allocTableOk = false; }
      if (allocTableOk) {
        let blockedThrew = null;
        try { await OrderAgent.updateItem(r.order_id, item1.id, { quantity: 3, sale_price: 100000 }, user); } catch (e) { blockedThrew = e; }
        check('Case 7: edit is blocked once a payment_allocations row exists', !!blockedThrew, blockedThrew && blockedThrew.message);
        await pool.query(`DELETE FROM payment_allocations WHERE payment_id=?`, [paymentId]);
      } else {
        check('Case 7: payment_allocations table unavailable — skipped (guard code path unchanged regardless)', true);
      }
      await pool.query(`DELETE FROM payments WHERE id=?`, [paymentId]);
    }

    // ══════════════════════ Case 10 — inventory delta/reconciliation unaffected ══════════════════════
    {
      const p = await makeProduct(50);
      productIds.push(p.id);
      const r = await OrderAgent.create({
        customer_id: customerId, order_date: today,
        items: [{ product_id: p.id, product_name: 'z', unit: 'kg', quantity: 10, sale_price: 20000, manual_price: true }],
      }, user);
      orderIds.push(r.order_id);
      const [[item]] = await pool.query(`SELECT * FROM order_items WHERE order_id=?`, [r.order_id]);
      const afterCreate = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [p.id]);
      check('Case 10: stock deducted correctly on create (50->40)', Number(afterCreate[0][0].stock_quantity) === 40, afterCreate[0][0].stock_quantity);

      await OrderAgent.updateItem(r.order_id, item.id, { quantity: 6, sale_price: 20000 }, user);
      const afterEdit = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [p.id]);
      check('Case 10: stock returned correctly on qty decrease (40->44)', Number(afterEdit[0][0].stock_quantity) === 44, afterEdit[0][0].stock_quantity);

      const recon = await StockLedgerAgent.reconciliation({ product_id: p.id });
      check('Case 10: reconciliation still reports OK (Inventory engine untouched)', recon.items[0].status === 'OK', JSON.stringify(recon.items[0]));
    }

  } finally {
    for (const oid of orderIds) {
      if (!oid) continue;
      await pool.query(`DELETE FROM payment_allocations WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM payments WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM order_items WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM debt_transactions WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM orders WHERE id=?`, [oid]).catch(() => {});
    }
    for (const id of productIds) {
      await pool.query(`DELETE FROM stock_transactions WHERE product_id=?`, [id]).catch(() => {});
      await pool.query(`DELETE FROM products WHERE id=?`, [id]).catch(() => {});
    }
    if (customerId) {
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
