# Frontend Performance Matrix — MeatBiz POS

Status: **AUDIT ONLY. No code modified.** Companion to `PERFORMANCE_FOUNDATION_AUDIT.md`.

Format per finding: ID · Layer · Module · File/method · Current behavior · Evidence · Impact · Frequency · Data-size sensitivity · Correctness risk · Regression risk · Recommendation · Estimated effort · Priority · Status.

Priority: P0 critical · P1 high · P2 important · P3 low-impact · P4 not worth it now.
Status: VERIFIED · PROBABLE · NEEDS_MEASUREMENT · FALSE_POSITIVE · DEFERRED.

---

## Section A — Rendering (Phase 1)

### FE-R-01
- **Layer/Module:** Frontend rendering / POS
- **File:** `frontend/src/pages/CreateOrder.jsx:787-792`
- **Current behavior:** `selected`/`total`/`totalQty` computed inline in the component body (not `useMemo`) via `items.map(...).filter(...)` on every render.
- **Evidence:** cited lines; not wrapped in `useMemo`, unlike the sibling `shown` derivation at `:725-733` which is (FE-R-09, false positive contrast).
- **Impact:** re-runs the (non-trivial, see FE-R-02) per-item quantity calc for the whole cart on every render of a ~70-`useState` component (FE-R-03).
- **Frequency:** every render — i.e. near every keystroke/state change anywhere on the POS screen.
- **Data-size sensitivity:** scales with cart line-item count.
- **Correctness risk:** none — pure refactor.
- **Regression risk:** low — standard `useMemo([items])` wrap.
- **Recommendation:** wrap in `useMemo` keyed on `items`.
- **Estimated effort:** S (< 1hr).
- **Priority:** P2.
- **Status:** PROBABLE.

