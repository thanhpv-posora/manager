'use strict';
// S1G Phase 2 — Product Sales Domain Separation: DRY-RUN migration report.
//
// READ-ONLY. Issues zero UPDATE/INSERT/DELETE statements against products or
// any other table. Its only job is to compute, from live evidence, which
// products.sales_flow value each candidate product SHOULD get, and print that
// list for CEO review — it never applies the change itself (that is a
// separate, explicitly-approved step, run only after this report has been
// reviewed).
//
// Candidate universe (exact IDs only — no name matching, no LIKE, no
// category-wide selection):
//   - Group A candidates: the exact warehouse product_ids named in the S1G
//     ticket (1, 2, 3, 75), each independently re-verified against the stock
//     ledger here rather than taken on trust.
//   - Group B candidates: every product_id that is an active line item in
//     Price Book #7 or #126 (Hồng Hiền's real books, audited earlier this
//     engagement) whose current inventory_mode is NON_STOCK or CARCASS_PART
//     (never TRACK_STOCK — those are Group A candidates instead).
//
// Classification rule (evidence-based, not assumed):
//   Group A (-> sales_flow=INVENTORY_SALE, inventory_mode stays TRACK_STOCK):
//     a named candidate with real stock_transactions AND real purchase/receive
//     history (proof of genuine warehouse procurement).
//   Group B (-> sales_flow=CARCASS_POS, inventory_mode unchanged):
//     a Book #7/#126 NON_STOCK/CARCASS_PART candidate with at least one
//     historical order_items row (proof it has actually been sold as a
//     Bò Xô product, not just present in a price book).
//   Group C (AMBIGUOUS, no UPDATE recommended):
//     any candidate that fails its group's evidence bar — e.g. a named
//     warehouse candidate with no ledger activity, or a price-book line item
//     with zero historical sales. Flagged for explicit human review rather
//     than silently defaulted either way.
const pool = require('../src/config/db');

const GROUP_A_CANDIDATE_IDS = [1, 2, 3, 75]; // exact IDs named in the S1G ticket
const BOOK_IDS = [7, 126]; // Hồng Hiền's audited real price books

async function fetchProduct(id) {
  const [[row]] = await pool.query(
    `SELECT id, product_code, name, sales_flow, inventory_mode, allow_negative_stock FROM products WHERE id=? LIMIT 1`,
    [id]
  );
  return row || null;
}

async function stockLedgerEvidence(id) {
  const [rows] = await pool.query(
    `SELECT type, reference_type, COUNT(*) c, SUM(quantity) total_qty
     FROM stock_transactions WHERE product_id=? GROUP BY type, reference_type`,
    [id]
  );
  return rows;
}

async function purchaseReceiveEvidence(id) {
  const [poi] = await pool.query(
    `SELECT COUNT(*) c, SUM(quantity) total_qty, SUM(received_quantity) total_received
     FROM purchase_order_items WHERE product_id=?`,
    [id]
  );
  const [iri] = await pool.query(
    `SELECT COUNT(*) c, SUM(actual_stock_qty) total_actual_qty
     FROM inventory_receive_items WHERE product_id=?`,
    [id]
  );
  return { purchase_order_items: poi[0], inventory_receive_items: iri[0] };
}

async function orderHistoryEvidence(id) {
  const [rows] = await pool.query(
    `SELECT o.sales_flow, COUNT(*) bill_count, COUNT(DISTINCT o.customer_id) distinct_customers,
            MIN(o.order_date) first_seen, MAX(o.order_date) last_seen
     FROM order_items oi JOIN orders o ON o.id=oi.order_id
     WHERE oi.product_id=? GROUP BY o.sales_flow`,
    [id]
  );
  return rows;
}

async function affectedPriceBooks(id) {
  const [rows] = await pool.query(
    `SELECT bi.price_book_id, b.customer_id, b.book_name, b.effective_from, b.effective_lunar_date_text, b.status
     FROM customer_price_book_items bi JOIN customer_price_books b ON b.id=bi.price_book_id
     WHERE bi.product_id=?`,
    [id]
  );
  return rows;
}

