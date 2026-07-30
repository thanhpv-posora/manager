# Performance Implementation Roadmap — MeatBiz POS

Status: **ROADMAP ONLY. Nothing in this document has been implemented.** Companion to `PERFORMANCE_FOUNDATION_AUDIT.md`, `FRONTEND_PERFORMANCE_MATRIX.md`, `BACKEND_ENDPOINT_PERFORMANCE_MATRIX.md`, `MYSQL_INDEX_AUDIT.md`.

This roadmap sequences the audit's findings into stages. **Do not automatically implement all items** — each sprint should get its own explicit CTO go-ahead, scoped to that sprint's items only, following the same Business Preservation First / Minimal Patch governance as the audit itself.

---

## SPRINT P1 — Zero-risk quick wins

No business behavior change. No API contract change. No schema change. Each item is independently shippable and independently revertible.

| Item | Finding ID | Description | Effort |
|---|---|---|---|
| Debounce Orders.jsx payment filter | FE-R-12 | Add 150-300ms debounce to the customer-name filter that currently fires `GET /payments` on every keystroke; also fixes a real stale-response race | S-M |
| Debounce + memoize Products.jsx search | FE-R-08 | Wrap `filteredRows` in `useMemo`, add debounce matching the proven `InventoryAdjustments.jsx` pattern | S |
| Fix `findIndex`-in-render in POS table | FE-R-04 | Build id→index `Map` via `useMemo` in `POSProductTableAgent.jsx` | S |
| Fix `findIndex`-in-render in Price Matrix | FE-R-10 | Same fix, `PriceMatrix.jsx` | S |
| Memoize CreateOrder cart totals | FE-R-01 | Wrap `selected`/`total`/`totalQty` in `useMemo([items])` | S |
| Memoize Orders.jsx report totals | FE-R-11 | Wrap `reportTotals`/`customerSummaryRows` in `useMemo([reportRows])` | S |
| Add request-sequence guards to POS catalog loaders | FE-R-06 | Copy the proven `importReadSeqRef` pattern into the 4 catalog-load functions in `CreateOrder.jsx` | M |
| Batch Orders.jsx bill-edit save | BE-adjacent (Orders.jsx `saveAllItems`) | Replace sequential per-item `await api.put()` loop with `Promise.all` at minimum | S |
| Parallelize independent sequential API calls | NET-02, NET-06, BE-04 | `Promise.all` for: customer-selection aliases+categories (CreateOrder.jsx), RetailDailySummary mount, OrderAgent.get()'s 4 independent lookups | S each |
| Remove redundant price-refresh call | NET-01 | **Blocked on REQUIRES_CTO_DECISION #1** — delete the follow-up `/effective-prices` call at the 4 catalog-load sites once confirmed safe | S (post-decision) |
| Add slow-request threshold logging | OBS-02 | One threshold branch in the existing `requestFileLogger.js` `res.on('finish')` handler | S |
| Add user_id to error/request logs | OBS-04 | Add `req.user?.id` to existing log payloads | S |
| Wire frontend errors to backend logging | OBS-08 | `ErrorBoundary.componentDidCatch` + global `window.onerror`/`unhandledrejection` → new lightweight endpoint reusing existing `fileLogger` | M |
| Route-level lazy loading for low-traffic pages | BUNDLE-01 | `React.lazy`/`Suspense` for `UserPermissions.jsx`, `OCRProviders.jsx`, `ProductionCheck.jsx`, `SponsorVideos.jsx`, `BusinessPortal.jsx`, `Registrations.jsx`, `UserCustomerMapping.jsx` | M |

**Exit criteria for P1:** each item ships as its own small PR/commit, build verified, no behavior change observed in manual smoke testing of the affected screen.

---

## SPRINT P2 — Database query/index improvements

Requires the MySQL index audit's specific recommendations; each index addition is its own migration, reviewed and applied outside this audit's scope (this audit created no migrations).

