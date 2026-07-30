# Performance Foundation Audit — MeatBiz POS

Status: **AUDIT ONLY. No optimization implemented. No schema changes. No indexes created. No SQL executed except read-only SELECT/EXPLAIN. No commit. No push.**

Generated: 2026-07-28. All findings evidence-cited (file:line). Where a claim could not be verified with actual measurement (no browser, no load test, no production access), it is explicitly marked `NOT_VERIFIED`.

---

## 1. Executive Summary

MeatBiz is currently a **small-scale, low-traffic dev/early-production system** (largest table: `ai_action_logs` at 566 rows; core business tables — `orders`=28, `order_items`=198, `stock_transactions`=239, `debt_transactions`=35, `products`=81, `customers`=29). At this scale, nothing in the system is measurably slow — every `EXPLAIN` captured during this audit shows single-digit-to-low-hundreds row counts regardless of query quality.

The audit's value is therefore **entirely projective**: it identifies query/architecture *shapes* that will degrade predictably as the business grows (target framing: risk at 1,000 and 10,000 rows), and identifies a small number of *already-active* correctness/efficiency defects that are bugs regardless of scale (an unmigrated N+1 price-resolution loop in order creation, a redundant duplicate frontend price-refresh call, missing rate limiting on ~30 route groups, one customer soft-delete path that bypasses reference-check protection).

**Overall posture:** the codebase shows a consistent, recognizable pattern of the team **already knowing the right fix and having applied it in some places but not others** — bulk price resolvers exist and are used by `PriceMatrixAgent` but not `OrderAgent.create()`; a deadlock-safe ascending-ID lock order is used by `reverseOrderInventory()` but not by 4 other multi-row `FOR UPDATE` loops; debounced+memoized search exists in `InventoryAdjustments.jsx` but not in `Products.jsx`/`Customers.jsx`/`Orders.jsx`; server-side pagination exists in `StockLedger.jsx` but not in `Orders.jsx`/`Products.jsx`/`Customers.jsx`/`Lots.jsx`. This is good news for remediation: no new pattern needs to be invented, only propagated.

No business rule, schema, API contract, inventory authority, pricing semantics, debt semantics, or audit requirement was touched or is recommended to be touched by this audit.

## 2. System Baseline

**Frontend:** React 18.2.0, Vite 5.1.6 (build tool; build itself ran under vite 5.4.21), 35 page components, no router library (manual page-dispatch in `App.jsx`), no global state library (component state + prop drilling + a single Axios instance `frontend/src/api/api.js`). Key deps: axios 1.6.7, lucide-react 0.468.0, recharts 2.12.0, xlsx 0.18.5 (dynamically imported), tesseract.js 5.1.1 (dynamically imported).

**Backend:** Node v20.11.1, Express 4.18.3, mysql2 3.9.2 (promise pool, `connectionLimit: 10`, `waitForConnections: true`, `queueLimit: 0`), 42 route files, 50 agent files, 29 service files. JWT auth via `jsonwebtoken` 9.0.2, no DB query inside the auth middleware itself (`backend/src/middleware/auth.js`).

**Database:** MySQL 8.0.35, InnoDB only, 64 tables, `transaction_isolation = REPEATABLE-READ` (MySQL default, unmodified), `slow_query_log = OFF`, `long_query_time = 10s` (default — no slow-query capture currently possible). 31 DB-declared foreign keys; most business relationships are logical/undeclared (documented in prior architecture audits).

**Environment:** Development database confirmed live and queried directly (host redacted — internal network address) — NOT a synthetic/empty DB, this is real (small) production-shaped data. Staging: `NOT_VERIFIED` — no separate staging environment reference found in the repo. Production: `NOT_VERIFIED` — no Dockerfile, docker-compose.yml, or nginx.conf exists anywhere in the repo; `BUSINESS_DEPLOY.md` only *mentions* Caddy/Nginx as a suggested LAN-HTTPS option, not a committed config. Current CPU/RAM limits: `NOT_VERIFIED` — no access to the host machine.

## 3. Top 10 Verified Risks

Ranked by (a) confirmed-active-today defect status and (b) blast radius if it fires.

