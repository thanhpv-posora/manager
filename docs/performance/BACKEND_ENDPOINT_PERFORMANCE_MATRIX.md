# Backend Endpoint Performance Matrix — MeatBiz POS

Status: **AUDIT ONLY. No code modified.** Companion to `PERFORMANCE_FOUNDATION_AUDIT.md`. Covers Phases 5 (API), 6 (N+1), 8 (Reporting), 9 (Transactions/Locking), 10 (Observability), 11 (Security/Performance).

Format per finding: ID · Route · Agent/service method · Query count · Transaction usage · Expected request size · Risk · Recommendation · Estimated effort · Priority · Status.

---

## Section A — API / N+1 (Phases 5–6)

### BE-01 — HEADLINE FINDING
- **Route:** `POST /api/orders`
- **Agent/method:** `OrderAgent.create()`, price loop at `backend/src/agents/OrderAgent.js:606-622`
- **Current behavior:** `for (const it of data.items) { await PriceBookService.getEffectivePrice(...) }` — up to 5 sequential queries per line item (category lookup, `resolveCustomerPriceCategoryId`, price-book lookup, legacy fallback, default fallback). The codebase's own comments (`PriceBookService.js:119-144,341-349`) document this exact pattern was **measured** at 255 queries / ~3.2s for a 53-product category and fixed via bulk resolvers `getEffectivePricesForCategory()`/`getEffectivePrices()` — used by `PriceMatrixAgent.matrix()`/`customerCatalogForOrder()`, but `OrderAgent.create()` was never migrated.
- **Query count:** ~5 × item count, purely for pricing, before the rest of `create()`'s own 6-10 queries.
- **Transaction usage:** yes — runs *inside* the transaction (`beginTransaction` `:588`), before any row locks are taken, needlessly extending connection/transaction hold time before `InventoryService.out()`'s `FOR UPDATE` locks later in the same request (`:682`).
- **Expected request size:** any bill line-item count; a 20-item bill ≈ 100 sequential round trips for pricing alone.
- **Risk:** highest-frequency write path in the entire app; will degrade linearly with cart size.
- **Recommendation:** route through the existing bulk resolver, same as `PriceMatrixAgent` already does — **REQUIRES verification that output is byte-identical to the current per-item path before cutover** (see Foundation Audit §18).
- **Estimated effort:** M (isolated change, but high-stakes verification).
- **Priority:** **P1**.
- **Status:** VERIFIED.

### BE-02
- **Route:** `GET /api/products/customer/:customerId`, and internally via `ProductAgent.updateCustomerPrice()`
- **Agent/method:** `ProductAgent.customerProducts()` — `backend/src/agents/ProductAgent.js:262-282`, loop at `:277-280`
- **Current behavior:** identical unmigrated N+1 — `getEffectivePrice()` called once per row after the full product list is already fetched.
- **Query count:** ~5 × products-in-category.
- **Transaction usage:** none (read endpoint) for the GET path; `updateCustomerPrice()` calls this merely to build the item list for editing **one** price, so a single-price edit costs O(products-in-category) queries.
- **Expected request size:** one customer's full category catalog.
- **Risk:** same class as BE-01, lower frequency (admin price-edit screen, not every sale).
- **Recommendation:** same bulk-resolver migration.
- **Estimated effort:** M.
- **Priority:** P2.
- **Status:** VERIFIED.

### BE-03
- **Route:** internal — `OrderAgent.list()`
- **Agent/method:** `backend/src/agents/OrderAgent.js:484-499`
- **Current behavior:** no pagination; returns every order matching date/customer filters, `SELECT o.*`.
- **Query count:** 1 (but unbounded row count).
- **Transaction usage:** none.
- **Expected request size:** entire order history matching filters.
- **Risk:** unbounded response growth as order history accumulates.
- **Recommendation:** add `limit`/`offset` server-side pagination, matching `StockLedgerAgent.list()`'s already-correct pattern.
- **Estimated effort:** M (API contract change, frontend must adopt).
- **Priority:** P2.
- **Status:** PROBABLE.

