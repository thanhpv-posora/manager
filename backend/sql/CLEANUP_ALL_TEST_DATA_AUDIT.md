# Safe Test-Data Cleanup — Audit Report

Status: **AUDIT + SCRIPT GENERATION ONLY. No SQL executed. No database data modified. No commit. No push.**

Generated against a live, read-only inspection of the database on 2026-07-28 (same environment audited by the prior `audit_non_master_data_reset.md`).

---

## 1. Purpose

Produce a safe, evidence-based cleanup package that removes (a) all transactional/test data accumulated during development and testing, and (b) all Claude-generated demo Master Data (`DEMO_`-coded rows created by `restore_demo_data.sql`), while preserving every real Master Data record and all security/configuration data. This supersedes the scope of the prior `reset_non_master_data.sql`, which preserved *all* Master Data indiscriminately — that is no longer correct now that some Master Data (the demo rows) is itself disposable test output.

## 2. Scope

- **Stage A** — delete all transactional/non-master data, in FK-safe order. Identical scope and order to the previously-audited `reset_non_master_data.sql` (re-verified live for this task, see §3).
- **Stage B** — delete only Claude-created demo Master Data, identified exclusively by exact stable codes/names resolved from `restore_demo_data.sql`, plus exact foreign-key relationships to the IDs those codes resolve to. No broad pattern matching (`LIKE '%DEMO%'`) is used to select any row for deletion anywhere in this package.
- Out of scope: schema changes, index changes, AUTO_INCREMENT resets (optional/disabled by default), execution of any script, execution of `restore-demo-opening-stock.js`.

## 3. Database Evidence