### FE-R-02
- **Layer/Module:** Frontend rendering / POS / shared utility
- **File:** `frontend/src/utils/qtyExpression.js:23`, called from `CreateOrder.jsx` (FE-R-01) and `frontend/src/components/pos/POSProductTableAgent.jsx:104`
- **Current behavior:** `calcQtyExpression` evaluates via `new Function('"use strict"; return (' + expr + ')')()` — constructs and invokes a new dynamic Function object per call, no caching, no expression parser.
- **Evidence:** cited lines; called twice per row per render (once in `selected`, once in the table row).
- **Impact:** `new Function()` construction cost is materially higher than arithmetic parsing; duplicated per-row across two call sites compounds it.
- **Frequency:** per visible row, per render.
- **Data-size sensitivity:** scales with visible catalog row count.
- **Correctness risk:** none if refactored to compute once and pass the number down.
- **Regression risk:** medium if replacing the evaluator itself (must preserve all currently-supported expression syntax e.g. "2.5kg", "3 con" per `qtyExpression.js`'s documented grammar) — low if only deduplicating the two call sites.
- **Recommendation:** compute once per row (in the `selected`/table-data derivation) and pass the resolved number down instead of recomputing in the table; consider a non-eval evaluator only as a separate, larger follow-up.
- **Estimated effort:** S (dedup) / L (replace evaluator).
- **Priority:** P2.
- **Status:** PROBABLE.

### FE-R-03
- **Layer/Module:** Frontend rendering / POS architecture
- **File:** `frontend/src/pages/CreateOrder.jsx:43-153`
- **Current behavior:** ~70 `useState` hooks in one ~1900-line component; every `setX` re-renders the whole tree and recreates every inline handler passed to children.
- **Evidence:** cited range; zero `React.memo` usage anywhere in `components/pos/` (grep-confirmed), so today's inline-prop churn is inert — nothing downstream currently skips render on stable props anyway.
- **Impact:** becomes a real bottleneck specifically because `POSProductTableAgent` re-renders its full row list on every one of these state changes (compounds with FE-R-04).
- **Frequency:** every state change on the page.
- **Data-size sensitivity:** independent of data size; compounds with row-count-sensitive findings.
- **Correctness risk:** none to observe; real risk if attempted as a large state-splitting refactor without careful regression testing (this is the most complex file in the app per project history).
- **Regression risk:** HIGH if attempted — structural change to the most business-critical screen in the app.
- **Recommendation:** not a quick fix; only worth doing together with FE-R-01/04 once those are addressed and the remaining cost is measured. Direction: split bill-header UI-toggle state from bill-line (`items`) state into separate components/contexts.
- **Estimated effort:** XL.
- **Priority:** P3 (structural, defer).
- **Status:** PROBABLE.

### FE-R-04
- **Layer/Module:** Frontend rendering / POS
- **File:** `frontend/src/components/pos/POSProductTableAgent.jsx:103`
- **Current behavior:** inside `shown.map(...)`, each row does `items.findIndex(x=>x.product_id===i.product_id)` to resolve its own index — O(rows_shown × items.length) on every render, not just on data change (component is not memoized, re-renders per FE-R-03).
- **Evidence:** cited line; mirrored exactly in `frontend/src/pages/PriceMatrix.jsx:513` (FE-R-10).
- **Impact:** quadratic cost recomputed per keystroke anywhere on the page, for any category over ~50-100 products.
- **Frequency:** every render of the table.
- **Data-size sensitivity:** HIGH — quadratic in catalog size.
- **Correctness risk:** none — pure lookup-strategy change.
- **Regression risk:** low.
- **Recommendation:** build an id→index `Map` once via `useMemo`, pass row index down via the map instead of `findIndex`.
- **Estimated effort:** S.
- **Priority:** P1.
- **Status:** VERIFIED.

### FE-R-05
- **Layer/Module:** Frontend rendering / POS
- **File:** `frontend/src/components/pos/POSProductTableAgent.jsx:126,143`
- **Current behavior:** inline callback refs (`ref={el=>qtyRefs.current[i.product_id]=el}`) create a new function identity every render, causing React to null/reassign every row's ref every render.
- **Evidence:** cited lines.
- **Impact:** individually cheap; stacks with FE-R-01/02/04 in the hottest render path in the app.
- **Frequency:** every render, every row.
- **Data-size sensitivity:** scales with visible row count.
- **Correctness risk:** none.
- **Regression risk:** low.
- **Recommendation:** wrap in `useCallback` per row (or a stable ref-setter factory) — only after FE-R-04 is fixed and if profiling still shows table-render cost.
- **Estimated effort:** S.
- **Priority:** P3.
- **Status:** PROBABLE (contingent on FE-R-04).

### FE-R-06
- **Layer/Module:** Frontend correctness / race condition
- **File:** `frontend/src/pages/CreateOrder.jsx:322-352,355-374,469-492,573-586`
- **Current behavior:** `reloadCustomerCatalogKeepQty`, `reloadCustomerCatalogClearQty`, `loadCategoryCatalog`, `loadOtherFlowCatalog` all await-then-`setState` with no `AbortController`/staleness guard. Codebase-wide: zero uses of `AbortController` or an ignore-flag pattern anywhere except the Excel/OCR import flow's `importReadSeqRef`/`priceImportReadSeqRef` sequence counters.
- **Evidence:** cited lines; contrast pattern already proven at `CreateOrder.jsx:1301-1330`.
- **Impact:** a cashier double-clicking a customer or rapidly switching category can have an older in-flight response resolve after a newer one and silently clobber the catalog with stale product/price data mid-bill.
- **Frequency:** any rapid customer/category switch (plausible on a touchscreen POS).
- **Data-size sensitivity:** none — pure timing/race issue.
- **Correctness risk:** **real, business-visible** (stale pricing/catalog shown mid-bill).
- **Regression risk:** low — the proven sequence-ref pattern from the import flow can be copied directly.
- **Recommendation:** add a monotonically-increasing request-sequence ref to each of the 4 catalog loaders, matching the existing import-flow pattern.
- **Estimated effort:** M.
- **Priority:** P1.
- **Status:** VERIFIED (correctness risk, not raw perf).

### FE-R-07
- **Layer/Module:** Frontend cleanup / secondary feature
- **File:** `frontend/src/pages/CreateOrder.jsx:1081-1103`
- **Current behavior:** `startVoice()` creates a `SpeechRecognition` instance never stored in a ref, never explicitly `.stop()`'d on unmount or before a new `startVoice()` call.
- **Evidence:** cited lines.
- **Impact:** zombie listener / potential overlapping recognizers if a cashier navigates away mid-listen; low frequency (voice input is secondary).
- **Frequency:** low (voice feature usage only).
- **Data-size sensitivity:** none.
- **Correctness risk:** low (React 18 tolerates silent late setState).
- **Regression risk:** low.
- **Recommendation:** store the recognizer in a ref, `.stop()` on unmount via effect cleanup and before starting a new one.
- **Estimated effort:** S.
- **Priority:** P4.
- **Status:** PROBABLE / LOW IMPACT.

### FE-R-08
- **Layer/Module:** Frontend rendering / Products page
- **File:** `frontend/src/pages/Products.jsx:413-426`
- **Current behavior:** `filteredRows = rows.filter(...)` runs in the component body (not `useMemo`) checking 8 fields per row, against the entire unfiltered `rows` set (`/products` loaded with no server params), on every keystroke (no debounce).
- **Evidence:** cited lines; search input at `:523`.
- **Impact:** cost scales with total product catalog size (not paginated page size), recomputed every keystroke.
- **Frequency:** every keystroke in product search.
- **Data-size sensitivity:** HIGH — linear in total catalog size.
- **Correctness risk:** none.
- **Regression risk:** low.
- **Recommendation:** wrap in `useMemo([rows, productSearch])`; add a short debounce (150ms, matching the `InventoryAdjustments.jsx` precedent, FE-R-13).
- **Estimated effort:** S.
- **Priority:** P2.
- **Status:** PROBABLE / NEEDS_MEASUREMENT (actual production catalog size not confirmed).

### FE-R-09 (false positive, cited for contrast)
- **File:** `frontend/src/pages/CreateOrder.jsx:725-733` (`shown`) — correctly `useMemo`'d. Cited to highlight the inconsistency with FE-R-01 in the same file. **Status: FALSE_POSITIVE.**

### FE-R-10
- **Layer/Module:** Frontend rendering / Price Book admin
- **File:** `frontend/src/pages/PriceMatrix.jsx:513`
- **Current behavior:** `visibleRows.map(r=>{const idx=rows.findIndex(x=>x.product_id===r.product_id);...})` — identical antipattern to FE-R-04, O(rowPageSize × rows.length) per render, re-runs on every keystroke in any `MoneyInput` cell.
- **Evidence:** cited line.
- **Impact:** mirrors FE-R-04's severity/cause for customers with large per-category catalogs.
- **Frequency:** every render.
- **Data-size sensitivity:** HIGH.
- **Correctness risk:** none.
- **Regression risk:** low.
- **Recommendation:** same fix as FE-R-04 — id→index `Map` via `useMemo`. Consider a single shared fix/lint rule since this pattern independently recurred in two files.
- **Estimated effort:** S.
- **Priority:** P1.
- **Status:** VERIFIED.

### FE-R-11
- **Layer/Module:** Frontend data integrity / Orders page
- **File:** `frontend/src/pages/Orders.jsx:151-165`
- **Current behavior:** `reportTotals`/`customerSummaryRows` computed inline (not `useMemo`) from the already-memoized `filtered`, on every render — re-runs on unrelated state changes (toast, saving, bill-edit keystrokes, cancel dialog).
- **Evidence:** cited lines.
- **Impact:** compounds with FE-R-scalability finding on unbounded `Orders.jsx` list (§Scalability, TS-04).
- **Frequency:** every render.
- **Data-size sensitivity:** HIGH — scales with total order history.
- **Correctness risk:** none.
- **Regression risk:** low.
- **Recommendation:** wrap both in `useMemo([reportRows])`.
- **Estimated effort:** S.
- **Priority:** P2.
- **Status:** PROBABLE.

### FE-R-12
- **Layer/Module:** Frontend network + rendering / Orders page
- **File:** `frontend/src/pages/Orders.jsx:60,51-59,74,215`
- **Current behavior:** `useEffect` keyed on `[filters.from,filters.to,filters.customer]` fires a new `GET /payments` request on every keystroke in the customer-name filter — no debounce; `loadPaymentReport` also has no `AbortController`/stale-response guard, so an out-of-order response can overwrite state with mismatched data.
- **Evidence:** cited lines.
- **Impact:** excess network calls scale 1:1 with characters typed, plus a genuine race condition.
- **Frequency:** every keystroke in the customer-name filter.
- **Data-size sensitivity:** independent of size, but response payload itself is unbounded (see Scalability TS-04).
- **Correctness risk:** **real** — visible receipts table can silently mismatch the current filter text.
- **Regression risk:** low — debounce + sequence-ref are additive, non-breaking changes.
- **Recommendation:** debounce 150-300ms (matching `InventoryAdjustments.jsx`); add request-sequence/AbortController guard.
- **Estimated effort:** S-M.
- **Priority:** P1.
- **Status:** VERIFIED.

### FE-R-13 (positive reference, cited for contrast)
- **File:** `frontend/src/pages/InventoryAdjustments.jsx:164-167,221-254` — 150ms debounce + fully memoized `dirtyRows`/`totals`/`filteredRows`/`summary`. **Status: FALSE_POSITIVE** (this is the pattern other pages should copy — see FE-R-08/12 recommendations above).

---

## Section B — Table/List Scalability (Phase 2)

| ID | Page/Table | Endpoint | Pagination | Search | Sort | Risk @1k rows | Risk @10k rows | Recommended future model | Priority | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| TS-01 | CreateOrder POS product table | `GET /price-matrix/:id/catalog/order` | None (full category) | Client (memoized) | Client (drag reorder) | Low (per-customer category size likely bounded) | NEEDS_MEASUREMENT | Keep as-is unless a category genuinely grows very large | P4 | NEEDS_MEASUREMENT |
| TS-02 | `Products.jsx` | `GET /products` | Client (page/pageSize) | Client, unmemoized (FE-R-08) | None | Medium — full catalog + unmemoized filter | High | Server-side search/pagination | P2 | PROBABLE |
| TS-03 | `Customers.jsx` | `GET /customers` | Client | Client, unmemoized | None | Low (partner counts typically smaller than product catalogs) | Medium | Server-side pagination if sub-customer counts grow | P3 | NEEDS_MEASUREMENT |
| TS-04 | `Orders.jsx` (bill history) | `GET /orders` | **None** — loads everything | Client, memoized | None | Medium (order history grows every business day) | **High** | Server-side date-range + pagination, matching `StockLedger.jsx` | **P1** | **VERIFIED** |
| TS-05 | `Orders.jsx` (payment report) | `GET /payments` | Client | **Server, per-keystroke, no debounce (FE-R-12)** | None | Medium | High | Debounce + server pagination | P1 | VERIFIED |
| TS-06 | `InventoryAdjustments.jsx` | `GET /products?inventory_mode=TRACK_STOCK` | **None** (all rows always mounted, by design) | Client, debounced+memoized (good) | None | Medium (all TRACK_STOCK rows always live in DOM) | High if TRACK_STOCK catalog grows into hundreds+ | Row virtualization (react-window) only if catalog size actually grows — deliberate stock-count UX trade-off, not a bug today | P3 | PROBABLE / NEEDS_MEASUREMENT |
| TS-07 | `InventoryPurchases.jsx` (list) | `GET /inventory-purchases` | **None** | Server (`status`,`partner_id`) | None | Low-Medium | Medium-High (PO history accumulates over years) | Add `limit`/`offset` | P2 | PROBABLE |
| TS-08 | `PriceMatrix.jsx` | `GET /price-matrix/:id` | Client (rowPage/rowPageSize) | Client, memoized (good) | Client (drag reorder) | Low-Medium | Medium (depends on max category size) | Server-side pagination if categories grow very large | P3 | NEEDS_MEASUREMENT |
| TS-09 | `Lots.jsx` | `GET /lots` | Client | Unverified in depth | Unverified | Medium | High (lot history is unbounded/ever-growing) | Same server-pagination treatment as Orders.jsx | P2 | PROBABLE (needs follow-up review) |
| TS-10 | `StockLedger.jsx` (reference pattern) | `GET /stock-ledger` | **Server** (page/limit) | **Server** (multiple params) | Server | Low | Low | None — this is the target pattern | — | FALSE_POSITIVE (positive reference) |
| TS-11 | `Revenue.jsx`/`Profit.jsx` (period rows) | `GET /reports/revenue`/`/profit` | N/A (server-aggregated by period) | Date-range params (server) | N/A | Low | Low | None for period rows; see BACKEND matrix for `Profit.details` unbounded array | — | FALSE_POSITIVE for period rows |

---

## Section C — Network (Phase 3)

### NET-01
- **Layer/Module:** Frontend network / POS catalog loading
- **File:** `frontend/src/pages/CreateOrder.jsx:335+347, :359+368, :476+485, :580+582`
- **Current behavior:** every one of 4 catalog-load call sites (`reloadCustomerCatalogKeepQty`, `reloadCustomerCatalogClearQty`, `loadCategoryCatalog`, `loadOtherFlowCatalog`) calls `GET /price-matrix/:id/catalog/order` (which already embeds `sale_price`/`price_type`/`price_book_id` per row — confirmed in `backend/src/agents/PriceMatrixAgent.js:606-611`), then immediately calls `POST /price-matrix/:id/effective-prices` again for the same product set — which internally re-derives the same prices via the same underlying resolver.
- **Evidence:** cited lines both frontend and backend; `applyEffectivePrices` wraps the call in a try/catch that silently returns `{}` on failure with a comment "If backend is not yet upgraded, do not block POS" — reads as dead migration-era code.
- **Impact:** doubles price-resolution backend work (compounding with the backend N+1 finding on `OrderAgent.create()`, though this specific call goes through the already-fixed bulk path) on every catalog load.
- **Frequency:** every customer/category switch.
- **Data-size sensitivity:** scales with category size.
- **Correctness risk:** none currently (redundant, not wrong) — but removing it requires confirming no UI path depends on the follow-up call's specific timing.
- **Regression risk:** low-medium — requires the REQUIRES_CTO_DECISION in the foundation audit (§20 item 1) before removing.
- **Recommendation:** confirm `catalog/order`'s embedded prices are authoritative for current needs; if so, delete the follow-up call at all 4 sites (keep only where a genuine "recompute without full reload" need exists, e.g. `refreshCurrentItemPrices`).
- **Estimated effort:** S once decision is made.
- **Priority:** P1.
- **Status:** VERIFIED.

### NET-02
- **Layer/Module:** Frontend network / POS customer selection
- **File:** `frontend/src/pages/CreateOrder.jsx:436-467,499,515`
- **Current behavior:** `loadCustomerCatalog` awaits `GET /handwriting/aliases?customer_id=` then, only after that resolves, awaits the category-resolution chain (`refreshCategoryList` → `loadCategoryCatalog`) — the two are data-independent.
- **Evidence:** cited lines.
- **Impact:** picking a customer with an auto-selected category costs 4 sequential round trips (aliases → categories → catalog/order → effective-prices, the last redundant per NET-01).
- **Frequency:** every customer selection.
- **Data-size sensitivity:** none (round-trip-count, not payload-size, issue).
- **Correctness risk:** none.
- **Regression risk:** low.
- **Recommendation:** `Promise.all([aliases, categorySelectionChain])`.
- **Estimated effort:** S.
- **Priority:** P2.
- **Status:** PROBABLE.

### NET-03
- **Layer/Module:** Frontend network / POS item-add
- **File:** `frontend/src/pages/CreateOrder.jsx:971-1000,1536-1542`
- **Current behavior:** `addQuickProduct`/`addMissingToCatalog` both end by calling `reloadCustomerCatalogKeepQty` — re-running the full category catalog reload (+ NET-01's redundant call) just to reflect one new row; `addMissingToCatalog` additionally does 2 independent sequential POSTs.
- **Evidence:** cited lines.
- **Impact:** disproportionate network cost for a single-item add.
- **Frequency:** every quick-add / missing-item-add action.
- **Data-size sensitivity:** scales with category size.
- **Correctness risk:** none.
- **Regression risk:** low-medium (must ensure the locally-appended row carries correct price/stock data equivalent to a full reload).
- **Recommendation:** append the new row into local `items` state directly instead of refetching the whole category; `Promise.all` the two independent POSTs.
- **Estimated effort:** M.
- **Priority:** P2.
- **Status:** PROBABLE.

### NET-04
- **Layer/Module:** Frontend network / POS mount payload
- **File:** `frontend/src/pages/CreateOrder.jsx:256`, `backend/src/agents/ProductAgent.js:151-159`
- **Current behavior:** `GET /products` with zero params fetches every active product, every column, unfiltered by category/sales-flow, on every POS mount — used only for one narrow feature (`allProducts.filter(...)` at `:1530`, scoping handwriting-OCR alias matching).
- **Evidence:** cited lines.
- **Impact:** full-table, full-column payload fetched unconditionally to support an edge-case feature.
- **Frequency:** every POS session mount.
- **Data-size sensitivity:** HIGH — scales with total store-wide active product count, not the customer's own catalog.
- **Correctness risk:** none.
- **Regression risk:** low.
- **Recommendation:** lazy-load only when the handwriting/OCR panel opens, or expose a lean projection (id, name, code, category_id) instead of `SELECT p.*`.
- **Estimated effort:** M.
- **Priority:** P2.
- **Status:** VERIFIED (payload-size angle).

### NET-05
- **Layer/Module:** Frontend network / Customers page
- **File:** `frontend/src/pages/Customers.jsx:41-47,56,80,135`, `backend/src/agents/CustomerAgent.js:117-137`
- **Current behavior:** full customer list (with a `SUM(debt_transactions)` aggregate computed server-side per row) re-fetched in full after every single add/edit/delete, instead of patching the affected row locally.
- **Evidence:** cited lines.
- **Impact:** re-runs a non-trivial aggregate query on every minor mutation.
- **Frequency:** every customer add/edit/delete.
- **Data-size sensitivity:** scales with total customer + debt_transactions row counts.
- **Correctness risk:** none — `current_debt` must never be cached (see Cache-Candidate table below), but patching the single mutated row from the mutation's own response is safe since it's the freshest possible data for that one row.
- **Regression risk:** low.
- **Recommendation:** patch the single row from the mutation response instead of re-running the full list+aggregate.
- **Estimated effort:** S-M.
- **Priority:** P2.
- **Status:** PROBABLE.

### NET-06
- **Layer/Module:** Frontend network / Retail Daily Summary
- **File:** `frontend/src/pages/RetailDailySummary.jsx:70,84,92`
- **Current behavior:** mount effect awaits `GET /settings` then `convertDate(...)` sequentially, though neither depends on the other's output; only the third call genuinely depends on both.
- **Evidence:** cited lines.
- **Impact:** minor, single-page latency add.
- **Frequency:** every page mount.
- **Data-size sensitivity:** none.
- **Correctness risk:** none.
- **Regression risk:** low.
- **Recommendation:** `Promise.all([settings, convertDate])`, then the dependent third call.
- **Estimated effort:** S.
- **Priority:** P3.
- **Status:** PROBABLE.

### NET-07 (false positives, cited for completeness)
- **EnterpriseAutocomplete.jsx** (customer/product picker) — no network calls at all, pure client-side filter, already memoized+capped. **FALSE_POSITIVE.**
- **Excel/OCR Import Center** (`CreateOrder.jsx` import flow) — zero API calls during preview; entirely client-side via dynamically-imported `xlsx`/`tesseract.js`. **FALSE_POSITIVE.**
- **`Revenue.jsx`/`Profit.jsx`** — exactly one parameterized report call per load, no duplication, no polling. **FALSE_POSITIVE.**
- **No polling found** anywhere in CreateOrder.jsx, Customers.jsx, PriceMatrix.jsx, Revenue.jsx, Profit.jsx, RetailDailySummary.jsx. `InventoryAdjustments.jsx`'s 30s poll (adjacent finding, out of the requested page list) is correctly implemented — gated on clean state, non-blocking. **FALSE_POSITIVE.**

### Cache-Candidate List (Phase 3 deliverable)

| Data | Source of truth | Change frequency | Acceptable staleness | Invalidation | Scope | Cacheable? |
|---|---|---|---|---|---|---|
| `GET /products/categories` | `product_categories` table | Very low (admin CRUD only) | Minutes–hours | Category create/update/delete | App-wide | **Yes** — safe candidate, currently re-fetched independently by CreateOrder/PriceMatrix/Products mounts each session |
| Units list | `units` table | Very low | Minutes–hours | Unit CRUD | App-wide | **Yes** — same reasoning |
| `GET /partners?role=customer` (identity fields only: name/code/phone/address/calendar-type) | `customers` (lean projection, no debt/price) | Low-moderate | Seconds–low minutes | Customer create/update | Per-user session | **Conditionally yes** — only this specific lean endpoint, never `/customers` (which embeds debt) |
| `GET /products` (full catalog, NET-04) | `products` table | Low-moderate | N/A | N/A | N/A | **No — prefer lazy-load over caching.** The fix is not fetching the full unfiltered table on every mount, not caching a mostly-unused large payload |
| Price / price-matrix responses (`catalog/order`, `effective-prices`, `/price-matrix/:id`) | `customer_price_books` + resolution logic | **High — date/book-version dependent** | **None** | N/A | N/A | **NEVER cache** — mutable business pricing data |
| `stock_quantity` / inventory balances (embedded per-row in catalog responses) | `products.stock_quantity` (Single Writer) | **High — every sale/adjustment** | **None** | N/A | N/A | **NEVER cache** — already correctly fetched fresh per load, no separate stock endpoint exists to accidentally cache |
| `current_debt` (Customers.jsx / CustomerAgent.list) | Computed live from `debt_transactions` | **High — every payment/sale** | **None** | N/A | N/A | **NEVER cache** — explicitly flagged since NET-05's fix might tempt a "just cache the list" shortcut; must not include this field |
| Permissions/roles (`UserPermissions.jsx`) | `role_menu_permissions`/`user_menu_permissions` | N/A — out of Phase 3 scope | N/A | N/A | N/A | **NEVER cache** per audit rule; noted for the roadmap, not evidence-backed in this pass |

---

## Section D — Bundle/Loading (Phase 4)

Real `vite build` output (2026-07-28, 2550 modules, 5.62s build time):

### BUNDLE-01
- **Layer/Module:** Frontend bundle / route splitting
- **File:** `frontend/src/App.jsx:1-31` (all 29 page imports are static), `frontend/vite.config.js` (no `manualChunks`)
- **Current behavior:** main JS chunk is 1,064.33 KB / 295.16 KB gzip — every page component and its dependencies (recharts, lucide-react, qrcode, all page code) bundled into one chunk, loaded on first paint regardless of which page the user lands on.
- **Evidence:** real build output; grep-confirmed zero `React.lazy`/`Suspense` usage anywhere in `frontend/src`.
- **Impact:** every user downloads/parses the entire app's code (including rarely-visited admin pages like `UserPermissions.jsx`, `OCRProviders.jsx`, `ProductionCheck.jsx`) before the first page renders.
- **Frequency:** every fresh page load.
- **Data-size sensitivity:** none (fixed cost per load, not per data volume).
- **Correctness risk:** low if done carefully (lazy-loaded routes need a loading fallback; must verify no page relies on synchronous availability of another page's module).
- **Regression risk:** medium — must verify all cross-page imports/shared state still resolve correctly after splitting.
- **Recommendation:** route-level `React.lazy`/`Suspense` for at least the largest and/or least-frequently-visited pages (candidates: `UserPermissions.jsx`, `OCRProviders.jsx`, `ProductionCheck.jsx`, `SponsorVideos.jsx`, `BusinessPortal.jsx`, `Registrations.jsx`, `UserCustomerMapping.jsx` — all admin/occasional-use pages). Do not split tiny modules merely to increase chunk count.
- **Estimated effort:** M.
- **Priority:** P2.
- **Status:** VERIFIED.

### BUNDLE-02 (false positive, cited for contrast)
- **File:** `frontend/src/pages/CreateOrder.jsx:1308,1513`, `PriceMatrix.jsx:299`, `ProductImageImport.jsx:25`
- **Current behavior:** `xlsx` (429.03 KB / 143.08 KB gzip, confirmed as its own chunk in the build output) and `tesseract.js` are both already correctly dynamically imported (`await import(...)`) everywhere they're used.
- **Status: FALSE_POSITIVE** — this is already-good practice, explicitly cited so it isn't mistakenly "fixed" again or flagged as a problem in the roadmap.

### BUNDLE-03
- **Layer/Module:** Frontend bundle / CSS
- **File:** `dist/assets/index-*.css`
- **Current behavior:** 97.64 KB / 17.22 KB gzip, single global stylesheet.
- **Impact:** low — CSS payload is small relative to JS; not a priority finding.
- **Recommendation:** none at this time.
- **Estimated effort:** —.
- **Priority:** P4.
- **Status:** FALSE_POSITIVE / not worth optimizing now.

---

## Section E — Shared Infrastructure (cross-cutting)

### FE-INFRA-01 (false positive, confirms prior fix)
- **File:** `frontend/src/components/common/Dialog.jsx:37-58`
- **Current behavior:** confirmed — unmounts children on close (`if(!open) return null`), Escape/backdrop/focus-restore effect correctly scoped via the `onCloseRef` pattern.
- **Evidence:** grep of the entire frontend confirms this is the **only** place that ever needed the fix; `CalendarDialog.jsx` has no `useEffect` at all, so the bug class doesn't apply there.
- **Status: FALSE_POSITIVE** (already fixed, no regressions, no siblings need the same treatment).

### FE-INFRA-02 (false positive, positive reference)
- **File:** `frontend/src/components/common/EnterpriseAutocomplete.jsx:73-80`
- **Current behavior:** `filtered` correctly `useMemo`'d, capped at `MAX=50` results, fed unbounded `items` arrays by callers.
- **Status: FALSE_POSITIVE** — this is the correct reference pattern for "search filtering on every keystroke," already in use in the highest-traffic customer-search field.

### FE-INFRA-03
- **File:** `frontend/src/components/pos/POSHeaderAgent.jsx`, `POSPaymentPanelAgent.jsx`
- **Current behavior:** defined but not imported/used anywhere by `CreateOrder.jsx` — dead code from an earlier POS layout iteration.
- **Impact:** none on performance (not rendered); flagged for code-cleanliness only.
- **Priority:** P4.
- **Status:** FALSE_POSITIVE (dead code, not a perf issue).