function hasRealStockActivity(ledger) {
  return ledger.some(r => r.type === 'IN' && r.reference_type === 'RECEIVE_VOUCHER');
}
function hasRealPurchaseHistory(pr) {
  return Number(pr.purchase_order_items.c || 0) > 0 && Number(pr.inventory_receive_items.c || 0) > 0;
}
function hasRealOrderHistory(hist) {
  return hist.some(r => Number(r.bill_count) > 0);
}

async function buildReport(id, { requiredEvidence }) {
  const product = await fetchProduct(id);
  if (!product) return null;
  const [ledger, po, hist, books] = await Promise.all([
    stockLedgerEvidence(id), purchaseReceiveEvidence(id), orderHistoryEvidence(id), affectedPriceBooks(id)
  ]);
  const evidence = { ledger, po, hist, books };
  let group, targetSalesFlow, targetInventoryMode, reason;

  if (requiredEvidence === 'WAREHOUSE') {
    const stockOk = hasRealStockActivity(ledger);
    const poOk = hasRealPurchaseHistory(po);
    if (stockOk && poOk) {
      group = 'A'; targetSalesFlow = 'INVENTORY_SALE'; targetInventoryMode = product.inventory_mode;
      reason = 'Real RECEIVE_VOUCHER stock_transactions AND real purchase_order_items/inventory_receive_items — genuine warehouse procurement, not a legacy carcass cut.';
    } else {
      group = 'C'; targetSalesFlow = null; targetInventoryMode = null;
      reason = `Named as a known warehouse product in the S1G ticket, but ledger evidence does not support it: stock_transactions RECEIVE_VOUCHER present=${stockOk}, purchase+receive history present=${poOk}. Flagged for explicit business confirmation rather than auto-classified.`;
    }
  } else { // BOOK_ITEM
    const orderOk = hasRealOrderHistory(hist);
    if (orderOk && ['NON_STOCK', 'CARCASS_PART'].includes(product.inventory_mode)) {
      group = 'B'; targetSalesFlow = 'CARCASS_POS'; targetInventoryMode = product.inventory_mode;
      reason = `Active line item in Price Book #7/#126 with inventory_mode=${product.inventory_mode} and at least one historical order_items row — proven Bò Xô sales history.`;
    } else {
      group = 'C'; targetSalesFlow = null; targetInventoryMode = null;
      reason = `Active line item in Price Book #7/#126 (inventory_mode=${product.inventory_mode}) but ${orderOk ? 'inventory_mode is not NON_STOCK/CARCASS_PART' : 'zero historical order_items rows found — never actually sold'}. Flagged for explicit business confirmation rather than auto-classified.`;
    }
  }

  return {
    product_id: product.id,
    product_code: product.product_code,
    product_name: product.name,
    current_sales_flow: product.sales_flow,
    target_sales_flow: targetSalesFlow,
    current_inventory_mode: product.inventory_mode,
    target_inventory_mode: targetInventoryMode,
    group,
    reason,
    evidence: {
      stock_ledger: ledger,
      purchase_receive: po,
      historical_orders: hist,
      affected_price_books: books
    }
  };
}