1. **`OrderAgent.create()` unmigrated N+1 price resolution** — up to 5 sequential queries per line item on the single highest-frequency write path in the app (every bill), while a bulk resolver already exists and is used elsewhere. `backend/src/agents/OrderAgent.js:606-622`.
2. **Frontend redundant duplicate price call** — every POS catalog load calls `catalog/order` (which already returns prices) then immediately calls `/effective-prices` again for the same data, at all 4 catalog-load call sites in `CreateOrder.jsx`. `frontend/src/pages/CreateOrder.jsx:335+347, :359+368, :476+485, :580+582`.
3. **No rate limiting on ~30 of the ~35 route groups** — SECURITY-IMPACTING. Only `/api/ai`, `/login`, and OTP/reset endpoints are protected. `backend/src/server.js:50-90`.
4. **`Orders.jsx` loads the entire order/bill history unbounded, every mount** — `GET /orders` with no params, client-side filter+paginate. `frontend/src/pages/Orders.jsx:49`.
5. **`Orders.jsx` payment-report filter fires a network request on every keystroke, with no debounce and no stale-response guard** — a fast typist can end up with receipts that don't match the visible filter. `frontend/src/pages/Orders.jsx:60,51-59`.
6. **`Orders.jsx` bill-edit save loops N sequential `PUT` calls**, one per line item, fully blocking the save button. `frontend/src/pages/Orders.jsx:113-124`.
7. **Deadlock-risk lock-order inconsistency across 5+ independent code paths** that take `FOR UPDATE` locks on `orders`/`products`/`purchase_order_items` rows in different orderings (client-submitted order, allocation-row order, unordered `DISTINCT`, ascending id/date). Only one path (`reverseOrderInventory`) does it correctly. `backend/src/agents/OrderAgent.js:680-703`, `backend/src/agents/PaymentAgent.js:542-547,776-820`, `backend/src/agents/PriceMatrixAgent.js:830-861`, `backend/src/services/InventoryReceiveService.js:231-295`, `backend/src/agents/InventoryAdjustmentAgent.js:161-190` vs. `backend/src/services/InventoryService.js:110-121`.
8. **`CustomerAgent.remove()` bypasses the reference-check system entirely** — a fully-defined `SoftDeleteAgent` config for `customer` exists (orders/payments/debt checks) but is never called; the raw `UPDATE customers SET del_flg=1` has zero guard. `backend/src/agents/CustomerAgent.js:179-186` vs. `backend/src/agents/SoftDeleteAgent.js:8-16`.
9. **`GET /api/reports/dashboard`'s summary block is a fully unbounded, full-order-history aggregate, run on every ADMIN login** (dashboard is the default landing page). `backend/src/agents/ReportAgent.js:8-13`.
10. **`POSProductTableAgent.jsx` and `PriceMatrix.jsx` both do an O(n) `findIndex` into the full item array inside a `.map()` render loop** — recomputed on every render, in the highest-traffic UI in the app (the POS bill line table). `frontend/src/components/pos/POSProductTableAgent.jsx:103`, `frontend/src/pages/PriceMatrix.jsx:513`.

## 4. Top 10 Probable Risks