| Item | Finding ID | Description | Effort |
|---|---|---|---|
| Add `stock_transactions.(reference_type, reference_id)` index | DB-04 / MYSQL_INDEX_AUDIT #1 | Genuine, size-independent gap | S |
| Add `purchase_lots.(purchase_date, del_flg)` index | DB-10 / MYSQL_INDEX_AUDIT #2 | Genuine, size-independent gap, directly feeds the Profit report | S |
| Fix `OrderAgent.create()` N+1 price resolution | BE-01 | Migrate to the existing bulk resolver (`getEffectivePricesForCategory`/`getEffectivePrices`), same pattern `PriceMatrixAgent` already uses. **Requires a verification pass proving byte-identical pricing output before cutover** — this is the single highest-stakes item in the whole roadmap since it touches every sale | M-L |
| Fix `ProductAgent.customerProducts()` N+1 | BE-02 | Same bulk-resolver migration, lower frequency (admin price-edit screen) | M |
| Batch `assertItemsCategoryPerFlow()` validation queries | BE-05 | Convert 3×N sequential lookups to `IN(...)` batched queries — validation itself stays required, only the read pattern changes | M |
| Batch `PriceMatrixAgent.saveMatrix()`/`updateBook()` writes | BE-10 | Multi-row `INSERT...ON DUPLICATE KEY UPDATE` + batched `price_change_logs` insert | M |
| Batch `ProductImageImportAgent.preview()` duplicate-name check | BE-13 | Single `IN(...)` query instead of per-row | S |
| Server-side pagination: Orders.jsx | TS-04 | New `limit`/`offset`/date-range params on `GET /orders`, frontend adopts server pagination matching `StockLedger.jsx`'s proven pattern. **API contract change — coordinate frontend+backend in one release** | M-L |
| Server-side pagination: Products.jsx, Customers.jsx, Lots.jsx | TS-02, TS-03, TS-09 | Same pattern, lower urgency than Orders.jsx | M each |
| Bound report date ranges by default | RPT-01, RPT-02 | Dashboard summary + Revenue report default to a recent window unless "all-time" is confirmed as an intentional product requirement — **blocked on REQUIRES_CEO_DECISION #1** | M (post-decision) |
| Add composite index for price-book category lookup | DB-05 Path 1 | `(customer_price_category_id, effective_calendar_type, status, effective_from, id)` | S |
| Clean up redundant duplicate indexes on `purchase_orders` | MYSQL_INDEX_AUDIT #10 | Remove one of each duplicate pair (`purchase_code`, `purchase_date`) | S |

**Exit criteria for P2:** every new index verified via `EXPLAIN` to actually change the access plan before/after on a realistic synthetic dataset (not just the tiny dev DB); the `OrderAgent.create()` migration ships with an explicit before/after price-output comparison test, not just "it still works."

---

## SPRINT P3 — Write-path performance

Cross-cutting, touches multiple domains simultaneously — sequence carefully, test for deadlock behavior under actual concurrency, not just single-threaded correctness.

| Item | Finding ID | Description | Effort |
|---|---|---|---|
| Standardize lock order across all multi-row `FOR UPDATE` loops | BE-06, BE-08, BE-09, BE-11, BE-12 | One decision (ascending product_id / a fixed cross-table priority order) applied consistently to: `OrderAgent.create()`'s item loop, `PaymentAgent.create()`'s order-locking, `PaymentAgent.revertPaymentEffects()`, `PriceMatrixAgent.recalcUnpaidOrdersForBook()`, `InventoryReceiveService.receive()`, `InventoryAdjustmentAgent.createBatch()` — matching the one already-correct precedent in `InventoryService.reverseOrderInventory()`. **Blocked on REQUIRES_CTO_DECISION #2** | L |
| Add idempotency key to `OrderAgent.addItem()`/`updateItem()` | BE-07 | Same pattern already proven in `create()` | M |
| Wrap `ProductImageImportAgent.save()` in a transaction | BE-13 | Currently bare `pool.query()` per row — partial-import risk on failure | M |
| Fix `nextCodeByCategory()` concurrency gap | BE-13 | Move to the transaction-aware pattern already used by `utils/code.js`'s `nextCode()` elsewhere | S |
| Route `CustomerAgent.remove()` through `SoftDeleteAgent` | BE-14 | Closes the reference-check gap — correctness fix bundled here since it changes delete-path behavior alongside the write-path work. **Blocked on REQUIRES_CTO_DECISION #5** | S (post-decision) |
| Align `SoftDeleteAgent` product refChecks with `hasBusinessHistory()` | BE-15 | Add `purchase_order_items`/`inventory_receive_items` to the product refCheck list | S |
| Shorten `OrderAgent.create()`'s pre-lock query window | BE-01 (side effect) | Once the N+1 fix (P2) lands, the transaction naturally holds locks for less wall-clock time — verify this as a side effect, not a separate task | — (verification only) |

