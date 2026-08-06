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
  let customerId = null;
  const today = new Date().toISOString().slice(0, 10);

  try {
    // A real, existing STAFF user (not ADMIN) — proves the fix doesn't just
    // still work for a hardcoded ADMIN, and that the actual role/id passed
    // through is honored, not silently rewritten to ADMIN. orders.created_by
    // has a live FK to users(id), so this must be a real row, not a made-up id.
    const [[realStaff]] = await pool.query(`SELECT id, role FROM users WHERE role='STAFF' ORDER BY id ASC LIMIT 1`);
    if (!realStaff) throw new Error('No STAFF user exists in this DB to run the attribution test against');
    const staffUser = { id: realStaff.id, role: 'STAFF', full_name: 'GoLive Attribution Test' };

    const [custIns] = await pool.query(
      `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type,default_sales_flow)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      [`GLAA-CUST-${Date.now()}`, 'GO-LIVE AI Attribution Test Customer', '0', 'test', 'PRIVATE_PRICE', 0, 0, 'SOLAR', 'INVENTORY_SALE']
    );
    customerId = custIns.insertId;

    // ══════════════════ confirmOrderDraft(): orders/order_items(inventory)/debt attribution ══════════════════
    // Note: this test customer resolves to customer_payment_type=REGULAR (the
    // default policy — see customerPolicyService), so confirmOrderDraft()
    // deliberately zeroes any cash_amount passed in and creates a debt-only
    // bill (business rule: regular customers get a debt bill, payment is
    // recorded separately via the Payment/Collection screen) — no payments
    // row or PAYMENT debt_transactions row is expected here BY DESIGN. That
    // side of the fix (payments.created_by) is covered by the AI-chat
    // payment scenario below instead, which goes through the real
    // confirmPaymentFromPreview() -> PaymentAgent.create() path.
    {
      const p = await makeProduct(50);
      productIds.push(p.id);

      const result = await confirmOrderDraft({
        customer: { id: customerId },
        items: [{ product_id: p.id, product_name: p.name, unit: 'kg', quantity: 4 }],
        bill_date: today,
      }, staffUser);
      orderIds.push(result.order_id);

      const [[orderRow]] = await pool.query(`SELECT created_by FROM orders WHERE id=?`, [result.order_id]);
      check('orders.created_by = the real authenticated user (not null)', Number(orderRow.created_by) === staffUser.id, orderRow);

      const [debtRows] = await pool.query(`SELECT type, created_by FROM debt_transactions WHERE order_id=? ORDER BY id ASC`, [result.order_id]);
      check('debt_transactions: SALE row exists', debtRows.some(r => r.type === 'SALE'), debtRows);
      check('debt_transactions: every row attributed to the real authenticated user (none null)', debtRows.length > 0 && debtRows.every(r => Number(r.created_by) === staffUser.id), debtRows);

      const [[stockRow]] = await pool.query(
        `SELECT created_by FROM stock_transactions WHERE reference_type='SALE' AND reference_id=? AND product_id=? LIMIT 1`,
        [result.order_id, p.id]
      );
      check('stock_transactions.created_by = the real authenticated user (not null)', !!stockRow && Number(stockRow.created_by) === staffUser.id, stockRow);
    }

    // ══════════════════ confirmOrderDraft(): backward-compatible caller with NO user (must not throw) ══════════════════
    {
      const p2 = await makeProduct(50);
      productIds.push(p2.id);
      const result = await confirmOrderDraft({
        customer: { id: customerId },
        items: [{ product_id: p2.id, product_name: p2.name, unit: 'kg', quantity: 2 }],
        bill_date: today,
      }); // no user arg at all — must default gracefully, same as before the fix
      orderIds.push(result.order_id);
      const [[orderRow]] = await pool.query(`SELECT created_by FROM orders WHERE id=?`, [result.order_id]);
      check('confirmOrderDraft() with no user arg still succeeds (backward compatible)', !!result.order_id, result);
      check('...and created_by is NULL in that case (no user to attribute to, not a crash)', orderRow.created_by === null, orderRow);
    }

    // ══════════════════ aiPayment.service.js: full AI-chat payment attribution ══════════════════
    // Exercises the exact call graph aiPayment.agent.js's route handler now
    // feeds req.user into: createPaymentFromMessage() -> confirmPaymentFromPreview()
    // -> PaymentAgent.create(). parsePaymentMessage() is a deterministic regex
    // parser (no LLM call), so this is fully offline/repeatable.
    {
      const p3 = await makeProduct(50);
      productIds.push(p3.id);
      const orderResult = await confirmOrderDraft({
        customer: { id: customerId },
        items: [{ product_id: p3.id, product_name: p3.name, unit: 'kg', quantity: 5 }],
        bill_date: today,
      }, staffUser); // 250,000 debt bill, unpaid
      orderIds.push(orderResult.order_id);

      const [[customerRow]] = await pool.query(`SELECT name FROM customers WHERE id=?`, [customerId]);
      const message = `${customerRow.name} tra 250000`;
      const outcome = await aiPaymentService.createPaymentFromMessage(message, { confirm: true, user: staffUser });

      check('AI-chat payment: confirmed result present', !!outcome.confirmed?.result?.payment_id, outcome.confirmed);
      const paymentId = outcome.confirmed.result.payment_id;
      const [[aiPaymentRow]] = await pool.query(`SELECT created_by FROM payments WHERE id=?`, [paymentId]);
      check('AI-chat payment: payments.created_by = the real authenticated user (not null, not a hardcoded ADMIN placeholder)', Number(aiPaymentRow.created_by) === staffUser.id, aiPaymentRow);
    }

  } finally {
    console.log('\nCleaning up...');
    if (customerId) {
      // The AI-chat payment (confirmPaymentFromPreview -> PaymentAgent.create)
      // is a generic customer payment, not linked via payments.order_id — must
      // be cleaned by customer_id, not just by the orderIds loop below.
      const [customerPayments] = await pool.query(`SELECT id FROM payments WHERE customer_id=?`, [customerId]).catch(() => [[]]);
      for (const p of (customerPayments || [])) {
        await pool.query(`DELETE FROM payment_allocations WHERE payment_id=?`, [p.id]).catch(() => {});
        await pool.query(`DELETE FROM payments WHERE id=?`, [p.id]).catch(() => {});
      }
    }
    for (const oid of orderIds) {
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