- **Engine/version:** MySQL 8.0.35, InnoDB (all 64 tables, unchanged from the prior audit's confirmed count).
- **sql_mode (live-queried):** `IGNORE_SPACE,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION`.
- **Triggers/views/routines/events:** none (re-confirmed consistent with the prior audit — all business logic lives in the Node application layer).
- **Declared foreign keys:** 31 (`information_schema.KEY_COLUMN_USAGE`), unchanged from the prior audit.
- **Current live row counts** (re-queried for this task, 2026-07-28):

| Table | Rows | Table | Rows |
|---|---|---|---|
| `orders` | 28 | `purchase_order_items` | 24 |
| `order_items` | 198 | `purchase_orders` | 14 |
| `payments` | 9 | `purchase_lots` | 4 |
| `payment_allocations` | 10 | `purchase_lot_items` | 0 |
| `payment_unapplied_credits` | 0 | `supplier_payments` | 4 |
| `debt_transactions` | 35 | `supplier_payable_transactions` | 0 |
| `debt_installment_plans` | 0 | `supplier_purchase_payments` | 0 |
| `debt_installment_payments` | 0 | `price_change_logs` | 196 |
| `debt_monthly_installments` | 1 | `import_audit_logs` | 0 |
| `stock_transactions` | 239 | `ai_action_logs` | 671 |
| `inventory_adjustments` | 1 | `ai_error_logs` / `ai_learning_logs` / `ai_chat_sessions` | 0 / 0 / 0 |
| `inventory_receives` | 10 | `retail_daily_summary` | 1 |
| `inventory_receive_items` | 19 | `delete_logs` | 0 |
| `customer_product_prices` | 0 | `product_ocr_aliases` | 31 |

- **DEMO Master Data currently present:** **zero rows** in every candidate table (`warehouses`, `product_categories`, `units`, `customers`, `suppliers`, `products` — each queried live for `code LIKE 'DEMO%'`/`name LIKE 'DEMO%'`). This confirms `restore_demo_data.sql` has never actually been executed against this database, consistent with every prior report in this engagement ("no SQL executed"). **The Stage B deletion package below is therefore expected to affect 0 rows if run today** — it is written generically and defensively so it remains correct and safe if demo data is created (in this or any other environment) before cleanup is eventually run.

## 4. Existing Reset/Restore Scripts Audited

- `backend/sql/restore_demo_data.sql` — read in full. Exact demo identifiers extracted (§8).
- `backend/scripts/restore-demo-opening-stock.js` — read in full. `OPENING_QTY` updated from `50` to `10` per the CTO decision recorded in this task (file edited, **helper not executed**). Confirms opening stock is posted as `stock_transactions.reference_type = 'OPENING_BALANCE'`, `reference_id = NULL`, for `product_code = 'DEMO_PRD_STOCK'` only.
- `backend/sql/reset_non_master_data.sql` — read in full. Stage A of the new package reuses its exact table list and deletion order (re-verified live, unchanged).
- `backend/sql/reset_non_master_data_dry_run.sql` — read in full. Table classification (Master/Transactional/Ambiguous/Security-audit) reused as the base for §5 below.
- `backend/sql/audit_non_master_data_reset.md` — read in full. Schema-drift warning (`purchase_lot_items`), inventory-balance analysis, debt analysis, and ambiguous-table list all carried forward unchanged (re-verified, no schema changes since that audit).
- `backend/sql/demo_smoke_test_checklist.md` — read in full. Confirms the intended demo workflow (one Bò Xô bill, one Hàng Kho bill, one purchase/receive test) — relevant to Stage B's defensive child-table coverage (§9), since a completed smoke-test cycle would have created `orders`/`order_items`/`payments`/`debt_transactions`/`stock_transactions`/`purchase_orders` rows referencing the demo customers/products/supplier, all of which Stage A's blanket deletes already remove before Stage B ever runs.
- `backend/sql/rollback_or_backup_notes.md`, `backend/sql/verify_non_master_data_reset.sql` — read for reuse in §16-19 below.

## 5. Table Classification

Reusing and extending the prior audit's classification with the new DEMO MASTER category.

| Classification | Tables |
|---|---|
| **1. TRANSACTION — DELETE ALL** | `debt_installment_payments`, `debt_transactions`, `payment_allocations`, `payment_unapplied_credits`, `payments`, `order_items`, `orders`, `debt_installment_plans`, `debt_monthly_installments`, `stock_transactions`, `inventory_adjustments`, `inventory_receive_items`, `inventory_receives`, `purchase_order_items`, `supplier_payable_transactions`, `supplier_purchase_payments`, `purchase_lot_items`, `purchase_lots`, `supplier_payments`, `purchase_orders`, plus business/operational audit: `price_change_logs`, `import_audit_logs`, `ai_action_logs`, `ai_error_logs`, `ai_learning_logs`, `ai_chat_sessions`, `retail_daily_summary`, `delete_logs` |
| **2. DEMO MASTER — DELETE DEMO ROWS ONLY** | `warehouses` (code=`DEMO_WH_001`), `product_categories` (name=`DEMO - Danh mục Bò xô`/`DEMO - Danh mục Hàng kho`), `units` (code=`DEMO_UNIT_KG`, conditionally — see §8), `customers` (customer_code=`DEMO_CUS_CARCASS`/`DEMO_CUS_STOCK`), `suppliers` (supplier_code=`DEMO_SUP_001`), `products` (product_code=`DEMO_PRD_CARCASS`/`DEMO_PRD_STOCK`), plus demo-linked rows in `customer_price_categories`, `customer_price_books`, `customer_price_book_items`, `customer_product_catalogs`, `customer_product_prices`, `supplier_purchase_options`, `product_ocr_aliases`, `product_supplier_links` (all resolved via FK to the IDs above, never by name/text matching) |
| **3. REAL MASTER — PRESERVE** | Every row in `products`, `customers`, `suppliers`, `product_categories`, `units`, `warehouses`, `customer_price_categories`, `customer_price_books`, `customer_price_book_items`, `customer_product_catalogs`, `customer_product_prices`, `supplier_purchase_options`, `product_ocr_aliases`, `product_supplier_links` that is **not** proven to be DEMO by §5 row 2 |
| **4. SECURITY/AUTH — PRESERVE** | `users`, `role_menu_permissions`, `user_menu_permissions`, `user_menu_preferences`, `app_menus`, `auth_event_logs`, `user_login_otps`, `password_reset_requests`, `customer_account_registrations` |
| **5. CONFIGURATION — PRESERVE** | `business_settings`, `ocr_provider_configs`, `user_app_preferences` |
| **6. AMBIGUOUS — DO NOT DELETE, REQUIRES_CTO_DECISION** | `customer_groups`, `payment_methods`, `system_settings`, `electronic_invoices`, `product_purchase_options`, `sponsor_ad_campaigns`, `business_portal_pages` — unchanged from the prior audit; no code reference found for any of them, so neither this task nor the prior one can safely classify them either way |

No table was reclassified based on a guess. Every classification above is either carried forward from the previously-verified audit (re-checked live for this task, no schema drift found) or newly evidenced from `restore_demo_data.sql`'s exact INSERT statements (§8).

## 6. Real Master Data Preservation List

Identical set to `reset_non_master_data.sql`'s preserved list, **minus** the exact demo rows now identified and removed in Stage B: `users`, `role_menu_permissions`, `user_menu_permissions`, `user_menu_preferences`, `app_menus`, `business_settings`, `ocr_provider_configs`, `product_categories` (non-demo rows), `products` (non-demo rows), `product_ocr_aliases` (non-demo rows), `product_supplier_links` (non-demo rows), `units` (non-demo rows — **`kg`, id confirmed 1 at audit time, is explicitly never touched anywhere in this package**), `customers` (non-demo rows), `suppliers` (non-demo rows), `customer_price_categories`/`customer_price_books`/`customer_price_book_items`/`customer_product_catalogs`/`customer_product_prices` (non-demo rows), `supplier_purchase_options` (non-demo rows), `warehouses` (non-demo rows), `user_app_preferences`.

## 7. Transaction Data Deleted (Stage A)

Same 20-table + 8-table list and FK-safe order as `reset_non_master_data.sql`, re-verified live for this task (no schema drift found since that audit — `purchase_lot_items`'s real FK is still `purchase_order_id → purchase_orders.id`, still disagreeing with `bootstrap.js`'s aspirational, never-applied definition; the script uses the verified live FK, as before). See §9 for the combined order including Stage B.

## 8. Demo Master Data Deletion List — Exact Identifiers

Extracted verbatim from `backend/sql/restore_demo_data.sql` (line-cited):

| Table | Identifying column | Exact value(s) | Source line |
|---|---|---|---|
| `warehouses` | `code` | `DEMO_WH_001` | `restore_demo_data.sql:82` |
| `product_categories` | `name` (no code column exists) | `DEMO - Danh mục Bò xô`, `DEMO - Danh mục Hàng kho` | `restore_demo_data.sql:91,96` |
| `units` | `code` | `DEMO_UNIT_KG` — **conditional**: the restore script only creates this row `WHERE NOT EXISTS (... code='kg')` (`restore_demo_data.sql:105-108`); since `kg` exists in this database (confirmed live, `units.code='kg', id=1`), `DEMO_UNIT_KG` was **never actually created**. The cleanup script still includes a guarded delete for it (defensive — correct even in an environment where `kg` was absent and the fallback fired) and **never, under any condition, matches or deletes the row where `code='kg'`** | `restore_demo_data.sql:105-112` |
| `customers` | `customer_code` | `DEMO_CUS_CARCASS`, `DEMO_CUS_STOCK` | `restore_demo_data.sql:119,124` |
| `suppliers` | `supplier_code` | `DEMO_SUP_001` | `restore_demo_data.sql:132` |
| `products` | `product_code` | `DEMO_PRD_CARCASS`, `DEMO_PRD_STOCK` | `restore_demo_data.sql:144,149` |
| `customer_product_catalogs` | no own code — resolved via FK | rows where `customer_id` ∈ {demo customer ids} **and** `product_id` ∈ {demo product ids} | `restore_demo_data.sql:158-164` |
| `customer_price_categories` | no own code — resolved via FK | rows where `customer_id` ∈ {demo customer ids} **and** `category_id` ∈ {demo category ids} | `restore_demo_data.sql:169-177` |
| `customer_price_books` | `book_name` (informational only — actual match is via FK) | `DEMO - Bảng giá Bò xô`, `DEMO - Bảng giá Hàng kho`; resolved for deletion via `customer_price_category_id` ∈ {demo price-category ids} | `restore_demo_data.sql:184,192` |
| `customer_price_book_items` | no own code — resolved via FK | rows where `price_book_id` ∈ {demo price-book ids} | `restore_demo_data.sql:203-209` |
| `supplier_purchase_options` | no own code — resolved via FK | rows where `supplier_id` = demo supplier id **and** `product_id` ∈ {demo product ids} | `restore_demo_data.sql:217-219` |
| `stock_transactions` | no own code — resolved via FK | rows where `reference_type='OPENING_BALANCE'` **and** `product_id` = demo TRACK_STOCK product id (would only exist if `restore-demo-opening-stock.js` was ever actually run — confirmed it was not, in this environment) | `restore-demo-opening-stock.js:24-26,54` |

**Additional demo-linked child tables found during this audit's schema read** (not created by `restore_demo_data.sql` itself, but structurally capable of holding rows that reference a demo customer/product if a smoke-test session ever exercised them — e.g. teaching an OCR alias for the demo customer, or recording a manual per-customer price override): `product_ocr_aliases` (has `customer_id`, `product_id` columns, confirmed via `information_schema.COLUMNS`), `product_supplier_links` (has `product_id`, `supplier_id` columns), `customer_product_prices` (has `customer_id`, `product_id` columns). All three are included in Stage B, guarded by the same resolved demo-ID FK matching — never by name/text.

## 9. Foreign-Key-Safe Deletion Order (combined Stage A + Stage B)

```
STAGE A (children before parents, transactional/audit — unchanged from reset_non_master_data.sql):
 1. debt_installment_payments        11. inventory_adjustments
 2. debt_transactions                 12. inventory_receive_items
 3. payment_allocations               13. inventory_receives
 4. payment_unapplied_credits         14. purchase_order_items
 5. payments                          15. supplier_payable_transactions
 6. order_items                       16. supplier_purchase_payments
 7. orders                            17. purchase_lot_items
 8. debt_installment_plans            18. purchase_lots
 9. debt_monthly_installments         19. supplier_payments
10. stock_transactions                20. purchase_orders
    (+ business/operational audit tables, order-independent: price_change_logs,
      import_audit_logs, ai_action_logs, ai_error_logs, ai_learning_logs,
      ai_chat_sessions, retail_daily_summary, delete_logs)

STAGE B (children before parents, demo Master Data — new):
21. customer_price_book_items (demo)     28. product_supplier_links (demo)
22. customer_price_books (demo)          29. products (demo)
23. customer_product_prices (demo)       30. customers (demo)
24. customer_product_catalogs (demo)     31. suppliers (demo)
25. customer_price_categories (demo)     32. product_categories (demo)
26. supplier_purchase_options (demo)     33. warehouses (demo)
27. product_ocr_aliases (demo)           34. units (demo, conditional — see §8)
```
Stage A necessarily runs before Stage B in the combined execution script (`cleanup_all_test_data.sql`) — by the time Stage B's demo-master deletes run, every transactional table referencing the demo entities (steps 21-27's *transactional* siblings: `stock_transactions`, `order_items`, `orders`, `purchase_order_items`, etc.) has already been emptied by Stage A, so no separate "delete demo transactions first" step is needed inside Stage B itself. The two standalone optional scripts (§16) are each self-contained and include their own necessary ordering.