**Exit criteria for P3:** a concurrency test (two simultaneous requests hitting the same product/customer/order from different angles) run against a staging-like environment showing no new deadlocks introduced and the previously-identified deadlock scenarios (BE-06, BE-08) no longer reproducible.

---

## SPRINT P4 — Observability and load testing

Informed by P1-P3's actual measured impact — this sprint is where "does it actually help" gets answered with data instead of projection.

| Item | Finding ID | Description | Effort |
|---|---|---|---|
| DB query-duration timing wrapper | OBS-03 | Threshold-gated logging around `pool.query`/`execute` in `db.js`, to avoid log volume blow-up | M |
| Connection-pool / memory metrics | OBS-07 | Periodic `process.memoryUsage()` + pool active/idle count, exposed via `/api/health` or a log line | S |
| DB transaction-level tracing | OBS-06 | Correlate transaction lifecycle with `request_id` | M |
| API load test | — | Synthetic load test against a staging environment (**never production**, per the audit's absolute prohibitions) to find the actual crossover point where the MySQL optimizer's current full-scan choices (Orders list, Revenue/Profit unbounded queries) start hurting — this is the only way to convert this audit's "projected risk at scale" framing into measured fact | L, requires a staging environment (currently `NOT_VERIFIED` to exist) |
| Frontend profiling pass | — | React DevTools Profiler flame-graph capture on `CreateOrder.jsx`/`Products.jsx`/`PriceMatrix.jsx` with a realistic (synthetic, if needed) catalog size, to confirm/refute the P1 rendering fixes' actual impact | M, requires browser access (not available in this audit's environment) |
| Production baseline capture | — | Once P1-P3 ship, capture a "before/after" baseline using the new OBS-02/OBS-03 timing logs on real (or realistic synthetic) traffic | — (depends on prior items) |
| Rate limiting rollout | SEC-05, SEC-09 | Apply a general baseline rate limit to the ~30 unprotected route groups, with a stricter limit on `/api/reports/*`. **Blocked on REQUIRES_CTO_DECISION #3** on thresholds — sequenced last because it's security-adjacent and needs careful tuning against real usage patterns (e.g. Excel import's internal per-row calls, POS rapid order entry during a busy shift) to avoid breaking legitimate bursty use | M, post-decision |
| Scope global payload limit down | SEC-07 | Per-route body-size limits instead of the uniform 10MB default, paired with the rate-limiting rollout | S |

**Exit criteria for P4:** the audit's "NOT_VERIFIED" measurement gaps (Foundation Audit §25) are closed — real timing data exists for at least the P1/P2 changes, and a documented decision exists on whether a staging load-test environment will be stood up going forward.

---

## Explicit Non-Goals (not on this roadmap at all)

- Virtualization (react-window etc.) for any table — no current table justifies it; revisit only if `InventoryAdjustments.jsx`'s TRACK_STOCK catalog grows into the many-hundreds range.
- Snapshot/materialized-summary tables for any report — not justified at current scale (28 orders); revisit once P4's load-test/production-baseline data exists.
- A caching layer for any price/stock/debt/permission data — explicitly prohibited by the audit's governance; the Cache-Candidate list in `FRONTEND_PERFORMANCE_MATRIX.md` names only category/unit/customer-identity data as safe candidates, and even those are P2-or-lower priority.
- Splitting `CreateOrder.jsx`'s ~70-`useState` architecture (FE-R-03) — structural, high regression risk, deferred until the smaller fixes (P1) are shipped and measured.
- Any database schema change, migration, or index creation as part of this document itself — every index recommendation above requires its own separate migration, reviewed and applied outside this roadmap's authorship.

## Sequencing Rationale

P1 before P2: quick wins are independently low-risk and build team/CTO confidence before touching the database or write paths. P2 before P3: index changes and the price-resolution N+1 fix are isolated (touch one query pattern each); lock-order standardization touches five call sites across three domains simultaneously and is safer to attempt once the team has already shipped and verified P1/P2 without incident. P4 last: observability instrumentation is most valuable once there's real P1-P3 change to measure against, and load testing is only meaningful once the codebase isn't actively mid-refactor.
