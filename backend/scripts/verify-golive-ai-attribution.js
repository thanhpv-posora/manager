'use strict';
// GO-LIVE F-AI-ATTRIBUTION — verifies the AI/OCR confirm-draft and AI-payment
// paths (Flow 5: OCR -> AI -> Order Draft -> Confirm -> Inventory -> Payment)
// now attribute every write to the REAL authenticated caller instead of
// silently discarding it (order.service.js confirmOrderDraft() hardcoded
// created_by=null on orders/payments/debt_transactions and user_id=null on
// the inventory write; aiPayment.agent.js hardcoded a synthetic
// { id: null, role: 'ADMIN' } regardless of who actually called the route).
//
// Same convention as the other verify-golive-*.js scripts: real pool,
// self-cleaning, pass/fail counters, no external test framework.
//
// Scenario numbering matches the GO-LIVE FLOW 5 finalize task 1:1:
//   1. confirmOrderDraft(payload, STAFF) -> orders.created_by = STAFF id
//   2. inventory movement from the confirmed draft -> stock_transactions.created_by = STAFF id
//   3. SALE debt transaction -> debt_transactions.created_by = STAFF id
//   4. payment-producing AI path (WALK_IN policy pays at confirm time) -> payments.created_by = STAFF id
//   5. PAYMENT debt transaction from that same path -> debt_transactions.created_by = STAFF id
//   6. AI payment route/service (aiPayment.agent.js -> aiPayment.service.js -> PaymentAgent) -> real caller preserved
//   7. Legacy direct call with no user -> does not crash, created_by stays NULL
//   8. Cleanup -> zero residue, asserted (not just attempted)

const pool = require('../src/config/db');
const { confirmOrderDraft } = require('../src/services/order.service');
const aiPaymentService = require('../src/services/aiPayment.service');
const ProductAgent = require('../src/agents/ProductAgent');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

