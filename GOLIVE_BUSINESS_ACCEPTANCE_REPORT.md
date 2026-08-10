# MeatBiz V6.65 — CTO Go-Live Final Business Acceptance Report

**Date:** 2026-08-10
**Scope:** Gates 1-7, CTO-defined Business Acceptance sequence, run against the
disposable rehearsal database `meatbiz_cr4_rehearsal` (never against
`meat_business_db`, the live application database).
**Method:** Each gate is a scripted, live-execution verification
(`backend/scripts/verify-business-gate*.js`) run against real agent code —
no source reading in lieu of execution, no simulated results. Two gates
(3 and 4) hit real, confirmed defects; both were stopped on, fixed under
explicit CTO authorization, verified, committed, and pushed before resuming.

## Verdict: **PASS — ready to proceed past Gate 7**

All 7 gates are green on the code as committed at HEAD (`479d8f1`). Two real
defects were found and fixed during this pass, both scoped and mechanical
fixes (no business-rule redesign). One historical-data caveat is documented
in Gate 7 and does not affect the verdict (see below).

## Gate-by-gate summary

| Gate | Scope | Result | Checks |
|---|---|---|---|
| 1 | Bò Xô / CARCASS_POS isolation | PASS | 21/21 |
| 2 | Solar/Lunar billing + historical immutability | PASS | 15/15 |
| 3 | Góp nợ (debt installment) matrix | **STOPPED → FIXED → PASS** | 24/24 (+ 3/5 repro informational) |
| 4 | Customer Price Book — effective by date | **BLOCKED → FIXED → PASS** | 23/23 |
| 5 | Combined customer matrix (calendar × góp nợ × price × flow) | PASS | 34/34 |
| 6 | Cross-flow negative / security tests | PASS | 14/14 |
| 7 | Global financial/inventory invariants | PASS* | 8/10 raw, 1b clean (0/40 since fix) |

\* See "Gate 7 caveat" below — the 2 raw failures are proven pre-fix historical
artifacts in the disposable DB, not a live defect.

## Defect 1 — Multi-bill payment ledger misattribution (Gate 3)

**Root cause:** `PaymentAgent.create()` posted a single lump `PAYMENT` row to
`debt_transactions` for the FULL payment amount, tied entirely to the
client-targeted `order_id` — even when `allocateCustomerOpenBillsByDate()`
had actually split the money across multiple bills (oldest-debt-first
auto-allocation, an existing, correct feature). `payment_allocations`
already recorded the true per-order split; the debt ledger didn't match it.

**Impact:** The receiving order's own per-order ledger (`_ledgerDebtForOrder`
— the source of truth `applyPaymentToOrder()`/`ensureOrderPayableTotal()`
both read) absorbed the WHOLE payment even when only part of it applied
there, while every OTHER bill the same payment paid down got no `PAYMENT`
row at all. A later góp nợ payment made specifically against that other,
genuinely fully-paid bill then re-derived its debt from the ledger and
**wrongly resurrected it** — a customer who had already paid off a bill via
cross-bill allocation could be shown as owing that money again.

**Fix (commit `ebe3f8d`):** Post one `PAYMENT` row per real allocation (same
`order_id`/amount as its `payment_allocations` row), plus one `order_id=NULL`
row for any leftover parked as unapplied credit — same customer-level total
as before, correct per-order split now. `reverseDebtLedgerForPayment()`
updated to match: nets each `order_id` to zero individually on cancel/edit
instead of one customer-level compensating row.

**Verification:** Focused repro script proved the exact resurrection
scenario no longer occurs; `verify-business-gate3-installment.js` (was
failing on "Ledger reconciles for bill 1 (fully paid)") now 24/24. Full
regression sweep (payment idempotency, payment cancel, sales-return debt
reversal, AI attribution, order cancel, order quantity/inventory) all green.

## Defect 2 — `order_items.price_book_id` missing from `bootstrap.js` (Gate 4)

**Root cause:** `order_items.price_book_id` is live in production
(`meat_business_db`: `bigint DEFAULT NULL`, no FK — confirmed via
`SHOW CREATE TABLE`) but was never captured in `bootstrap.js` — no base
`CREATE TABLE` column, no `safeAddColumn` migration anywhere, despite
`sales_flow`/`customer_price_category_id` on the same table both being
migrated. Same class of bootstrap-vs-live schema drift as the
`purchase_orders.order_date` gap fixed under GO-LIVE BLOCKER 3
(commit `b6c79eb`, 2026-08-10 earlier the same day).