## 10. Inventory Balance Treatment

Unchanged conclusion from the prior audit, re-verified: `products.stock_quantity` is a directly-stored, incrementally-updated balance (`InventoryMovementService.js`), not computed from `stock_transactions` on read.

- **For demo products being deleted:** their `stock_transactions` rows are already gone (Stage A, step 10, blanket-deletes the whole table) by the time the demo product row itself is deleted (Stage B, step 29) — satisfying "movements deleted before the product record." The demo product row is then **physically deleted**, so its stale `stock_quantity` value (if any) is deleted along with the row — no separate reset needed for demo products specifically.
- **For real, non-demo TRACK_STOCK products:** the same unresolved decision as the prior audit — **REQUIRES_CEO_DECISION**, not silently chosen here either. `cleanup_all_test_data.sql` includes the identical opt-in, disabled-by-default "reset `stock_quantity` to 0 for all TRACK_STOCK products" block (Option A), clearly labeled and requiring the operator to manually uncomment it, exactly as in `reset_non_master_data.sql`. This task's instruction ("reset stock balance to the approved clean-state value only if this behavior was already explicitly approved in the existing reset process") is answered as: **no such approval was found on record** — the prior script's Option A/B section was never uncommented/approved, so it remains an opt-in section here too, not a default action.

## 11. Debt Treatment