async function makeProduct(qty) {
  const name = `GOLIVE-AI-ATTR ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await ProductAgent.addProduct({
    name, unit: 'kg', inventory_mode: 'TRACK_STOCK', sales_flow: 'INVENTORY_SALE',
    stock_quantity: qty, allow_negative_stock: 0, default_sale_price: 50000,
  });
  const [[created]] = await pool.query(`SELECT * FROM products WHERE name=? LIMIT 1`, [name]);
  return created;
}

async function main() {
  const productIds = [];
  const orderIds = [];
  const customerIds = [];
  const today = new Date().toISOString().slice(0, 10);

  try {
    // A real, existing STAFF user (not ADMIN) — proves the fix doesn't just
    // still work for a hardcoded ADMIN, and that the actual role/id passed
    // through is honored, not silently rewritten to ADMIN. orders.created_by
    // has a live FK to users(id), so this must be a real row, not a made-up id.
    const [[realStaff]] = await pool.query(`SELECT id, role FROM users WHERE role='STAFF' ORDER BY id ASC LIMIT 1`);
    if (!realStaff) throw new Error('No STAFF user exists in this DB to run the attribution test against');
    const staffUser = { id: realStaff.id, role: 'STAFF', full_name: 'GoLive Attribution Test' };

    // ══════════════════ Scenarios 1-3: REGULAR customer, debt-only bill ══════════════════
    // customerPolicyService classifies this customer REGULAR (default policy —
    // name contains none of the WALK_IN trigger words), so confirmOrderDraft()
    // correctly creates a debt-only bill by existing business rule (regular
    // customers get a bill first, payment is recorded separately via the
    // Payment/Collection screen). That is the correct behavior to test
    // orders/inventory/SALE-debt attribution against — the payment-producing
    // path (4-5) needs the OTHER existing policy (WALK_IN), tested separately
    // below, not a business-rule change to force a payment here.
    let regularCustomerId;
    {
      const [custIns] = await pool.query(
        `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type,default_sales_flow)
         VALUES(?,?,?,?,?,?,?,?,?)`,
        [`GLAA-REG-${Date.now()}`, 'GO-LIVE AI Attribution Regular Customer', '0', 'test', 'PRIVATE_PRICE', 0, 0, 'SOLAR', 'INVENTORY_SALE']
      );
      regularCustomerId = custIns.insertId;
      customerIds.push(regularCustomerId);

      const p = await makeProduct(50);
      productIds.push(p.id);

      const result = await confirmOrderDraft({
        customer: { id: regularCustomerId },
        items: [{ product_id: p.id, product_name: p.name, unit: 'kg', quantity: 4 }],
        bill_date: today,
      }, staffUser);
      orderIds.push(result.order_id);

      // 1. orders.created_by
      const [[orderRow]] = await pool.query(`SELECT created_by FROM orders WHERE id=?`, [result.order_id]);
      check('1. orders.created_by = the real authenticated STAFF id (not null)', Number(orderRow.created_by) === staffUser.id, orderRow);

      // 3. SALE debt_transactions.created_by
      const [debtRows] = await pool.query(`SELECT type, created_by FROM debt_transactions WHERE order_id=? ORDER BY id ASC`, [result.order_id]);
      check('3. debt_transactions: SALE row exists', debtRows.some(r => r.type === 'SALE'), debtRows);
      check('3. debt_transactions: SALE row created_by = the real authenticated STAFF id', debtRows.filter(r => r.type === 'SALE').every(r => Number(r.created_by) === staffUser.id), debtRows);

      // 2. inventory movement (stock_transactions) attribution
      const [[stockRow]] = await pool.query(
        `SELECT created_by FROM stock_transactions WHERE reference_type='SALE' AND reference_id=? AND product_id=? LIMIT 1`,
        [result.order_id, p.id]
      );
      check('2. stock_transactions.created_by = the real authenticated STAFF id (not null)', !!stockRow && Number(stockRow.created_by) === staffUser.id, stockRow);
    }

    // ══════════════════ Scenarios 4-5: WALK_IN customer, paid at confirm time ══════════════════
    // Uses the EXISTING WALK_IN policy (customerPolicy.service.js classifies by
    // name — "khach vang lai"/"khach le" etc.), the correct way this codebase
    // already makes confirmOrderDraft() take its OWN internal payment-creation
    // branch (paidAmount > 0 -> inserts payments + a PAYMENT debt_transactions
    // row), rather than inventing a new business rule to force a payment.
    {
      const [custIns] = await pool.query(
        `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type,default_sales_flow)
         VALUES(?,?,?,?,?,?,?,?,?)`,
        [`GLAA-WALKIN-${Date.now()}`, 'Khach vang lai GoLive Attribution Test', '0', 'test', 'PRIVATE_PRICE', 0, 0, 'SOLAR', 'INVENTORY_SALE']
      );
      const walkInCustomerId = custIns.insertId;
      customerIds.push(walkInCustomerId);

      const p2 = await makeProduct(50);
      productIds.push(p2.id);
      const totalAmount = 3 * 50000; // 150,000

      const result = await confirmOrderDraft({
        customer: { id: walkInCustomerId },
        items: [{ product_id: p2.id, product_name: p2.name, unit: 'kg', quantity: 3 }],
        bill_date: today,
        cash_amount: totalAmount, // paid in full at confirm time -> exercises the internal payment branch
      }, staffUser);
      orderIds.push(result.order_id);

      check('4/5 setup: WALK_IN policy paid the bill in full at confirm time (debt_amount=0)', Number(result.debt_amount) === 0, result);

      // 4. payments.created_by
      const [[paymentRow]] = await pool.query(`SELECT created_by, amount FROM payments WHERE order_id=? LIMIT 1`, [result.order_id]);
      check('4. confirmOrderDraft() created a payments row for the WALK_IN policy path', !!paymentRow, paymentRow);
      check('4. payments.created_by = the real authenticated STAFF id (not null)', !!paymentRow && Number(paymentRow.created_by) === staffUser.id, paymentRow);

      // 5. PAYMENT debt_transactions.created_by
      const [debtRows2] = await pool.query(`SELECT type, created_by FROM debt_transactions WHERE order_id=? ORDER BY id ASC`, [result.order_id]);
      check('5. debt_transactions: PAYMENT row exists for the WALK_IN policy path', debtRows2.some(r => r.type === 'PAYMENT'), debtRows2);
      check('5. debt_transactions: PAYMENT row created_by = the real authenticated STAFF id', debtRows2.filter(r => r.type === 'PAYMENT').every(r => Number(r.created_by) === staffUser.id), debtRows2);
    }

    // ══════════════════ Scenario 6: AI payment route/service (aiPayment.agent.js's fix) ══════════════════
    // Exercises the exact call graph aiPayment.agent.js's route handler now
    // feeds req.user into: createPaymentFromMessage() -> confirmPaymentFromPreview()
    // -> PaymentAgent.create(). parsePaymentMessage() is a deterministic regex
    // parser (no LLM call), so this is fully offline/repeatable.
    {
      const p3 = await makeProduct(50);
      productIds.push(p3.id);
      const orderResult = await confirmOrderDraft({
        customer: { id: regularCustomerId },
        items: [{ product_id: p3.id, product_name: p3.name, unit: 'kg', quantity: 5 }],
        bill_date: today,
      }, staffUser); // 250,000 debt bill, unpaid (REGULAR policy)
      orderIds.push(orderResult.order_id);

      const [[customerRow]] = await pool.query(`SELECT name FROM customers WHERE id=?`, [regularCustomerId]);
      const message = `${customerRow.name} tra 250000`;
      const outcome = await aiPaymentService.createPaymentFromMessage(message, { confirm: true, user: staffUser });

      check('6. AI-chat payment: confirmed result present', !!outcome.confirmed?.result?.payment_id, outcome.confirmed);
      const paymentId = outcome.confirmed.result.payment_id;
      const [[aiPaymentRow]] = await pool.query(`SELECT created_by FROM payments WHERE id=?`, [paymentId]);
      check('6. AI payment route/service: payments.created_by = the real authenticated caller (not a hardcoded ADMIN placeholder)', Number(aiPaymentRow.created_by) === staffUser.id, aiPaymentRow);
    }

    // ══════════════════ Scenario 7: legacy direct call, no user ══════════════════
    {
      const p4 = await makeProduct(50);
      productIds.push(p4.id);
      const result = await confirmOrderDraft({
        customer: { id: regularCustomerId },
        items: [{ product_id: p4.id, product_name: p4.name, unit: 'kg', quantity: 2 }],
        bill_date: today,
      }); // no user arg at all — must default gracefully, same as before the fix
      orderIds.push(result.order_id);
      const [[orderRow]] = await pool.query(`SELECT created_by FROM orders WHERE id=?`, [result.order_id]);
      check('7. confirmOrderDraft() with no user arg still succeeds (backward compatible, no crash)', !!result.order_id, result);
      check('7. ...and created_by is NULL in that case (no authenticated caller to attribute to)', orderRow.created_by === null, orderRow);
    }

  } finally {
    console.log('\nCleaning up...');
    for (const cid of customerIds) {
      const [customerPayments] = await pool.query(`SELECT id FROM payments WHERE customer_id=?`, [cid]).catch(() => [[]]);
      for (const p of (customerPayments || [])) {
        // debt_transactions.payment_id carries a live FK to payments.id
        // (debt_transactions_ibfk_3, not in bootstrap.js — one of the known
        // "37 live FKs created by no code path") — must be cleared before the
        // payment row itself, or the DELETE below fails silently (caught) and
        // leaves both the payment AND the customer (payments_ibfk_1) behind.
        await pool.query(`DELETE FROM debt_transactions WHERE payment_id=?`, [p.id]).catch(() => {});
        await pool.query(`DELETE FROM payment_allocations WHERE payment_id=?`, [p.id]).catch(() => {});
        await pool.query(`DELETE FROM payments WHERE id=?`, [p.id]).catch(() => {});
      }
    }
    for (const oid of orderIds) {
      // Same debt_transactions.payment_id -> payments.id FK as above: clear by
      // payment_id (not just order_id) before deleting the payments row itself.
      const [orderPayments] = await pool.query(`SELECT id FROM payments WHERE order_id=?`, [oid]).catch(() => [[]]);
      for (const p of (orderPayments || [])) {
        await pool.query(`DELETE FROM debt_transactions WHERE payment_id=?`, [p.id]).catch(() => {});
      }
      await pool.query(`DELETE FROM payment_allocations WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM order_items WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM debt_transactions WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM payments WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM stock_transactions WHERE reference_type='SALE' AND reference_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM orders WHERE id=?`, [oid]).catch(() => {});
    }
    for (const id of productIds) {
      await pool.query(`DELETE FROM stock_transactions WHERE product_id=?`, [id]).catch(() => {});
      await pool.query(`DELETE FROM products WHERE id=?`, [id]).catch(() => {});
    }
    for (const cid of customerIds) {
      await pool.query(`DELETE FROM debt_transactions WHERE customer_id=?`, [cid]).catch(() => {});
      await pool.query(`DELETE FROM customer_product_catalogs WHERE customer_id=?`, [cid]).catch(() => {});
      await pool.query(`DELETE FROM customer_product_prices WHERE customer_id=?`, [cid]).catch(() => {});
      await pool.query(`DELETE FROM customers WHERE id=?`, [cid]).catch(() => {});
    }
    console.log('Cleanup done.');

    // 8. Cleanup verification — assert zero residue, don't just attempt it.
    console.log('\nVerifying zero residue...');
    if (customerIds.length) {
      const [[custLeft]] = await pool.query(`SELECT COUNT(*) cnt FROM customers WHERE id IN (?)`, [customerIds]);
      check('8. zero test customers remain', Number(custLeft.cnt) === 0, custLeft);
    }
    if (orderIds.length) {
      const [[ordersLeft]] = await pool.query(`SELECT COUNT(*) cnt FROM orders WHERE id IN (?)`, [orderIds]);
      check('8. zero test orders remain', Number(ordersLeft.cnt) === 0, ordersLeft);
      const [[itemsLeft]] = await pool.query(`SELECT COUNT(*) cnt FROM order_items WHERE order_id IN (?)`, [orderIds]);
      check('8. zero test order_items remain', Number(itemsLeft.cnt) === 0, itemsLeft);
      const [[debtLeft]] = await pool.query(`SELECT COUNT(*) cnt FROM debt_transactions WHERE order_id IN (?)`, [orderIds]);
      check('8. zero test debt_transactions remain', Number(debtLeft.cnt) === 0, debtLeft);
      const [[paymentsLeft]] = await pool.query(`SELECT COUNT(*) cnt FROM payments WHERE order_id IN (?)`, [orderIds]);
      check('8. zero test payments (order-linked) remain', Number(paymentsLeft.cnt) === 0, paymentsLeft);
      const [[allocLeft]] = await pool.query(`SELECT COUNT(*) cnt FROM payment_allocations WHERE order_id IN (?)`, [orderIds]);
      check('8. zero test payment_allocations remain', Number(allocLeft.cnt) === 0, allocLeft);
      const [[stockLeft]] = await pool.query(`SELECT COUNT(*) cnt FROM stock_transactions WHERE reference_type='SALE' AND reference_id IN (?)`, [orderIds]);
      check('8. zero test stock_transactions remain', Number(stockLeft.cnt) === 0, stockLeft);
    }
    if (productIds.length) {
      const [[prodLeft]] = await pool.query(`SELECT COUNT(*) cnt FROM products WHERE id IN (?)`, [productIds]);
      check('8. zero test products remain', Number(prodLeft.cnt) === 0, prodLeft);
    }
    // The AI-chat payment (scenario 6) is not order-linked (generic customer
    // payment) — verify by customer_id instead, now that customers themselves
    // are already gone (a leftover payment would violate the customers FK and
    // this query would simply find none, but check explicitly for clarity).
    if (customerIds.length) {
      const [[custPaymentsLeft]] = await pool.query(`SELECT COUNT(*) cnt FROM payments WHERE customer_id IN (?)`, [customerIds]);
      check('8. zero test payments (customer-linked, incl. AI-chat payment) remain', Number(custPaymentsLeft.cnt) === 0, custPaymentsLeft);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