### BE-04
- **Route:** `GET /api/orders/:id`, `GET /api/orders/token/:token`
- **Agent/method:** `OrderAgent.get()`/`getByToken()` — `backend/src/agents/OrderAgent.js:501-560`
- **Current behavior:** 6 sequential, largely-independent queries (order+customer, order_items, old_debts, latest payment, monthly installment [+ conditional re-query], payment_allocations). None of `items`/`oldDebts`/`payRows` depend on each other.
- **Query count:** 5-6.
- **Transaction usage:** none (read).
- **Expected request size:** one order detail view.
- **Risk:** low (single-order scope), but a safe/free latency win.
- **Recommendation:** `Promise.all` the independent branches.
- **Estimated effort:** S.
- **Priority:** P3.
- **Status:** PROBABLE.

### BE-05
- **Route:** internal — `assertItemsCategoryPerFlow()`, called from `OrderAgent.create()`
- **Agent/method:** `backend/src/agents/OrderAgent.js:171-263`, loop at `:178-260`
- **Current behavior:** up to 3 queries/item (`customer_price_books`, `customer_price_book_items`, `customer_price_categories`).
- **Query count:** up to 3 × item count.
- **Transaction usage:** inside `create()`'s transaction.
- **Expected request size:** per bill line-item count.
- **Risk:** required per-row validation (price-book/category consistency can't be trusted from the client) — classification: **(1) N+1 read, but (5) safely batchable via IN(...)**, since the reads themselves have no per-row lock/ordering dependency.
- **Recommendation:** batch the 3 lookups via `IN(...)` across all items at once; do not remove the validation itself.
- **Estimated effort:** M.
- **Priority:** P2.
- **Status:** VERIFIED (safe batch opportunity, not a bug in the validation itself).

### BE-06
- **Route:** N/A — cross-cutting deadlock risk
- **Agent/method:** `OrderAgent.js:680-703` (order-item stock deduction loop) vs. `InventoryService.js:110-121` (`reverseOrderInventory`)
- **Current behavior:** the create()/addItem() loop takes `FOR UPDATE` product locks in **client-submitted item order**; `reverseOrderInventory()`'s own comment explicitly documents sorting by `product_id ASC` "to avoid lock-ordering deadlocks... matching postOut()'s FOR UPDATE convention" — i.e. the codebase already recognizes this risk and fixed it for cancel-reversal, but not for create/addItem.
- **Query count:** N/A (locking-order finding, not a count finding).
- **Transaction usage:** yes, throughout.
- **Expected request size:** any multi-item bill selling products also being sold in a concurrent bill.
- **Risk:** two concurrent bills selling the same two products in reverse order **can deadlock**.
- **Recommendation:** sort items by `product_id` before the lock-acquiring loop, matching the already-correct convention.
- **Estimated effort:** S (once the standardized ordering decision is made — see Foundation Audit §20 item 2).
- **Priority:** **P1**.
- **Status:** VERIFIED.

### BE-07
- **Route:** `POST /api/orders/:id/items` (addItem), `PUT /api/orders/:id/items/:itemId`
- **Agent/method:** `backend/src/agents/OrderAgent.js:860-953`
- **Current behavior:** no idempotency protection (contrast with `create()`, which has a real idempotency key + UNIQUE fallback).
- **Query count:** N/A.
- **Transaction usage:** yes.
- **Expected request size:** single item add/edit.
- **Risk:** double-click/timeout-retry on "Add Item" inserts a duplicate row and double-deducts stock.
- **Recommendation:** add the same idempotency-key pattern already proven in `create()`.
- **Estimated effort:** M.
- **Priority:** P2.
- **Status:** VERIFIED.

### BE-08
- **Route:** `POST /api/payments`
- **Agent/method:** `PaymentAgent.create()` — `backend/src/agents/PaymentAgent.js:542-547` vs. `:146-155`
- **Current behavior:** when `data.order_id` is supplied, first locks that single order (`FOR UPDATE`), then `allocateCustomerOpenBillsByDate()` locks **all** open bills for the customer in ascending `order_date, id` order. If the paid order isn't the oldest open bill, two concurrent `create()` calls for different `order_id`s of the same customer can deadlock (A locks #5 then blocks on #1 held by B; B locks #1 then blocks on #5 held by A).
- **Query count:** N/A (locking-order finding).
- **Transaction usage:** yes.
- **Expected request size:** any customer with 2+ open bills receiving concurrent payments.
- **Risk:** real deadlock scenario, business-visible as a failed payment.
- **Recommendation:** standardize lock acquisition order — always lock in ascending `order_date, id` including the target order, never lock the target order first out-of-sequence.
- **Estimated effort:** M.
- **Priority:** **P1**.
- **Status:** VERIFIED.

### BE-09
- **Route:** N/A — internal
- **Agent/method:** `PaymentAgent.revertPaymentEffects()` — `backend/src/agents/PaymentAgent.js:776-820`
- **Current behavior:** loops `payment_allocations` rows with **no `ORDER BY`** and locks the corresponding order per allocation in whatever order MySQL returns — a third independent lock-ordering variant vs. BE-08.
- **Risk:** same deadlock family as BE-08, different code path (edit/cancel-payment).
- **Recommendation:** apply the same standardized ascending-order-date/id convention.
- **Estimated effort:** S.
- **Priority:** P1 (bundle with BE-08).
- **Status:** VERIFIED.

### BE-10
- **Route:** `PUT /api/price-matrix/:customerId` (saveMatrix), and `updateBook`
- **Agent/method:** `PriceMatrixAgent.js:430-493` (saveMatrix), `:928-965` (updateBook item sync)
- **Current behavior:** per-item sequential upsert to `customer_product_catalogs` + conditional `price_change_logs` insert + `upsertBook()`'s per-item `customer_price_book_items` insert. For a 100+ product category: 300-400+ sequential queries inside one open transaction.
- **Query count:** ~3-4 × category size.
- **Transaction usage:** yes, for the entire duration.
- **Expected request size:** one price-book save for one customer/category.
- **Risk:** long transaction duration for large categories; all rows independent (no per-row lock/validation dependency beyond the already-batched category-match check).
- **Recommendation:** multi-row `INSERT...ON DUPLICATE KEY UPDATE` + batched `price_change_logs` insert.
- **Estimated effort:** M.
- **Priority:** P2.
- **Status:** VERIFIED (safe batch opportunity).

### BE-11
- **Route:** internal — `PriceMatrixAgent.updateBook()` → `recalcUnpaidOrdersForBook()`
- **Agent/method:** `backend/src/agents/PriceMatrixAgent.js:829-861`
- **Current behavior:** loops every unpaid order using the edited book (query has **no `ORDER BY`**) and does 4 sequential queries per order (update items, sum, `FOR UPDATE` order lock, update order) — a **fourth** independent lock-ordering variant on top of BE-08/BE-09, increasing overall deadlock surface, all inside the same transaction as `updateBook()`'s own item loops (compounding BE-10's duration).
- **Risk:** deadlock surface + long transaction duration, compounded.
- **Recommendation:** same standardized lock-order fix; consider decoupling the recalc from the main transaction if business rules allow eventual consistency for this specific side-effect (flag as REQUIRES_CTO_DECISION if considered).
- **Estimated effort:** M.
- **Priority:** P1 (part of the lock-order standardization effort).
- **Status:** VERIFIED.

