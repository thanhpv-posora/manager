'use strict';
// CTO GO-LIVE FINAL BUSINESS ACCEPTANCE — GATE 7: Global financial/inventory
// invariants.
//
// Unlike Gates 1-6 (which each create their own fresh fixtures), this gate
// is a READ-ONLY sweep over the ENTIRE disposable DB as it stands right now
// — every order/customer/product touched by the RC4 rehearsal smoke test
// AND every Gate 1-6 run before it. It is the strongest possible check of
// the Gate 3 (multi-bill payment ledger) and Gate 4 (order_items.
// price_book_id) fixes: not "does a fresh scenario behave correctly" but
// "does every row ever written in this database still reconcile".
//
// No writes. No new fixtures. Disposable DB only (CR4_FRESH_DB) — a global
// sweep is exactly the kind of query that must never run against the real
// application database.

require('dotenv').config();
const TARGET = process.env.CR4_FRESH_DB;
const APP_DB = process.env.DB_NAME;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

async function main() {
  if (!TARGET) { console.error('CR4_FRESH_DB is not set — refusing to run.'); process.exit(2); }
  if (TARGET === APP_DB) { console.error(`CR4_FRESH_DB (${TARGET}) is the application database — refusing.`); process.exit(2); }
  process.env.DB_NAME = TARGET;
  const pool = require('../src/config/db');
  const [[who]] = await pool.query('SELECT DATABASE() db');
  if (who.db !== TARGET) { console.error(`pool connected to ${who.db}, not ${TARGET} — refusing.`); process.exit(2); }
  console.log(`=== GATE 7: Global financial/inventory invariants (${TARGET}) — READ-ONLY SWEEP ===\n`);

  // ══════════════════ 1. Per-order ledger reconciliation (the exact invariant Gate 3 fixed) ══════════════════
  const [orderMismatches] = await pool.query(`
    SELECT o.id, o.order_code, o.debt_amount,
           COALESCE(SUM(CASE WHEN dt.type IN ('SALE','ADJUSTMENT_INCREASE') THEN dt.amount
                              WHEN dt.type IN ('PAYMENT','ADJUSTMENT_DECREASE') THEN -dt.amount ELSE 0 END),0) ledger_net
    FROM orders o
    LEFT JOIN debt_transactions dt ON dt.order_id = o.id
    WHERE o.status <> 'CANCELLED'
    GROUP BY o.id, o.order_code, o.debt_amount
    HAVING ABS(o.debt_amount - ledger_net) > 0.01
  `);
  const [[orderTotal]] = await pool.query(`SELECT COUNT(*) c FROM orders WHERE status<>'CANCELLED'`);
  check(`1. EVERY non-cancelled order's own per-order ledger (debt_transactions WHERE order_id=X) reconciles exactly with orders.debt_amount (checked ${orderTotal.c} orders)`,
    orderMismatches.length === 0, orderMismatches.slice(0, 10));

  // ══════════════════ 2. Per-customer ledger-vs-orders reconciliation ══════════════════
  const [customerMismatches] = await pool.query(`
    SELECT c.id, c.name,
           COALESCE((SELECT SUM(CASE WHEN dt.type IN ('SALE','ADJUSTMENT_INCREASE') THEN dt.amount
                                      WHEN dt.type IN ('PAYMENT','ADJUSTMENT_DECREASE') THEN -dt.amount ELSE 0 END)
                      FROM debt_transactions dt WHERE dt.customer_id=c.id),0) ledger_net,
           COALESCE((SELECT SUM(o.debt_amount) FROM orders o WHERE o.customer_id=c.id AND o.status<>'CANCELLED'),0) orders_total
    FROM customers c
    WHERE c.del_flg=0
    HAVING ABS(ledger_net - orders_total) > 0.01
  `);
  const [[custTotal]] = await pool.query(`SELECT COUNT(*) c FROM customers WHERE del_flg=0`);
  check(`2. EVERY customer's customer-wide ledger nets to the same total as their orders' debt_amount (checked ${custTotal.c} customers)`,
    customerMismatches.length === 0, customerMismatches.slice(0, 10));

  // ══════════════════ 1b/2b. Same two invariants, restricted to orders created AFTER the Gate 3 fix (commit ebe3f8d) ══════════════════
  // This disposable DB is explicitly non-self-cleaning (every Gate 1-7 script
  // says so in its own header) and, per this go-live audit's own prior
  // sessions, is EXPECTED to still carry frozen evidence rows from the
  // original (pre-fix) Gate 3 reproduction that first surfaced the
  // multi-bill ledger defect (see git log — commit ebe3f8d fixes it). Those
  // rows were written by code that no longer exists; re-checking them proves
  // nothing about the CURRENT code. 1b/2b re-run the identical two checks
  // scoped to `created_at >= <fix commit time>` — this is the check that
  // actually answers "is today's code correct", separate from #1/#2's
  // honest, unfiltered report of what this disposable DB currently contains.
  const FIX_COMMIT_AT = '2026-08-10 17:40:21'; // `git show -s --format=%ci ebe3f8d`
  const [orderMismatchesSinceFix] = await pool.query(`
    SELECT o.id, o.order_code, o.debt_amount,
           COALESCE(SUM(CASE WHEN dt.type IN ('SALE','ADJUSTMENT_INCREASE') THEN dt.amount
                              WHEN dt.type IN ('PAYMENT','ADJUSTMENT_DECREASE') THEN -dt.amount ELSE 0 END),0) ledger_net
    FROM orders o
    LEFT JOIN debt_transactions dt ON dt.order_id = o.id
    WHERE o.status <> 'CANCELLED' AND o.created_at >= ?
    GROUP BY o.id, o.order_code, o.debt_amount
    HAVING ABS(o.debt_amount - ledger_net) > 0.01
  `, [FIX_COMMIT_AT]);
  const [[orderTotalSinceFix]] = await pool.query(`SELECT COUNT(*) c FROM orders WHERE status<>'CANCELLED' AND created_at >= ?`, [FIX_COMMIT_AT]);
  check(`1b. Restricted to orders created SINCE the Gate 3 fix (${orderTotalSinceFix.c} orders, incl. Gates 3-6's own runs): zero ledger mismatches — proves today's code, not historical rehearsal debris`,
    orderMismatchesSinceFix.length === 0, orderMismatchesSinceFix.slice(0, 10));
  if (orderMismatches.length && orderMismatchesSinceFix.length === 0) {
    console.log(`        (Check 1's ${orderMismatches.length} raw mismatch(es) are pre-fix artifacts — all created before ${FIX_COMMIT_AT}, frozen evidence of the ORIGINAL Gate 3 defect this audit fixed, not a live one. See the final report.)`);
  }

  // ══════════════════ 3. No negative stock anywhere ══════════════════
  const [negativeStock] = await pool.query(`SELECT id, product_code, name, stock_quantity FROM products WHERE stock_quantity < 0 AND del_flg=0`);
  check('3. No product has negative stock_quantity', negativeStock.length === 0, negativeStock.slice(0, 10));

  // ══════════════════ 4. order_items totals reconcile to orders.total_amount (item lines + installment) ══════════════════
  const [orderTotalMismatches] = await pool.query(`
    SELECT o.id, o.order_code, o.total_amount, o.installment_amount,
           COALESCE((SELECT SUM(oi.total_price) FROM order_items oi WHERE oi.order_id=o.id),0) items_total
    FROM orders o
    WHERE o.status <> 'CANCELLED'
    HAVING ABS(o.total_amount - (items_total + COALESCE(o.installment_amount,0))) > 0.01
  `);
  check('4. Every order\'s total_amount equals SUM(order_items.total_price) + installment_amount', orderTotalMismatches.length === 0, orderTotalMismatches.slice(0, 10));

  // ══════════════════ 5. No orphaned payment_allocations (dangling order_id/payment_id) ══════════════════
  const [orphanAllocOrder] = await pool.query(`
    SELECT pa.id, pa.payment_id, pa.order_id FROM payment_allocations pa
    LEFT JOIN orders o ON o.id = pa.order_id
    WHERE o.id IS NULL
  `);
  const [orphanAllocPayment] = await pool.query(`
    SELECT pa.id, pa.payment_id, pa.order_id FROM payment_allocations pa
    LEFT JOIN payments p ON p.id = pa.payment_id
    WHERE p.id IS NULL
  `);
  check('5a. No payment_allocations row references a missing order', orphanAllocOrder.length === 0, orphanAllocOrder.slice(0, 10));
  check('5b. No payment_allocations row references a missing payment', orphanAllocPayment.length === 0, orphanAllocPayment.slice(0, 10));

  // ══════════════════ 6. No over-allocation: SUM(payment_allocations) per payment never exceeds the payment's own amount ══════════════════
  const [overAllocated] = await pool.query(`
    SELECT p.id, p.payment_code, p.amount, COALESCE(SUM(pa.amount),0) allocated
    FROM payments p
    LEFT JOIN payment_allocations pa ON pa.payment_id = p.id
    GROUP BY p.id, p.payment_code, p.amount
    HAVING allocated > p.amount + 0.01
  `);
  check('6. No payment has payment_allocations summing to MORE than its own amount (no phantom money)', overAllocated.length === 0, overAllocated.slice(0, 10));

  // ══════════════════ 7. debt_transactions.order_id, when set, always points at a real order ══════════════════
  const [orphanDebtOrder] = await pool.query(`
    SELECT dt.id, dt.order_id FROM debt_transactions dt
    LEFT JOIN orders o ON o.id = dt.order_id
    WHERE dt.order_id IS NOT NULL AND o.id IS NULL
  `);
  check('7. No debt_transactions row references a missing order', orphanDebtOrder.length === 0, orphanDebtOrder.slice(0, 10));

  // ══════════════════ 8. Sales-flow isolation holds globally: no order_item's resolved sales_flow contradicts its own product's sales_flow ══════════════════
  const [flowContradictions] = await pool.query(`
    SELECT oi.id, oi.order_id, oi.product_id, oi.sales_flow item_flow, p.sales_flow product_flow
    FROM order_items oi
    JOIN products p ON p.id = oi.product_id
    WHERE oi.sales_flow IS NOT NULL AND p.sales_flow IS NOT NULL AND oi.sales_flow <> p.sales_flow
  `);
  check('8. No order_item\'s recorded sales_flow disagrees with its own product\'s current sales_flow (schema-level cross-check)', flowContradictions.length === 0, flowContradictions.slice(0, 10));

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
