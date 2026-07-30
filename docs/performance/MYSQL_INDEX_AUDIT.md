# MySQL Index & Query Audit — MeatBiz POS

Status: **AUDIT ONLY. No indexes created. No schema changed. No DDL executed.** All queries below were run as read-only `SELECT`/`EXPLAIN`/`SHOW INDEX`/`information_schema` lookups against the live dev database (host redacted — internal network address, schema `meat_business_db`, MySQL 8.0.35).

**Scale caveat — applies to every row below:** every table is currently 0–566 rows. `EXPLAIN`'s `rows` estimate is near-meaningless as a timing signal at this scale. Every finding is framed on **access type / key usage / Extra flags** (what the query *shape* will do at 10k-100k+ rows), not on anything being measurably slow today — nothing is.

---

## 1. Existing Index Inventory (as audited)

Pulled from `information_schema.STATISTICS`. Key composite indexes already present:

| Table | Index | Columns |
|---|---|---|
| `orders` | `idx_orders_customer_date` | (customer_id, order_date) |
| `orders` | `idx_orders_date_status` | (order_date, status) |
| `orders` | `idx_orders_lock` | (is_locked, locked_at) |
| `order_items` | `idx_order_items_order` | (order_id) |
| `order_items` | `idx_order_items_product_order` | (product_id, order_id) |
| `debt_transactions` | `idx_debt_customer_date` | (customer_id, transaction_date) |
| `payments` | `idx_payments_customer_date` | (customer_id, payment_date) |
| `payments` | `idx_payments_lock` | (is_locked, locked_at, status) |
| `stock_transactions` | `idx_stock_product_date` | (product_id, transaction_date) |
| `stock_transactions` | `idx_stock_transactions_warehouse` | (warehouse_id) |
| `customer_price_books` | `idx_cpb_customer_price_category` | (customer_price_category_id) |
| `customer_price_books` | `idx_price_book_lookup_solar` | (customer_id, effective_calendar_type, status, effective_from, id) |
| `customer_price_books` | `idx_price_book_lookup_lunar` | (customer_id, effective_calendar_type, status, ...lunar_sort..., id) |
| `customer_price_books` | `uq_cpb_customer_category_date_type` | (customer_id, category_id, effective_from, effective_calendar_type) — UNIQUE |
| `customer_price_book_items` | `idx_cpbi_customer_product` | (customer_id, product_id) |
| `customer_price_book_items` | `idx_cpbi_product` | (product_id) |
| `customer_price_book_items` | `uq_cpbi_book_product` | (price_book_id, product_id) — UNIQUE |
| `customer_price_categories` | `idx_cpc_customer` | (customer_id) |
| `customer_price_categories` | `uq_cpc_customer_category` | (customer_id, category_id) — UNIQUE |
| `products` | `idx_products_owner_code` | (product_owner_user_id, product_code) |
| `products` | (unique) | (product_code) |
| `customers` | (unique) | (customer_code) — **only PRIMARY + this exist** |
| `purchase_orders` | `fk_purchase_supplier` | (supplier_id) |
| `purchase_orders` | `idx_purchase_orders_purchase_date` / `idx_purchase_date` | (purchase_date) — **duplicate pair** |
| `purchase_orders` | `purchase_code` / `uq_purchase_orders_purchase_code` | (purchase_code) — **duplicate UNIQUE pair** |

**Declared FKs:** exactly 31 (`information_schema.KEY_COLUMN_USAGE`), consistent with prior architecture audits. Every declared FK column has InnoDB's auto-created supporting index — no gaps there. The gaps below are entirely in **logical/undeclared relationships**.

---

## 2. Per-Query Findings