### BE-12
- **Route:** N/A — inventory single-writer callers
- **Agent/method:** `InventoryReceiveService.receive()` — `backend/src/services/InventoryReceiveService.js:231-295`; `InventoryAdjustmentAgent.createBatch()` — `backend/src/agents/InventoryAdjustmentAgent.js:161-190`
- **Current behavior:** confirmed — these are the only two callers that invoke `InventoryMovementService.postIn/postOut/postAdjustmentIncrease/postAdjustmentDecrease/postOpening` in a loop. Both are **required** (per-row validation against `purchase_order_items.received_stock_qty`, or per-row sufficiency check + audit row) — classification (2)+(3)+(4), not bugs. Both lock rows in **client/submission order**, not sorted by product_id — same deadlock-risk family as BE-06.
- **Risk:** deadlock risk vs. any concurrent single-item order sale or receive touching the same products.
- **Recommendation:** sort by `product_id` before the lock loop, matching the standardized convention; do NOT remove the per-row validation/audit — it is required.
- **Estimated effort:** S each.
- **Priority:** P1 (bundle with BE-06/08/09/11).
- **Status:** VERIFIED.

### BE-13
- **Route:** `POST /api/product-import/preview`, `/save`
- **Agent/method:** `ProductImageImportAgent.js:32-64` (preview), `:66-96` (save)
- **Current behavior:** `preview()` — 1 duplicate-name-check query per submitted row (safe batch opportunity: fetch all matching names once via `IN(...)`). `save()` — up to 3 sequential queries per row (duplicate check, `nextCodeByCategory()`, insert/update), **not wrapped in a transaction at all** (bare `pool.query()`), and `nextCodeByCategory()` (`:18-30`) is a read-then-increment with no lock — safe within one sequential request but **not safe across two concurrent imports**, which can generate duplicate `product_code`s.
- **Query count:** up to 3 × row count.
- **Transaction usage:** **none** — a failure partway through an N-row import leaves a partial, uncommitted-as-a-unit import with no rollback.
- **Expected request size:** caller-controlled Excel row count, no cap found anywhere in preview()/save().
- **Risk:** correctness/safety gap (not just perf) — partial imports, and a real code-collision race under concurrent imports.
- **Recommendation:** batch the duplicate-name check via `IN(...)`; wrap `save()` in a transaction; move `nextCodeByCategory()` to the transaction-aware pattern already used by `utils/code.js`'s `nextCode()` elsewhere in the codebase.
- **Estimated effort:** M.
- **Priority:** P2.
- **Status:** VERIFIED.