Unchanged: `customers`/`suppliers` have no stored debt/balance column; `current_debt` is always computed live from `debt_transactions` (`SUM(CASE type IN ('SALE','ADJUSTMENT_INCREASE')...)`). Once Stage A clears `debt_transactions`/`orders`/`payments`, every customer's computed debt becomes 0 automatically — no UPDATE needed, and this holds for the demo customers being deleted in Stage B just as much as for real customers (moot for the demo customers specifically, since the customer row itself is deleted).

## 12. Price-Data Treatment

Only pricing records provably linked to a verified demo entity via foreign key are deleted (`customer_price_book_items`/`customer_price_books`/`customer_price_categories`/`customer_product_catalogs`/`customer_product_prices`, each filtered by resolved demo `customer_id`/`product_id`/`category_id`/`customer_price_category_id`/`price_book_id`). No pricing record is ever selected by amount, by "looks like a demo price" heuristics, or by any text match — exclusively by resolved-ID foreign key, per the task's explicit instruction.

## 13. Audit-Log Treatment

Unchanged 4-way classification from the prior audit: business/operational logs (`price_change_logs`, `import_audit_logs`, `ai_*_logs`, `retail_daily_summary`, `delete_logs`) are cleared in Stage A, listed separately from core transactional tables so they can be excluded independently if the CTO wants a log kept. Security/authentication audit (`auth_event_logs`, `user_login_otps`, `password_reset_requests`, `customer_account_registrations`) is **preserved, never touched by any script in this package**, per the task's explicit prohibition.