### DB-01 — Order list (Orders page)
- **Query pattern:** `SELECT o.*,c.name FROM orders o JOIN customers c ON c.id=o.customer_id WHERE [customer_id IN(...)] [AND DATE(order_date)>=?] [AND DATE(order_date)<=?] [AND c.name LIKE ?] ORDER BY order_date DESC, id DESC`
- **Calling code:** `backend/src/agents/OrderAgent.js:484-497`
- **Current indexes:** `idx_orders_customer_date`, `idx_orders_date_status`
- **EXPLAIN result (ADMIN/STAFF, date-only):** `type:ALL, key:null, Using where; Using filesort`. Cause: `DATE(o.order_date)` wraps the column in a function — non-sargable. Re-tested **without** the wrapper (raw `order_date>=? AND <=?`): still `type:ALL` at current 28-row scale — optimizer judges full scan cheaper than the composite index at this cardinality.
- **EXPLAIN result (CUSTOMER role, customer_id + date):** `type:ref, key:idx_orders_customer_date, Using where; Backward index scan` — correct, will scale fine.
- **Estimated rows:** 28 (whole table).
- **Access type:** ALL (admin path) / ref (customer path).
- **Filesort/temp:** filesort on the admin path (no status filter currently applied; endpoint doesn't read a `status` query param at all today).
- **Recommended index:** none new — `idx_orders_date_status` already covers `(order_date, status)` as a leftmost prefix if status filtering is ever added; the `DATE()` wrapper should be removed from the query (code-side fix, not an indexing fix) to make the range sargable.
- **Write overhead:** N/A (no new index).
- **Storage overhead:** N/A.
- **Redundant-index risk:** none — `idx_orders_customer_date` and `idx_orders_date_status` serve different filter shapes, not redundant.
- **Priority:** P3 (re-verify with `EXPLAIN ANALYZE`/`FORCE INDEX` once real volume exists — current optimizer choice is scale-dependent, not proof of a missing index).

### DB-02 — Order items by order_id
- **Query pattern:** `SELECT * FROM order_items WHERE order_id=? ORDER BY id`
- **Calling code:** `backend/src/agents/OrderAgent.js:509,539`
- **Current indexes:** `idx_order_items_order`
- **EXPLAIN result:** `type:ref, key:idx_order_items_order`, no filesort (PK order aligns with scan order).
- **Recommended index:** **none — already well-indexed.**
- **Priority:** — (no action).

### DB-03 — Debt (`current_debt`) computed live
- **Query pattern (single customer):** `SUM(CASE type IN('SALE','ADJUSTMENT_INCREASE')...) FROM debt_transactions WHERE customer_id=?`
- **Calling code:** `backend/src/agents/PaymentAgent.js:84-86`, `DebtInstallmentAgent.js:6-10`, `backend/src/services/debt.service.js:12-27`
- **Current indexes:** `idx_debt_customer_date`
- **EXPLAIN result (single customer):** `type:ref, key:idx_debt_customer_date, rows:6`. Correct, scales fine.
- **Query pattern (ALL customers, list page):** `FROM customers c LEFT JOIN customers pc ... LEFT JOIN debt_transactions dt ON dt.customer_id=c.id WHERE c.del_flg=0 GROUP BY c.id ORDER BY c.parent_customer_id IS NULL DESC, c.id DESC`
- **Calling code:** `backend/src/agents/CustomerAgent.js:117-137`
- **EXPLAIN result:** `customers` scanned via `type:index` (full index scan on PRIMARY), **`Using where; Using temporary; Using filesort`**; `debt_transactions` joins correctly via `idx_debt_customer_date` (`type:ref`).
- **Estimated rows:** 29 customers × their debt_transactions.
- **Access type:** index scan (customers side) + ref (debt side).
- **Filesort/temp-table status:** **both present** — caused by the `ORDER BY c.parent_customer_id IS NULL DESC, c.id DESC` expression, which no index can serve.
- **Recommended index:** none fixes the aggregation itself (architectural cost of "debt is never stored, always computed live"); the filesort is addressable via restructuring the `ORDER BY` or a functional index, but that's a query-shape change, not a new-index recommendation.
- **Redundant-index risk:** N/A.
- **Explicit date-range variant tested** (`customer_id=? AND transaction_date BETWEEN ? AND ?`, not currently used by any code path): `type:range, key:idx_debt_customer_date, Using index condition` — confirms the existing composite would serve a future date-bounded query correctly with **no new index needed**.
- **Priority:** P2 for the Customers-list filesort/full-scan (runs on every Partners page load — see `BACKEND_ENDPOINT_PERFORMANCE_MATRIX.md` NET-05); this is the query in the whole audit most predictable to degrade at scale.

### DB-04 — Stock transactions ledger
- **Query pattern (product + date range):** covered by `idx_stock_product_date` — `type:ref`/`type:range` depending on filter, `Using index condition; Using where`. **Well-indexed, no gap.**
- **Calling code:** `backend/src/agents/StockLedgerAgent.js:31-146`
- **Architectural note (not an indexing gap):** date/reference_type/affect_stock filters are deliberately *not* pushed into the base running-balance CTE (per the code's own comment) — the running balance must be computed over a product's *entire* unfiltered history for correctness. At scale, a product with e.g. 50k lifetime ledger rows has all 50k read+window-summed on every ledger request, regardless of the requested date slice. No index changes this — a future pagination/snapshot model would (flagged for the roadmap, not an index fix).
- **Query pattern (reference lookup):** `SELECT * FROM stock_transactions WHERE reference_type=? AND reference_id=?`
- **Calling code:** `backend/src/agents/StockLedgerAgent.js:60,73`
- **EXPLAIN result:** `type:ALL, key:null, rows:240` (entire table).
- **Current indexes:** **none on either column.**
- **Recommended index:** `(reference_type, reference_id)` composite — no existing index covers this as a leftmost prefix.
- **Write overhead:** low — `stock_transactions` is append-only (insert-heavy, no updates to indexed columns), one extra index maintained per insert.
- **Storage overhead:** low-moderate, proportional to table size (currently 240 rows).
- **Redundant-index risk:** none — no existing index starts with `reference_type`.
- **Priority:** **P1** (genuine, size-independent gap — "show movements for this order/receive/lot" is a plausible frequently-used lookup).

### DB-05 — Customer price book resolution (business-critical)
Two distinct resolution paths, using **different** indexes — documented separately to avoid "fixing" the wrong one.

**Path 1 — `getEffectivePrice()`/`getEffectivePricesForCategory()`** (filters by `customer_price_category_id`, not `customer_id` directly)
- **Calling code:** `backend/src/services/PriceBookService.js:145-223,281-338`
- **Current indexes:** `idx_cpb_customer_price_category` (single-column)
- **EXPLAIN result (single-product):** `type:ref, key:idx_cpb_customer_price_category`, then `eq_ref` join; **`Using where; Using filesort`** — the `ORDER BY effective_from DESC, id DESC LIMIT 1` can't be served by the single-column index.
- **EXPLAIN result (bulk/category):** same `ref` access feeding a `ROW_NUMBER()` window function; `Using where; Using temporary; Using filesort` on the inner query.
- **Recommended index:** composite `(customer_price_category_id, effective_calendar_type, status, effective_from, id)` — mirrors the existing `idx_price_book_lookup_solar`/`_lunar` composites but keyed on category instead of customer. Would eliminate the filesort at scale.
- **Redundant-index risk:** `idx_price_book_lookup_solar`/`_lunar` do **not** cover this query (keyed on `customer_id`, not `customer_price_category_id`) — a new index here is not redundant with them.
- **Write overhead:** moderate — `customer_price_books` is a moderate-write table (price-book edits), one more composite to maintain.
- **Priority:** P2 (roadmap candidate, not urgent at current volumes — single-digit candidate rows today).

**Path 2 — `findActiveBookItemsForPartner()`** (filters by `customer_id` directly)
- **Calling code:** `backend/src/services/PriceBookService.js:231-279`
- **EXPLAIN result:** `type:ref, key:uq_cpb_customer_category_date_type` (a UNIQUE index being reused for lookup), `Using index condition; Using where; Using filesort`.
- **Observation:** `idx_price_book_lookup_solar`/`_lunar` (ending in `effective_from,id` / `effective_lunar_sort,id`) *appear* purpose-built for exactly this call site and would remove the filesort here — but MySQL is currently choosing the unique index instead. **Worth an explicit follow-up with the team on whether those two indexes are meant for this call site**, in which case they may be redundant with `uq_cpb_customer_category_date_type` for this specific access pattern. Not a "missing index" finding — a "possibly redundant/underused index" finding.
- **Priority:** P3 (follow-up investigation, not an action item yet).

### DB-06 — Product search (name/product_code)
- **Query pattern:** `WHERE del_flg=0 AND is_active=1 AND (name LIKE '%x%' OR product_code LIKE '%x%')`
- **Calling code:** `backend/src/agents/ProductAgent.js:132-162`
- **Current indexes:** UNIQUE on `product_code` (exact-match only, doesn't help `LIKE '%x%'`); no index on `name`.
- **EXPLAIN result:** `type:ALL, Using where; Using temporary; Using filesort` (temp/filesort caused by the `ORDER BY pc.sort_order, p.name` after the join, not the WHERE).
- **Estimated rows:** 81 (whole active catalog).
- **Access type:** ALL — **expected, not fixable by a normal B-tree index**: leading-wildcard `LIKE '%x%'` can never use a standard index regardless of what's added.
- **Recommended index:** two roadmap options, neither implemented: (a) `FULLTEXT` index on `(name, product_code)` if natural-language search is an actual requirement; (b) restrict the UI to prefix search (`LIKE 'x%'`, index-usable) if leading-wildcard isn't genuinely required.
- **Write overhead:** FULLTEXT adds meaningful write overhead (tokenization on every insert/update) — only worth it if leading-wildcard search is confirmed necessary.
- **Redundant-index risk:** N/A (no index exists to be redundant with).
- **Priority:** P2 (real risk at scale — thousands of products means a full-table-scan-per-keystroke-search) but **REQUIRES_CTO_DECISION** on which of the two directions to take (Foundation Audit-adjacent decision, not listed there — add if pursued).

### DB-07 — Customer/partner search
- **Query pattern (name):** `backend/src/services/customer.service.js:3-13` — `type:ALL, rows:29`. No index on `name`/`del_flg`. Same leading-wildcard caveat as DB-06.
- **Query pattern (role bitmask):** `backend/src/agents/PartnerAgent.js:11-38` — `(partner_type & 2) = 2`, `type:ALL, Using where; Using filesort`. A masked-equality predicate is inherently non-sargable regardless of indexing — at scale this always degrades to a full scan unless the bitmask pattern itself is redesigned (e.g. decomposed into boolean columns) — **documented only, no schema change proposed**.
- **`customers.del_flg`:** confirmed no index at all (only `PRIMARY` + `customer_code` exist on this table).
- **Recommended index:** none that resolves the wildcard/bitmask patterns themselves; a `(del_flg)` or `(del_flg, name)` composite would help *other* filtered queries on this table that don't also carry a wildcard/bitmask predicate, but doesn't fix DB-07's specific queries.
- **Priority:** P3 (documented for roadmap awareness; no clean index fix exists for the two dominant query shapes here).

### DB-08 — Purchase order list (supplier/partner + status + date)
- **Query pattern:** `WHERE del_flg=0 AND supplier_id=? AND status=? AND purchase_date BETWEEN ? AND ? ORDER BY id DESC` (also has a `partner_id`-filtered branch)
- **Calling code:** `backend/src/agents/InventoryPurchaseAgent.js:14-42`
- **Current indexes:** `fk_purchase_supplier` (single-column, supplier_id only)
- **EXPLAIN result (supplier path):** `type:ref, key:fk_purchase_supplier, Using where; Backward index scan` — only the `supplier_id` equality is served; `status`/`purchase_date` are post-filtered.
- **EXPLAIN result (partner_id path):** `type:ALL, rows:14` (whole table). **`partner_id` has zero index support** — confirmed via `information_schema.STATISTICS`; not a DB-declared FK either (only `supplier_id`/`created_by` are declared FKs on this table per the 31-FK list). Per the agent's own docstring, `partner_id` is the "primary" identifier under BP-003 — this is the more consequential of the two gaps.
- **Recommended index:** `(supplier_id, status, purchase_date)` and `(partner_id, status, purchase_date)` — no existing composite covers either as a leftmost prefix beyond the bare `supplier_id` equality.
- **Write overhead:** low-moderate (`purchase_orders` is not high-write).
- **Redundant-index risk:** **existing redundancy found, unrelated to this recommendation** — `idx_purchase_orders_purchase_date` and `idx_purchase_date` are exact duplicates of each other; `purchase_code` UNIQUE is also declared twice (`purchase_code` and `uq_purchase_orders_purchase_code`). Cleanup candidates, not additions.
- **Priority:** P2 for the `partner_id` composite (**REQUIRES_CTO_DECISION**: Foundation Audit §20 item 4 — is `partner_id` now the sole path forward, making the `supplier_id` composite lower priority?); P4 for the duplicate-index cleanup (harmless but wasteful).

### DB-09 — Soft-delete reference checks
- **Query pattern 1 (`hasReferences()` loop):** `SELECT COUNT(*) FROM <table> WHERE <column>=?` — does **not** filter `del_flg` (a soft-deleted referencing row still blocks parent deletion — appears intentional, a correctness note not a perf one).
- **Calling code:** `backend/src/agents/SoftDeleteAgent.js:48-55`
- **Most checks are well-indexed** (`orders.customer_id` via `idx_orders_customer_date`, `order_items.product_id`, `stock_transactions.product_id`, `customer_price_book_items.product_id`, `purchase_lots.supplier_id`, `supplier_purchase_options.supplier_id`, `purchase_orders.supplier_id`, `inventory_receives.supplier_id`, `supplier_payments.lot_id` — all verified with direct or leftmost-prefix index support).
- **Exception:** `customer_price_categories.category_id` check — `type:index` (full index scan of `uq_cpc_customer_category`, used as a covering scan since `category_id` happens to be its 2nd column) — **not a `ref` lookup**, because no index has `category_id` as a leftmost column on this table. At scale this is a full index scan proportional to total rows, not matching rows.
- **Recommended index:** `(category_id, ...)` composite or standalone, to turn this into a true `ref` lookup.
- **Priority:** P3.
- **Query pattern 2 (`deletedList()`):** `SELECT * FROM <table> WHERE del_flg=1 ORDER BY deleted_at DESC`
- **Calling code:** `SoftDeleteAgent.js:81-85`
- **EXPLAIN result:** `type:ALL, Using where; Using filesort` (tested on `customers`). **No index on `del_flg`/`deleted_at`** on any of the 5 tables carrying `del_flg` (`customers`, `orders`, `products`, `purchase_orders`, `suppliers`, verified via `information_schema.COLUMNS`).
- **Recommended index:** `(del_flg, deleted_at)` composite — would serve this as a `ref`+ordered-range scan.
- **Priority:** P4 (admin/restore screen, not a hot path — low urgency despite the clean gap).

### DB-10 — `purchase_lots` cost aggregation (feeds the Profit report, RPT-03)
- **Query pattern:** date-range aggregation of `purchase_lots` cost by day
- **Calling code:** `backend/src/agents/ReportAgent.js:113-119`
- **Current indexes:** `SHOW INDEX FROM purchase_lots` confirms only `PRIMARY`, `lot_code`, `supplier_id`, `created_by` — **no index on `purchase_date` or `del_flg` at all.**
- **EXPLAIN result:** `type:ALL, key:null` — a genuine full table scan **regardless of table size**, not an optimizer choice at small cardinality (unlike most other `type:ALL` findings in this audit, there is no candidate index here to even consider using).
- **Recommended index:** `(purchase_date, del_flg)` or `(del_flg, purchase_date)` composite.
- **Write overhead:** low (`purchase_lots` is not high-write).
- **Redundant-index risk:** none — no existing index touches these columns.
- **Priority:** **P1** — this is the one query in the whole audit that will necessarily full-scan at any table size, feeding directly into the highest-complexity report (`GET /api/reports/profit`).

---

## 3. Summary — Concrete Gaps Table

| # | Gap | Table.column(s) | Query source | Type | Recommended index | Priority |
|---|---|---|---|---|---|---|
| 1 | No index | `stock_transactions.(reference_type, reference_id)` | `StockLedgerAgent.js:73` | Genuine, size-independent | `(reference_type, reference_id)` | **P1** |
| 2 | No index | `purchase_lots.(purchase_date, del_flg)` | `ReportAgent.js:113-119` | Genuine, size-independent | `(purchase_date, del_flg)` or `(del_flg, purchase_date)` | **P1** |
| 3 | No index | `purchase_orders.partner_id` | `InventoryPurchaseAgent.js:18-19` | Genuine, size-independent | `(partner_id, status, purchase_date)` | P2 (pending CTO decision) |
| 4 | Partial index | `purchase_orders.supplier_id` (status/date not covered) | `InventoryPurchaseAgent.js:20-22` | Optimizer-dependent at scale | `(supplier_id, status, purchase_date)` | P2 (pending CTO decision) |
| 5 | Filesort on lookup | `customer_price_books` keyed by `customer_price_category_id` | `PriceBookService.js:281-338` | Optimizer-dependent at scale | `(customer_price_category_id, effective_calendar_type, status, effective_from, id)` | P2 |
| 6 | No leftmost-prefix index | `customer_price_categories.category_id` | `SoftDeleteAgent.js:51` | Optimizer-dependent at scale | `(category_id)` or `(category_id, customer_id)` | P3 |
| 7 | No index | `customers.(del_flg, deleted_at)` | `SoftDeleteAgent.js:83` | Optimizer-dependent at scale | `(del_flg, deleted_at)` | P4 |
| 8 | No index (not fixable by index) | `products.name`/`product_code` for `LIKE '%x%'` | `ProductAgent.js:134` | Fundamental — needs FULLTEXT or query-shape change | FULLTEXT, or restrict to prefix search | P2 (CTO decision on direction) |
| 9 | No index (not fixable by index) | `customers.name` for `LIKE`; `partner_type` bitmask | `customer.service.js`, `PartnerAgent.js` | Fundamental — same caveat as #8, plus bitmask non-sargability | Documented only, no clean fix proposed | P3 |
| 10 | **Redundant indexes** (cleanup, not addition) | `purchase_orders` | — | N/A | Remove duplicate `purchase_code` unique pair and duplicate `purchase_date` pair | P4 |
| 11 | Architectural, not indexable | `stock_transactions` ledger CTE (full per-product history read+summed every request) | `StockLedgerAgent.js:31-146` | N/A | Snapshot/checkpoint model (roadmap-level, not an index) | Deferred |
| 12 | Architectural, not indexable | `customers × debt_transactions` list aggregate (filesort from non-indexable ORDER BY) | `CustomerAgent.js:117-137` | N/A | Restructure ORDER BY, or a cached/materialized debt column (roadmap-level, not an index) | Deferred |

No index was created. No `CREATE INDEX`/`ALTER TABLE` statement was executed at any point in this audit — every result above came from `EXPLAIN`, `SHOW INDEX`, or `information_schema` queries only.