### BE-14
- **Route:** `DELETE /api/customers/:id`
- **Agent/method:** `CustomerAgent.remove()` — `backend/src/agents/CustomerAgent.js:179-186` vs. `SoftDeleteAgent.js:8-16`
- **Current behavior:** raw `UPDATE customers SET del_flg=1` with **zero reference checks** — does not call `SoftDeleteAgent.softDelete('customer', ...)`, even though a full, correct `refChecks` config for `customer` already exists (orders, payments, debt_transactions, price books, categories, catalogs, legacy prices) and is simply never invoked. Confirmed via grep: only `product`/`category`/`supplier` deletions go through `SoftDeleteAgent`.
- **Risk:** a customer with live orders/payments/debt can be soft-deleted today with no server-side guard — data-integrity gap, not purely a performance one, explicitly in scope per the audit's "soft delete/reference checks" domain.
- **Recommendation:** route `CustomerAgent.remove()` through `SoftDeleteAgent.softDelete('customer', ...)` — **REQUIRES_CTO_DECISION** (Foundation Audit §20 item 5) on whether this is intentional today.
- **Estimated effort:** S (call-site change) once decision made.
- **Priority:** P1 (correctness, not perf, but flagged here per explicit task scope).
- **Status:** VERIFIED.

### BE-15
- **Route:** `DELETE /api/products/:id`
- **Agent/method:** `SoftDeleteAgent.js:17-22` vs. `ProductAgent.hasBusinessHistory()` `ProductAgent.js:217-224`
- **Current behavior:** `SoftDeleteAgent`'s `product` refChecks (`order_items`, `stock_transactions`, `customer_product_prices`, `customer_price_book_items`) do **not** include `purchase_order_items`/`inventory_receive_items`, even though a *different* check (`hasBusinessHistory`, used for a different purpose — domain-lock immutability) does check those two tables.
- **Risk:** a product that has only ever been purchased (never sold) can currently be soft-deleted via `removeProduct()` without any guard, despite having real purchase history.
- **Recommendation:** align `SoftDeleteAgent`'s product refChecks with `hasBusinessHistory()`'s table list.
- **Estimated effort:** S.
- **Priority:** P2.
- **Status:** VERIFIED.

### BE-16 (positive reference)
- **File:** `backend/src/agents/StockLedgerAgent.js:31-146,190-262`
- **Current behavior:** proper `LIMIT`/`OFFSET` pagination (capped at 500), single-query window-function running balance, single aggregate query for reconciliation.
- **Status:** FALSE_POSITIVE — cited as the correct pattern other list endpoints should be brought in line with.