async function main() {
  console.log('S1G Phase 2 — Product Sales Domain Separation: DRY-RUN migration report');
  console.log('READ-ONLY. No UPDATE/INSERT/DELETE issued by this script.\n');

  const results = { A: [], B: [], C: [] };
  const seen = new Set();

  // ---- Group A candidates: exact IDs named in the ticket ----
  for (const id of GROUP_A_CANDIDATE_IDS) {
    const r = await buildReport(id, { requiredEvidence: 'WAREHOUSE' });
    if (!r) { console.log(`  [SKIP] product_id=${id} not found in products table`); continue; }
    seen.add(id);
    results[r.group].push(r);
  }

  // ---- Group B candidates: every distinct product_id in Book #7/#126, excluding Group A ids and TRACK_STOCK ----
  const [bookItems] = await pool.query(
    `SELECT DISTINCT bi.product_id FROM customer_price_book_items bi WHERE bi.price_book_id IN (?)`,
    [BOOK_IDS]
  );
  for (const row of bookItems) {
    const id = Number(row.product_id);
    if (seen.has(id)) continue; // already classified as a Group A candidate
    const product = await fetchProduct(id);
    if (!product) continue;
    if (product.inventory_mode === 'TRACK_STOCK') continue; // not a Book #7/#126 CARCASS_POS candidate at all — a real TRACK_STOCK item not in the named Group A list; report separately, do not silently fold into B
    seen.add(id);
    const r = await buildReport(id, { requiredEvidence: 'BOOK_ITEM' });
    results[r.group].push(r);
  }

  // ---- Any TRACK_STOCK item in Book #7/#126 that ISN'T one of the named Group A ids — report as its own C entry, never silently included ----
  for (const row of bookItems) {
    const id = Number(row.product_id);
    if (GROUP_A_CANDIDATE_IDS.includes(id)) continue;
    const product = await fetchProduct(id);
    if (!product || product.inventory_mode !== 'TRACK_STOCK') continue;
    const r = await buildReport(id, { requiredEvidence: 'WAREHOUSE' });
    r.reason = `TRACK_STOCK item found in Book #7/#126 but NOT in the ticket's named Group A id list (${GROUP_A_CANDIDATE_IDS.join(',')}). Not auto-classified — exact-ID-only rule means this needs explicit review before any migration decision.`;
    r.group = 'C'; r.target_sales_flow = null; r.target_inventory_mode = null;
    results.C.push(r);
  }

  for (const group of ['A', 'B', 'C']) {
    console.log(`\n${'='.repeat(60)}\nGROUP ${group} (${group === 'A' ? 'INVENTORY_SALE' : group === 'B' ? 'CARCASS_POS' : 'AMBIGUOUS — NO UPDATE'}) — ${results[group].length} product(s)\n${'='.repeat(60)}`);
    for (const r of results[group]) {
      console.log(`\nproduct_id=${r.product_id}  code=${r.product_code}  name="${r.product_name}"`);
      console.log(`  current_sales_flow=${r.current_sales_flow}  -> target_sales_flow=${r.target_sales_flow}`);
      console.log(`  current_inventory_mode=${r.current_inventory_mode}  -> target_inventory_mode=${r.target_inventory_mode}`);
      console.log(`  reason: ${r.reason}`);
      console.log(`  stock_ledger: ${JSON.stringify(r.evidence.stock_ledger)}`);
      console.log(`  purchase/receive: ${JSON.stringify(r.evidence.purchase_receive)}`);
      console.log(`  historical_orders: ${JSON.stringify(r.evidence.historical_orders)}`);
      console.log(`  affected_price_books: ${JSON.stringify(r.evidence.affected_price_books)}`);
    }
  }

  console.log(`\n${'='.repeat(60)}\nSUMMARY\n${'='.repeat(60)}`);
  console.log(`Group A (INVENTORY_SALE, keep inventory_mode): ${results.A.map(r => r.product_id).join(', ') || '(none)'}`);
  console.log(`Group B (CARCASS_POS, keep inventory_mode): ${results.B.map(r => r.product_id).join(', ') || '(none)'}`);
  console.log(`Group C (AMBIGUOUS, no UPDATE): ${results.C.map(r => r.product_id).join(', ') || '(none)'}`);
  console.log(`\nThis report proposes NO changes. Real migration requires explicit CEO approval of the exact product_id list above, then a single reviewed DB transaction (a separate, later script) — never this script.`);
}

main().then(() => process.exit(0)).catch(e => { console.error('FATAL', e); process.exit(1); });