## 14. Security/Config Preservation

`users`, `role_menu_permissions`, `user_menu_permissions`, `user_menu_preferences`, `app_menus`, `business_settings`, `ocr_provider_configs`, `user_app_preferences`, and all 4 security-audit tables above are never referenced by any `DELETE` statement in any file in this package — confirmed by the static validation in §"Mandatory Static Validation" below (grep-verified).

## 15. Soft-Delete vs Physical-Delete Decisions

Per table, for Stage B:

| Table | Treatment | Reason |
|---|---|---|
| `warehouses`, `product_categories`, `customers`, `suppliers`, `products`, `units` | **Physical DELETE** | These are records generated solely for tests, with no real business history to preserve for audit purposes once every referencing transaction/child row has already been removed by Stage A/earlier Stage-B steps. Leaving them present-but-inactive would permanently pollute Master Data pickers (product/customer/supplier dropdowns) with dead demo entries — the opposite of the task's goal. Physical delete is applied **only after** every child reference is proven gone (§9 ordering + the pre-delete child-count assertions in `cleanup_all_test_data.sql`). |
| `customer_price_categories`, `customer_price_books`, `customer_price_book_items`, `customer_product_catalogs`, `customer_product_prices`, `supplier_purchase_options`, `product_ocr_aliases`, `product_supplier_links` (demo-linked rows) | **Physical DELETE** | Same reasoning — these rows only exist because they reference a demo parent that is itself being physically removed; leaving them behind would be an orphaned/dangling row regardless of any soft-delete flag. |

No application soft-delete API (e.g. `SoftDeleteAgent`) is invoked from SQL anywhere in this package, per the task's explicit instruction — all Stage B removals are direct `DELETE` statements gated by the safety mechanism described in §"Safety Assertions — Verified Mechanism" below.

## 16. Dry-Run Instructions

1. Take a full backup (see `rollback_or_backup_notes.md`).
2. Run `backend/sql/cleanup_all_test_data_dry_run.sql` in full (zero writes — safe to run against any environment for inspection).
3. Review every section's output, in particular: §"Demo Master Data candidates" (should show 0 rows in this environment as of this audit — see §3) and §"Records that will be preserved."
4. If demo-candidate counts are ever non-zero in a future run, manually cross-check the printed codes/names against §8 of this document before proceeding.

## 17. Execution Instructions

1. Stop application writes or enable maintenance mode.
2. Take a full `mysqldump` backup (template in `rollback_or_backup_notes.md`).
3. Re-run `cleanup_all_test_data_dry_run.sql` and review it fresh (not a stale run from an earlier session).
4. Confirm real Master Data counts in the dry run look correct and unaffected.
5. Obtain explicit CTO/CEO approval for: the ambiguous-table exclusion list (§5, classification 6), the audit-log inclusion (§13), and the inventory-balance option (§10) if a stock reset is desired this cycle.
6. Open `cleanup_all_test_data.sql`, set `@BACKUP_CONFIRMED = 1` and `@EXECUTION_CONFIRMED = 1` (both start at `0` and must be manually edited — see the safety-mechanism note below), set `@EXPECTED_SCHEMA` to the exact target schema name, then execute the file manually in a controlled admin session (never automated, never scheduled).
7. Review the post-delete, pre-commit verification output printed inside the same transaction.
8. Run `COMMIT` only if every count looks correct; otherwise run `ROLLBACK`.
9. Run `verify_cleanup_all_test_data.sql` afterward.
10. Resume application writes only after verification passes.