**Impact:** On a fresh install, `OrderAgent.create()`/`addItem()`'s INSERT
into `order_items(...,price_book_id,...)` fails with `ER_BAD_FIELD_ERROR`
and silently falls back to a narrower legacy INSERT (the code's own
"Backward compatibility if production DB has not run V65.44.1 migration
yet" catch block) that drops `price_book_id`, `sales_flow`, and
`customer_price_category_id` entirely, downgrading
`price_type: PRICE_BOOK → PRIVATE_PRICE`. `sale_price` itself stayed
correct, but which price-book version priced a line became unrecoverable,
and `PriceMatrixAgent`'s book-management paths (`deleteBook`'s paid-bill
guard, `recalcUnpaidOrdersForBook`, `listBooks` usage counts) all filter
`order_items` by `price_book_id` — silently no-op without it.

**Fix (commit `ced0e7f`):** Added the missing `safeAddColumn('order_items',
'price_book_id', 'BIGINT NULL')` migration, matching the live type exactly.
Idempotent/additive — a no-op on `meat_business_db` (already has the
column), applies cleanly on any fresh install.

**Verification:** Applied to `meatbiz_cr4_rehearsal` only;
`SchemaMigrationAgent.check()` 67/67 OK after; `npm run check` clean against
both databases. `verify-business-gate4-price-book.js`: 23/23 (V1/V2/V3
effective-by-date resolution, historical bill immutability across later
versions, no-price-book COMMON_PRICE fallback, one/multiple price
categories + default category reassignment, MANUAL_PRICE override,
`copyBook()`, and sales-flow isolation surviving a COMMON_PRICE fallback
with no `price_book_id` at all).

## Gate 4 note — "Import Excel pricing path": not implemented

Per the gate's own instruction ("if currently supported"), this was checked
against the real codebase before testing anything: no dedicated Excel-import
backend endpoint exists anywhere (`OrderImportAgent.js` is an empty,
unimplemented stub; the only Excel-shaped feature found is the in-browser
"Excel-like grid" price-matrix editor, a UI metaphor, not a file import).
Reported as N/A in Gate 4 rather than fabricating a pass/fail for a feature
that doesn't exist.

## Gate 7 caveat — pre-fix historical debris in the disposable DB, not a live defect

The global sweep (checks 1 and 2) found 3 orders / 2 customer aggregates
with real ledger-vs-`debt_amount` mismatches in `meatbiz_cr4_rehearsal`.
Traced conclusively to the **original, pre-fix** Gate 3 reproduction run
(the one that caused Gate 3 to STOP at the start of this session) — this
disposable DB is explicitly non-self-cleaning by every gate script's own
documented convention, so that evidence is still sitting in it.

Proof this is historical, not live: every one of the 3 mismatched orders'
`created_at` predates the Gate 3 fix commit (`ebe3f8d`, 2026-08-10
17:40:21 +07); a check restricted to `created_at >= <fix commit time>`
(40 orders, spanning Gate 3's own post-fix re-runs plus Gates 4/5/6 in
full) found **zero** mismatches. `meat_business_db` was never touched by
any of this — the defect was caught and fixed entirely within this rehearsal
sequence before ever reaching a real deployment.

**Housekeeping recommendation (not executed — disposable DBs are
deliberately left in place across this whole audit sequence for CTO
inspection, matching prior-session precedent):** reset/drop
`meatbiz_cr4_rehearsal` and `meatbiz_cr4_restore` before their next reuse as
a rehearsal target, since they now carry frozen artifacts from multiple
historical bug reproductions across sessions.

## Carried-forward open items (not in this pass's scope, not blocking)

- `JWT_SECRET` in `backend/.env` — still needs rotation on the real
  deployment (external/ops action, not a code fix; open since the prior
  RC1 gate pass).
- `PaymentAgent.allocateExistingCreditsToOpenBills()` posts no compensating
  `debt_transactions` row when applying an existing credit to a new bill
  (pre-existing P1, found during GO-LIVE BLOCKER 2, out of every subsequent
  gate's scope, not touched here).
- A handful of older `verify-*` scripts fail at fixture setup with
  `CUSTOMER_DEFAULT_SALES_FLOW_REQUIRED` (customers created without
  `default_sales_flow`) — a known, pre-existing stale-fixture class, not a
  product regression; confirmed again this session on `verify-s1d-price-
  book-integrity.js` and `verify-price-book-add-missing-items.js`.

## Commits produced this session

1. `ebe3f8d` — `fix(payment): attribute multi-bill payments per order in the debt ledger`
2. `ced0e7f` — `fix(schema): preserve order item price book attribution`
3. `fdc7501` — `test(rc): add Gate 5 combined customer matrix verification`
4. `479d8f1` — `test(rc): add Gate 6 (cross-flow security) and Gate 7 (global invariants)`

All pushed to `main`.