---

## Section B — Reporting (Phase 8)

### RPT-01
- **Route:** `GET /api/reports/dashboard`
- **Agent/method:** `ReportAgent.js:8-13` (summary block)
- **Classification:** Operational interactive report (but with an unbounded aggregate baked in).
- **Current behavior:** `SUM(total_amount)`/`SUM(paid_amount)`/`COUNT(*)` over `orders WHERE status<>'CANCELLED'` with **no date filter at all** — full-history aggregate on every call. Only `daily`/`topProducts`/`topCustomers` are `LIMIT`-bounded (and only in output rows, not scan cost).
- **Query count:** up to 7 sequential (`summary`,`daily`,`topProducts`,`topCustomers`, 2 retail scalars), no `Promise.all`.
- **Transaction usage:** none (read).
- **Expected request size:** N/A (aggregate).
- **Risk:** dashboard is the **default ADMIN landing page** — this runs on every admin login, and current EXPLAIN already shows `type:ALL` (full scan; optimizer's choice at tiny cardinality — should be re-verified at real volume, since `status<>'CANCELLED'` alone can't seek any existing index without a date bound).
- **Recommendation:** default to a bounded recent window (e.g. last 30/90 days) unless "all-time" is a deliberate product requirement — **REQUIRES_CEO_DECISION** (Foundation Audit §21 item 1).
- **Estimated effort:** M.
- **Priority:** P2 (P1 if CEO confirms all-time totals aren't required).
- **Status:** VERIFIED.

### RPT-02
- **Route:** `GET /api/reports/revenue`
- **Agent/method:** `ReportAgent.js:37-78`
- **Current behavior:** `from`/`to` optional, unenforced server-side (frontend defaults month-start→today, but a direct API caller can omit both). With a range: `type:index` full index scan on `idx_orders_date_status` at current tiny scale (re-verify at real volume). SQL-side `GROUP BY`; JS merge afterward is bounded by distinct-period count, not row count — cheap regardless of scale.
- **Query count:** 2 sequential (POS aggregate, retail aggregate).
- **Transaction usage:** none.
- **Risk:** low-moderate — even an unbounded range still returns small period-aggregated rows to the client, unlike RPT-03.
- **Recommendation:** enforce a server-side default/max date range.
- **Estimated effort:** S.
- **Priority:** P3.
- **Status:** PROBABLE.

### RPT-03
- **Route:** `GET /api/reports/profit`
- **Agent/method:** `ReportAgent.js:80-243`
- **Classification:** Heavy analytical report — most complex query surface in the system.
- **Current behavior:** (a) main query is a **raw detail-row fetch** (one row per order_item, no `GROUP BY`), `orders` shows `type:ALL` even with a date range present at current scale; (b) `purchase_lots` cost-by-day aggregation has **no index on `purchase_date` or `del_flg` at all** — genuine, size-independent full scan, not just an optimizer choice; (c) FIFO cost lookup builds a dynamic `IN(...)` sized to every order_item_id in the result — at 10k+ items in a wide range this becomes a multi-thousand-placeholder query (currently dormant: target table `order_item_fifo_allocations` doesn't exist yet, caught by try/catch, falls back to null cost); (d) core aggregation is done in a **JavaScript for-loop over every raw row**, not SQL `GROUP BY` — the clearest "aggregate in application code" instance in the codebase; (e) `details` array (one entry per order_item) returned **in full, no server LIMIT** — frontend only truncates *display* to 300 rows (`Profit.jsx:36`), full payload is still computed and transmitted every time.
- **Query count:** up to 5 sequential.
- **Transaction usage:** none (read).
- **Expected request size:** unbounded if date range omitted or wide.
- **Risk:** the report to watch first — combines JS-side aggregation (memory+CPU scales with row count), a genuinely unindexed table scan (`purchase_lots`), and an unbounded network payload.
- **Recommendation:** add index on `purchase_lots.(purchase_date, del_flg)` (see `MYSQL_INDEX_AUDIT.md`); move aggregation to SQL `GROUP BY` where feasible; add server-side pagination/cap to `details`; enforce bounded date range.
- **Estimated effort:** L.
- **Priority:** P2.
- **Status:** VERIFIED.

### RPT-04
- **Route:** `GET/POST /api/retail-daily-summary`
- **Agent/method:** `RetailSummaryAgent.js:48-61`
- **Classification:** Operational interactive report (single-row lookup, not aggregation-scale).
- **Current behavior:** indexed single-row lookup (`idx_retail_date`), fine at any scale. `lunarToSolarDate()` (`backend/src/utils/lunarDate.js:93-103`) is a brute-force reverse search (up to ~730 day-by-day astronomical calc iterations) but only invoked for single-date conversions, never in a report-row loop.
- **Risk:** low.
- **Recommendation:** none needed now; note `lunarToSolarDate()`'s cost only becomes relevant if a future feature calls `/convert-date` in a tight loop (not found in this audit).
- **Priority:** P4.
- **Status:** FALSE_POSITIVE.

### RPT-05 (AI-internal, low priority)
- **Route:** internal, `report.service.js:4-11`
- **Current behavior:** `WHERE del_flg=0 AND DATE(created_at)=CURDATE()` — function-wrapped predicate, non-sargable by construction, `type:ALL`.
- **Risk:** low today (28 rows, AI-internal endpoint), but the easiest-to-fix non-sargable query pattern in the whole reporting surface if it's ever exposed to higher traffic.
- **Recommendation:** rewrite as a range (`created_at >= CURDATE() AND created_at < CURDATE()+1`) if this becomes a hot path.
- **Priority:** P4.
- **Status:** PROBABLE / LOW IMPACT.

---

## Section C — Observability (Phase 10)

| ID | Item | Current state | File:line | Classification | Priority |
|---|---|---|---|---|---|
| OBS-01 | Request duration logging | **Present** — logs duration_ms, method, url, status, ip, user_agent per request | `backend/src/middleware/requestFileLogger.js:10-29` | Already present | — |
| OBS-02 | Slow endpoint logging | **Absent** — duration_ms logged uniformly, no threshold flagging anywhere | N/A (confirmed absence) | Required now | **P1** |
| OBS-03 | DB query duration | **Absent** — no query wrapper, no pool listeners, no per-query timing | `backend/src/config/db.js:1-16` | Useful later | P3 |
| OBS-04 | Error logging context | Present (request_id, method, url, status, sanitized body, stack) but **missing acting user_id** | `backend/src/middleware/errorHandler.js:6-14` | Required now (1-line add) | **P1** |
| OBS-05 | Correlation/request ID | **Present** — UUID or client-supplied, echoed in header + logs + error body | `backend/src/middleware/requestFileLogger.js:6-8` | Already present | — |
| OBS-06 | DB transaction-level tracing | **Absent** — no transaction ID/label logged or correlated to request_id | N/A | Useful later | P3 |
| OBS-07 | Memory/event-loop/pool metrics | **Absent** — no process.memoryUsage(), no event-loop-lag sampling, no pool active/idle exposure despite `connectionLimit:10` being configured | `backend/src/config/db.js:11` | Useful later | P3 |
| OBS-08 | Frontend error monitoring | **Partial** — ErrorBoundary exists but only `console.error()`s; no window.onerror/unhandledrejection anywhere; nothing reaches the backend's existing log infra | `frontend/src/components/ErrorBoundary.jsx:2` | **Required now** — real blind spot, cheap fix | **P1** |
| OBS-09 | Web Vitals | **Absent** — no web-vitals package, no performance.mark/measure | N/A | Overkill for current scale | P4 |
| OBS-10 | Nginx/reverse-proxy timing | **NOT_VERIFIED** — no nginx.conf/Dockerfile/compose file anywhere in repo; only a mention in `BUSINESS_DEPLOY.md` | `BUSINESS_DEPLOY.md:17-18` | N/A — cannot assess | — |
| OBS-11 | Container/runtime metrics | **NOT_VERIFIED** — no Dockerfile/compose found | N/A | N/A — cannot assess | — |

**Recommended additions (free/self-hosted only, no paid platform):** slow-request threshold branch inside the existing `requestFileLogger.js` handler (OBS-02); `user_id`/`user_role` added to error/request log payloads (OBS-04); `ErrorBoundary.componentDidCatch` + global `window.onerror`/`unhandledrejection` POSTing to a new lightweight endpoint that reuses existing `fileLogger` infra (OBS-08); lightweight query-timing wrapper around `pool.query`/`execute`, threshold-gated to avoid log volume blow-up (OBS-03); periodic `process.memoryUsage()` + pool active/idle count, e.g. exposed on the existing `/api/health` endpoint (OBS-07).

---

## Section D — Security/Performance Interaction (Phase 11)

| ID | Item | Current state | File:line | Security-impacting? | Priority |
|---|---|---|---|---|---|
| SEC-01 | Auth middleware DB cost | **Good property, no finding** — pure JWT verify, zero DB query per request | `backend/src/middleware/auth.js:3-17` | No | — |
| SEC-02 | Permission loading | **Good property** — menu permissions resolved once per session via `/api/permissions/me` (2 queries), not per business-data request; not embedded in JWT but also not re-queried per route | `backend/src/agents/UserPermissionAgent.js:134-168`, `frontend/src/App.jsx:55,68` | No | — |
| SEC-03 | Customer-scope check | Recursive CTE (`getCustomerTree`) runs per request, but only for `CUSTOMER`-role users on scoped routes (not ADMIN/STAFF) — small (29 customers today), appropriately scoped | `backend/src/middleware/scope.js:26-55` | No | — |
| SEC-04 | CORS | Computed once at startup, not per-request; per-request origin check is a cheap array scan against an operator-controlled list | `backend/src/server.js:15-28,40` | No | — |
| SEC-05 | **Rate limiting — most routes unprotected** | `/api/ai` (30/min), `/login` (10/15min, ip+username-keyed + 5-strikes DB lockout), OTP/reset endpoints (10/15min) ARE protected. **~30 other route groups have zero rate limiting**, including all report endpoints and product/customer search. | `backend/src/server.js:50-90` vs. `:30-36,80`, `backend/src/routes/auth.js:12-30` | **YES** | **P1** |
| SEC-06 | Login brute-force protection | **Already adequate** — dual protection confirmed (rate limit + DB lockout). Not a gap. | `backend/src/routes/auth.js:20-30,71-85` | No (confirmed adequate) | — |
| SEC-07 | **Global payload limit** | `express.json/urlencoded/text({limit:'10mb'})` applied uniformly to every route, including trivial-payload ones like `/login` | `backend/src/server.js:41-43` | **YES** (amplification vector combined with SEC-05) | P2 |
| SEC-08 | Upload limits | Video upload has explicit 80MB `multer` limit (reasonable). Excel-import and any base64/JSON-based OCR paths have **no dedicated limit** — inherit the shared global 10MB cap only. | `backend/src/routes/videoUploads.js:19`, `backend/src/routes/productImport.js:6-7` | Performance risk, not security (routes are auth-gated) | P3 |
| SEC-09 | **Export/report abuse risk** | No literal file-export endpoint exists (print functions build HTML client-side from already-fetched data). But `/api/reports/revenue`/`/profit` combine optional/unbounded date range (RPT-02/RPT-03) with **zero rate limiting** (SEC-05) — a concrete repeated-expensive-query abuse vector. | `ReportAgent.js:38-42,81,86-87` + absence of rate limit on `/api/reports` | **YES** | **P1** |
| SEC-10 | Unbounded search | `GET /api/products?q=` has no LIMIT and a leading-wildcard `LIKE` (cannot use any index regardless of scale); `GET /api/customers` has no search param at all but returns the full table unconditionally with a debt aggregate join | `backend/src/agents/ProductAgent.js:132-162`, `CustomerAgent.js:117-137` | Performance primarily; secondary abuse angle since neither is rate-limited | P2 |

**SECURITY-IMPACTING summary (3 distinct findings):** SEC-05 (no rate limiting on ~30 route groups), SEC-07 (uniform global 10MB body limit), SEC-09 (unbounded-range report endpoints + no rate limit = concrete abuse vector). All three require **REQUIRES_CTO_DECISION** on specific thresholds before implementation (Foundation Audit §20 item 3).