## 18. Verification Instructions

Run `backend/sql/verify_cleanup_all_test_data.sql` (read-only) after commit. It checks all 17 items required by the task (transactional tables empty, no `DEMO_` codes remain in any master table, real Master Data still present, auth/config untouched, no orphan FKs, stock/debt consistency, no residual/duplicate demo identities).

## 19. Backup and Rollback Instructions

Identical mechanism to `rollback_or_backup_notes.md` (`mysqldump --single-transaction`, restore via `mysql < backup.sql`), plus: `cleanup_all_test_data.sql` runs inside one explicit transaction — `ROLLBACK` instead of `COMMIT` undoes the entire run (Stage A + Stage B together) with no need to restore from the `mysqldump` backup, as long as it hasn't been committed yet.

## 20. Risks

- **Verified MySQL limitation, not a guess:** a bare `SELECT CASE WHEN <bad> THEN (SELECT 1/0) ...` pattern (used in the prior generation's scripts to try to "abort" execution) was tested live in this database and confirmed to **not** raise an error — `SELECT 1/0` returns `NULL` with a warning in a plain `SELECT`, because `ERROR_FOR_DIVISION_BY_ZERO` only affects data-modification statements (INSERT/UPDATE/DELETE) under `STRICT_TRANS_TABLES`, not SELECT. The new `cleanup_all_test_data.sql` therefore uses a different, verified-working mechanism: every `DELETE` statement is individually gated by `WHERE @SAFE_TO_DELETE = 1 AND <real condition>`, where `@SAFE_TO_DELETE` is computed from the confirmation variables and schema/demo-ID assertions. If any guard fails, every `DELETE` in the script affects **zero rows** (a true fail-safe), rather than relying on the script "stopping," which cannot be guaranteed for a plain multi-statement `.sql` file outside a stored program. See the script header for full detail.
- Running the execution script without resolving §10 (inventory balance) leaves real stock balances unchanged (script defaults to not touching them) — an incomplete reset, not a corrupting one, same as the prior audit's risk framing.
- The `purchase_lot_items` schema-drift (carried forward from the prior audit) means the script uses the verified live FK (`purchase_order_id → purchase_orders`), not `bootstrap.js`'s aspirational one.
- Excluding the 7 ambiguous tables (§5, classification 6) means old rows may remain in `customer_groups`/`payment_methods`/`system_settings`/`electronic_invoices`/`product_purchase_options`/`sponsor_ad_campaigns`/`business_portal_pages` — flagged, not silently resolved.
- If Stage B is ever run standalone (`cleanup_demo_master_data_only.sql`) without Stage A having run first, its own internal safety-net deletes (of demo-linked transactional rows) must execute correctly — this path is less exercised than the combined script and should get extra scrutiny in the dry run before use.

## 21. `REQUIRES_CTO_DECISION`

1. Should the 7 ambiguous tables (§5, classification 6) be investigated and formally classified before the next cleanup cycle?
2. Should the business/operational audit tables (§13) be cleared by default on every cleanup cycle, or opted in explicitly each time?
3. Is the new `@SAFE_TO_DELETE`-gated fail-safe mechanism (§20) an acceptable replacement for the prior generation's non-functional `1/0`-abort pattern, or is a different operational control preferred (e.g., requiring the operator to delete/comment-out the guard-setting lines themselves as the "confirmation" step, rather than flipping `0` to `1`)?

## 22. `REQUIRES_CEO_DECISION`

1. **Inventory balance treatment for real, non-demo TRACK_STOCK products** (§10) — Option A (reset to 0) vs. Option B (preserve as an explicit opening balance) vs. leaving `stock_quantity` untouched this cycle. Unresolved, carried forward from the prior audit; the opt-in section remains disabled by default here too.
2. Confirmation that clearing the current live counts (§3: 28 orders, 9 payments, 35 debt transactions, 14 purchase orders, 4 purchase lots, etc., plus all demo Master Data) is the intended scope for this cleanup cycle.

## 23. Execution Status

**No SQL was executed at any point during this task.** All database interaction was strictly read-only (`SELECT`, `SHOW INDEX`, `information_schema` queries, and one live test of `SELECT 1/0`/`SELECT @@sql_mode` to verify the safety-mechanism design in §20 — itself read-only). `backend/scripts/restore-demo-opening-stock.js` was edited (constant changed `50` → `10`) but **not executed**. No file was committed. No file was pushed.