11. `stock_transactions` has zero index on `(reference_type, reference_id)` — full table scan on every "show movements for this order/receive/lot" lookup. `backend/src/agents/StockLedgerAgent.js:73`.
12. `purchase_orders.partner_id` (the newer BP-003 primary partner reference) has zero index at all. `backend/src/agents/InventoryPurchaseAgent.js:18-19`.
13. `PriceBookService.getEffectivePrice()`/`getEffectivePricesForCategory()` filesort on every price-book lookup keyed by `customer_price_category_id` — no composite index covers that leftmost column for this query shape. `backend/src/services/PriceBookService.js:281-338`.
14. `ProductAgent.customerProducts()` / `updateCustomerPrice()` — editing **one** customer's **one** product price triggers an N+1 over the customer's entire category catalog. `backend/src/agents/ProductAgent.js:262-299`.
15. `PriceMatrixAgent.saveMatrix()`/`updateBook()` — 300-400+ sequential queries inside one open transaction for a 100+ product category price-book save. `backend/src/agents/PriceMatrixAgent.js:430-493,928-965`.
16. `CustomerAgent.list()` — full `customers × debt_transactions` GROUP BY aggregate with a non-indexable `ORDER BY` (filesort), recomputed on every Partners page load and after every single add/edit/delete. `backend/src/agents/CustomerAgent.js:117-137`.
17. `Products.jsx`/`Customers.jsx`/`Lots.jsx` all load their entire table unbounded and filter/paginate client-side (no server pagination), same pattern as Orders.jsx (#4) but currently lower row-count risk. `frontend/src/pages/Products.jsx:126`, `Customers.jsx:43`, `Lots.jsx:222`.
18. `GET /api/reports/profit` — JS-side (not SQL) aggregation over every raw `order_item` row in the selected range, an unindexed full-scan on `purchase_lots`, and an unbounded `details` array shipped to the client (UI only truncates display to 300 rows, not the transfer). `backend/src/agents/ReportAgent.js:93-152,196-204`.
19. Main frontend JS bundle is 1,064 KB / 295 KB gzip in one chunk — all 29 pages statically imported in `App.jsx`, zero `React.lazy`/route splitting anywhere in the codebase (confirmed via build + grep). `frontend/src/App.jsx:1-31`.
20. `InventoryReceiveService.receive()` locks `purchase_order_items` rows in receive-line order (not sorted) inside the same transaction that also blind-updates `products.stock_quantity` — same deadlock-risk family as #7, specific to the goods-receipt path. `backend/src/services/InventoryReceiveService.js:231-295`.

## 5. False Positives / Optimizations Not Recommended

- **Dialog.jsx `onClose` stale-closure bug** — confirmed fixed and isolated; grepped the entire frontend, no sibling instances found (`CalendarDialog.jsx` has no `useEffect` at all, so the bug class doesn't apply there).
- **`React.memo` blanket application** — explicitly not recommended anywhere. None of the flagged components pass unstable props to genuinely expensive memoized children; the one place it could plausibly help (`POSProductTableAgent`) needs its internal O(n²) `findIndex` cost fixed first, since the component's own render cost — not prop-identity churn — is the driver.
- **CreateOrder.jsx's Excel/OCR Import Center** — zero API calls during preview (confirmed: fully client-side via dynamically-imported `xlsx`/`tesseract.js`); flagged by the brief as a suspect area but ruled out by direct code read.
- **POS customer/product picker (`EnterpriseAutocomplete.jsx`)** — already correctly memoized, capped at 50 results, zero network calls; this is the *correct* reference pattern, not a defect.
- **Auth middleware DB query per request** — confirmed absent; JWT verify only, no DB hit. Good property, not a finding to fix.
- **CORS origin computation per request** — confirmed computed once at startup, not per-request; the small per-request `includes()` check against an operator-controlled origin list is not a meaningful cost at any scale.
- **Login endpoint brute-force protection** — already adequate: dual protection via `loginLimiter` (10/15min, ip+username-keyed) and a DB-backed 5-strikes lockout. Not a gap.
- **`InventoryAdjustments.jsx`'s 30s polling** — correctly gated (`while(isClean)`) and cleaned up on unmount; cited as a positive reference, not a finding.
- **Snapshot/materialized-summary tables for any report** — not justified at current scale (28 orders); explicitly deferred, not recommended now for any report.
- **Virtualization (react-window etc.) for any table** — not recommended now; every table's current DOM row count is bounded by explicit pagination except `InventoryAdjustments.jsx`'s intentionally-always-editable grid, which is a deliberate stock-count UX trade-off, not a bug, and only becomes a virtualization candidate if the TRACK_STOCK catalog grows into the many-hundreds range.

## 6. Frontend Rendering Findings

See `FRONTEND_PERFORMANCE_MATRIX.md` §Rendering for the full matrix (IDs FE-R-01 through FE-R-13). Headline items: `CreateOrder.jsx`'s per-render, unmemoized quantity/total derivation over the whole catalog (FE-R-01/02); `POSProductTableAgent.jsx`'s O(n²) `findIndex`-in-render (FE-R-04, mirrored in `PriceMatrix.jsx`, FE-R-10); zero `AbortController`/stale-response guards anywhere except the Excel/OCR import flow (FE-R-06); ~70 `useState` hooks in one 1900-line `CreateOrder.jsx` component (FE-R-03, structural, not a quick fix).

## 7. Table Scalability Findings

See `FRONTEND_PERFORMANCE_MATRIX.md` §Scalability. Only `StockLedger.jsx` implements true server-side pagination + filtering (the reference pattern). `Orders.jsx`, `Products.jsx`, `Customers.jsx`, `Lots.jsx`, `InventoryPurchases.jsx` (list), `PriceMatrix.jsx` all load the full table/category and paginate/filter client-side — acceptable today, a growing risk as transactional history (orders, lots, purchase orders) accumulates over months/years, since master-data tables (products/customers) grow much more slowly than transactional ones.

## 8. Network Findings

See `FRONTEND_PERFORMANCE_MATRIX.md` §Network. Headline: the duplicate price-refresh call (#2 above); up to 8 sequential/partially-parallelizable round trips before a cashier can enter the first quantity in a fresh POS session; `GET /products` fetches the entire, unfiltered, full-column product table on every POS mount to support one narrow OCR-alias-matching feature.

## 9. Bundle Findings

**Real, measured build output** (`vite build`, 2026-07-28, 2550 modules transformed, 5.62s):

| Asset | Size | Gzip |
|---|---|---|
| `index.html` | 0.64 KB | 0.34 KB |
| `assets/index-*.css` | 97.64 KB | 17.22 KB |
| `assets/index-*.js` (entry) | 16.33 KB | 6.98 KB |
| `assets/xlsx-*.js` (dynamic chunk) | 429.03 KB | 143.08 KB |
| `assets/index-*.js` (main) | **1,064.33 KB** | **295.16 KB** |

Vite's own build warning flags the main chunk as over the 500KB threshold. `xlsx` (429KB) and `tesseract.js` are both already correctly dynamically imported (`await import('xlsx')` in `CreateOrder.jsx:1308` and `PriceMatrix.jsx:299`; `await import('tesseract.js')` in `CreateOrder.jsx:1513` and `ProductImageImport.jsx:25`) — this is good existing practice, not a finding. The 1MB main chunk is explained by `App.jsx` statically importing all 29 page components with zero `React.lazy`/`Suspense` usage anywhere in the codebase (confirmed via grep, zero matches) and no `manualChunks` config in `vite.config.js`. No bundle analyzer was added (per the prohibition on adding a permanent dependency) — sizes above are read directly from the build's own output.

## 10. Backend API Findings

See `BACKEND_ENDPOINT_PERFORMANCE_MATRIX.md` §API. Headline: the `OrderAgent.create()` N+1 (#1); no pagination on `orders`, `customers`, `products` list endpoints; `PriceMatrixAgent.saveMatrix()`/`updateBook()` per-item write loops inside one long transaction; `ProductImageImportAgent.save()` not wrapped in a transaction at all (partial-import risk on failure).

## 11. N+1 Findings

See `BACKEND_ENDPOINT_PERFORMANCE_MATRIX.md` §N+1. Full classification table distinguishing true N+1 reads (safely batchable — price resolution, Excel-import duplicate-name checks) from required per-row validation/lock/audit (order-item stock deduction, inventory adjustment batch, goods-receipt line processing) is included there. **Nothing found in this audit warrants removing per-row validation, locks, or audit trail** — every "required" classification is backed by a specific business reason cited from the code.

## 12. MySQL Index Findings

See `MYSQL_INDEX_AUDIT.md` for the full EXPLAIN-backed findings. 11 concrete gaps documented (2 genuinely missing indexes with zero coverage — `stock_transactions.(reference_type,reference_id)` and `purchase_orders.partner_id`; several filesort/access-type-at-scale projections; 2 pairs of redundant duplicate indexes on `purchase_orders` recommended for cleanup, not addition).

## 13. Reporting Findings

See `BACKEND_ENDPOINT_PERFORMANCE_MATRIX.md` §Reporting. Dashboard's unbounded full-history summary on every admin login is the standout finding; Profit report's JS-side aggregation + unindexed `purchase_lots` scan + unbounded detail payload is the most complex/highest-projected-risk report in the system.

## 14. Transaction/Locking Findings

See §7 of the Top-10 list and `BACKEND_ENDPOINT_PERFORMANCE_MATRIX.md` §Transactions. The core finding is **lock-order inconsistency**, not lock overuse — the codebase already uses `FOR UPDATE` correctly and does not over-lock; the gap is that 5 of 7 identified multi-row locking loops don't follow the one already-correct ascending-primary-key convention established in `InventoryService.reverseOrderInventory()`.

## 15. Observability Findings

Present today: per-request duration logging with correlation/request-ID (good, uncommon to already have), request/response body logging with sensitive-field masking, error logging with stack traces. **Missing:** slow-request threshold flagging (trivial addition to existing middleware), acting-user-id on error logs, DB query-level timing, connection-pool/memory metrics, and — the most consequential gap — **frontend errors never reach the backend's existing logging infrastructure at all** (ErrorBoundary only `console.error()`s; no `window.onerror`/`unhandledrejection` handler exists anywhere). Nginx/container/production runtime metrics are `NOT_VERIFIED` — no deployment config exists in the repo to inspect.

## 16. Security/Performance Interaction

**SECURITY-IMPACTING findings** (3): (a) no rate limiting on ~30 of ~35 route groups including all report endpoints; (b) a uniform global 10MB body-parser limit applied to every route including trivial-payload ones; (c) `/api/reports/revenue`/`/profit` combine an optional/unbounded date range with zero rate limiting — a concrete repeated-expensive-query abuse vector even without a literal file-export endpoint. Auth, permission-loading, CORS, and login-endpoint protection were all checked and found adequate (see §5 False Positives).

## 17. Quick Wins (zero/low risk, no business-behavior change)

- Fix the frontend duplicate price-refresh call (#2) — delete a redundant network call, no behavior change if `catalog/order`'s embedded prices are confirmed authoritative for current UI needs (**REQUIRES_CTO_DECISION** — see §20).
- Add debounce to `Orders.jsx`'s payment-report customer-name filter (#5), matching the already-proven `InventoryAdjustments.jsx` 150ms pattern.
- Wrap `Orders.jsx`'s `reportTotals`/`customerSummaryRows` reduces in `useMemo` (currently recomputed on every unrelated render).
- Fix the `findIndex`-in-`.map()` antipattern in `POSProductTableAgent.jsx` and `PriceMatrix.jsx` (#10) — build an id→index `Map` once via `useMemo`.
- Add a slow-request threshold branch to the existing `requestFileLogger.js` middleware (observability).
- Add `user_id` to error-log payloads (observability).
- Wire `ErrorBoundary`/`window.onerror` to the backend's existing log infrastructure (observability).
- Add route-level `React.lazy` code splitting for at least the largest/least-frequently-visited pages (bundle).
- Batch `Orders.jsx`'s bill-edit save loop (#6) via `Promise.all` at minimum.

## 18. High-Risk Optimizations (require careful sequencing / explicit sign-off)

- Migrating `OrderAgent.create()` to the bulk price resolver (#1) — touches the highest-frequency write path in the app; must be verified to produce byte-identical pricing results to the current per-item path before cutover (regression risk: HIGH, business-visible if wrong).
- Standardizing lock order across the 5 inconsistent `FOR UPDATE` loops (#7) — touches Order/Payment/Inventory/Price-Book write paths simultaneously; must be sequenced carefully and tested for deadlock behavior under concurrency, not just correctness.
- Converting `Orders.jsx`/`Products.jsx`/`Customers.jsx`/`Lots.jsx` to server-side pagination — an API contract change (new required query params) that both frontend and backend must ship together; also changes what "the full list" means for any code relying on having everything in memory (e.g. `Products.jsx`'s OCR-alias-matching use of the full product list, currently fed by a different endpoint than expected — needs explicit scoping).
- Adding rate limiting across ~30 route groups — must be tuned to not break legitimate bursty usage (e.g. Excel import's per-row calls, POS rapid-fire during a busy shift) before rollout; **REQUIRES_CTO_DECISION** on thresholds.
- Fixing `CustomerAgent.remove()`'s missing reference-check guard (#8) — this is a correctness/data-integrity fix more than a performance one, but is bundled here because it's the kind of change that could newly *block* deletions that currently silently succeed; needs a decision on whether to also audit/repair any customers already soft-deleted while having live references.

## 19. Recommended Sprint Order

See `PERFORMANCE_IMPLEMENTATION_ROADMAP.md` for the full staged breakdown (SPRINT P1–P4). Summary: P1 = zero-risk frontend quick wins + observability wiring; P2 = the `OrderAgent.create()` N+1 fix + composite index additions (both evidence-backed, both isolated); P3 = lock-order standardization + server-side pagination rollout (both cross-cutting, need coordination); P4 = load testing + production observability baseline, informed by P1–P3's actual measured impact.

## 20. REQUIRES_CTO_DECISION

1. Is `catalog/order`'s embedded `sale_price`/`price_type`/`price_book_id` per row authoritative for all current POS UI needs, so the redundant `/effective-prices` follow-up call (#2) can simply be deleted at all 4 sites? Or does the follow-up call serve a purpose (e.g. re-resolving price after a date change without a full catalog reload) that must be preserved at some subset of the 4 sites?
2. What ascending-key convention should be standardized for all multi-row `FOR UPDATE` loops (product_id? a fixed table-priority order across Orders→Payments→Inventory→Price-Books?) — needs one decision applied consistently, not 5 separate local fixes.
3. What are acceptable rate-limit thresholds per route group, especially for Excel-import (currently one request per preview/save, but each does many internal per-row DB calls) and POS order-creation during a busy shift (must not throttle legitimate rapid order entry)?
4. Should `purchase_orders.supplier_id`/`.status`/`.purchase_date` and `.partner_id`/`.status`/`.purchase_date` both get composite indexes, or has the `partner_id` migration (BP-003) fully superseded `supplier_id` for this table, making the supplier-side index unnecessary going forward?
5. Should `CustomerAgent.remove()` be migrated to route through `SoftDeleteAgent.softDelete('customer', ...)` immediately (closing the reference-check gap), or does business logic have a reason customers are intentionally exempt from that guard that isn't captured in the current `SoftDeleteAgent` config?

## 21. REQUIRES_CEO_DECISION

1. Is unbounded historical reporting (dashboard summary, revenue, profit with no date range) an intentional product decision (owners want "all-time" totals available at a glance) that should instead be addressed by adding a snapshot/pre-aggregation layer rather than forcing a date bound — or should these reports require a bounded range going forward? This is a user-experience/business-decision trade-off, not a technical one.
2. Given the confirmed absence of rate limiting on report endpoints combined with unbounded date ranges (§16), is this an acceptable risk at current business scale, or should it be treated as urgent given it's both a performance and a security finding?

## 22. Files Created

- `docs/performance/PERFORMANCE_FOUNDATION_AUDIT.md` (this file)
- `docs/performance/FRONTEND_PERFORMANCE_MATRIX.md`
- `docs/performance/BACKEND_ENDPOINT_PERFORMANCE_MATRIX.md`
- `docs/performance/MYSQL_INDEX_AUDIT.md`
- `docs/performance/PERFORMANCE_IMPLEMENTATION_ROADMAP.md`

No migrations, no index-creation scripts, no analysis-output scripts, no bundle-analyzer dependency were created — none were needed beyond the real `vite build` output already captured in §9.

## 23. Commands Executed

All read-only. No INSERT/UPDATE/DELETE/DDL executed at any point in this audit.

- `node -v`, `npm run build` (frontend production build — real artifact, see §9)
- `node -e "..."` one-off scripts against the live dev DB via `backend/src/config/db.js`, running only: `SELECT VERSION()`, `SELECT @@transaction_isolation`, `SHOW VARIABLES LIKE 'slow_query_log'/'long_query_time'`, `information_schema.TABLES`/`.STATISTICS`/`.COLUMNS`/`.KEY_COLUMN_USAGE` queries, `SHOW INDEX FROM ...`, `SELECT COUNT(*)` on several tables, and `EXPLAIN`/`EXPLAIN ANALYZE` against read-only SELECT statements reconstructed verbatim from application code (never against a guessed query shape).
- Grep/code-reading across `backend/src` and `frontend/src` (no execution).

## 24. Runtime Measurements Performed

- Real production frontend bundle sizes (§9) — actual `vite build` artifact, not estimated.
- Real live-database `EXPLAIN` access-type/key/Extra output for every query pattern cited in `MYSQL_INDEX_AUDIT.md` — run against the actual current dataset (28 orders, 81 products, etc.).
- Real current table row counts and sizes via `information_schema.TABLES`.
- Real current MySQL configuration (version, isolation level, slow-query-log state).

## 25. Runtime Measurements Still Required (NOT_VERIFIED in this audit)

- **Any browser-based measurement**: React render counts, actual input-lag/jank on `CreateOrder.jsx`/`Products.jsx`/`PriceMatrix.jsx` at realistic catalog sizes, Web Vitals, DevTools Profiler flame graphs. No browser access in this environment.
- **Any load-generated timing**: endpoint response time under concurrent load, connection-pool saturation behavior, event-loop lag under real traffic. Not run per the explicit prohibition on load-testing without separate authorization, and no staging environment confirmed to exist.
- **Production/staging scale data**: this audit's entire "risk at 1k/10k rows" framing is a projection from query *shape*, not a measurement — no environment with that much data was available to test against.
- **Production deployment topology**: reverse proxy config, container resource limits, actual concurrent user count — `NOT_VERIFIED`, no deployment artifacts exist in the repo to inspect.
- **EXPLAIN ANALYZE actual execution timing** at realistic data volumes for the specific queries flagged as "optimizer currently chooses full-scan because the table is tiny" (Orders list, Revenue/Profit date-range queries) — current EXPLAIN captured access-plan shape only; actual timing crossover point (where the optimizer would switch to using the composite indexes) was not empirically found because it requires a much larger dataset than exists today.

---

Return exactly: **PERFORMANCE_FOUNDATION_AUDIT_READY_FOR_CTO_REVIEW**
