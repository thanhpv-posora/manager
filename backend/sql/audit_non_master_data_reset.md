# Non-Master Test Data Reset — Audit Report

Status: **AUDIT ONLY. No SQL executed. No data modified.**

Generated against a live, read-only inspection of the database on 2026-07-28.

## 1. Database Engine / Version
MySQL **8.0.35**, all application tables use the **InnoDB** engine (confirmed via `information_schema.TABLES.ENGINE` for all 64 tables — no exceptions).

## 2. Schema Audited
`information_schema.TABLES`, `information_schema.COLUMNS`, `information_schema.KEY_COLUMN_USAGE` (foreign keys), `SHOW TRIGGERS`, `information_schema.VIEWS`, `information_schema.ROUTINES`, `SHOW EVENTS` — all queried live, read-only, against the current schema. **64 tables** found in total.

**Triggers: none. Views: none. Stored procedures/functions: none. Scheduled events: none.** Confirmed empty via direct query — all business logic (stock deduction, debt calculation, code generation) lives exclusively in the Node.js application layer (`backend/src/agents/*`, `backend/src/services/*`), never at the database layer. This significantly simplifies reset correctness: there is no DB-side logic that could fire unexpectedly during a reset.

**31 declared foreign key constraints** exist (`information_schema.KEY_COLUMN_USAGE`, listed in full below). Most application-level relationships (e.g. `payment_allocations.order_id`, `debt_installment_payments.plan_id`, `supplier_payable_transactions.purchase_order_id`) are **not** DB-enforced — they are logical/application-level only. The deletion order below respects logical dependency regardless of DB enforcement.

## 3. Master Data Table Whitelist

Every concept in the task's preservation-intention list is mapped below to the actual schema table(s) that implement it. Nothing here was guessed from a table name alone — each row's classification is backed by the evidence column.

| Concept | Table(s) | Evidence |
|---|---|---|
| Users | `users` | Referenced by `orders.created_by`, `payments.created_by`, `stock_transactions.created_by`, `purchase_orders.created_by`, `purchase_lots.created_by` (all real FKs) — the authentication/actor identity table |
| Roles/Permissions | `role_menu_permissions`, `user_menu_permissions` | Read by the auth/menu middleware; no transactional content |
| Menu configuration | `app_menus`, `user_menu_preferences` | `user_menu_preferences.menu_id` has a real FK to `app_menus.id` |
| Application settings | `business_settings`, `ocr_provider_configs` | Key/value config tables, no transactional shape |
| Categories | `product_categories` | Referenced by `products.category_id` (real FK) |
| Products | `products` | Core catalog; `stock_quantity` is a **derived/denormalized balance**, see §7 |
| Product aliases | `product_ocr_aliases` | Customer-taught OCR/handwriting shorthand — reference data, not a transaction |
| Units | `units` | Referenced by `supplier_purchase_options.unit_id`, `product_purchase_options.unit_id` (real FKs) |
| Customers/Partners | `customers` | Unified Partner table (confirmed by reading `CustomerAgent.js`/`Customers.jsx` directly — `partner_type` distinguishes Customer/Supplier within this one table) |
| Suppliers | `suppliers` | Referenced by `purchase_orders.supplier_id`, `purchase_lots.supplier_id`, `supplier_purchase_options.supplier_id` (real FKs) |
| Customer price categories | `customer_price_categories` | Referenced by `customer_price_books` (application-level) |
| Price books | `customer_price_books` | Per the task's own explicit rule: "Master Data unless schema evidence proves they are temporary transactional drafts" — no such evidence found; has `effective_from`/`effective_to` (a versioning pattern, not a draft/staging pattern) |
| Price book items | `customer_price_book_items` | Same reasoning as price books |
| Supplier purchase options | `supplier_purchase_options` | Reference data (unit/conversion per supplier×product), real FKs to `suppliers`/`products`/`units` |
| Warehouses | `warehouses` | Reference/location master, single default row today |
| Inventory configuration | *(none found as a distinct table — inventory policy lives in code: `InventoryPolicyResolver.js`)* | No table to preserve/exclude; **NOT_VERIFIED** whether any config table backs this beyond `products.inventory_mode`/`allow_negative_stock`, which are Product Master fields, already covered |
| Calendar/business configuration | `business_settings` | Same table as "application settings" above; no separate calendar-config table found |
| **Also classified as Master** (not explicitly named in the task's list, but evidence-justified) | `customer_product_catalogs`, `customer_product_prices` | Same reasoning as price books — customer-specific catalog/price *configuration*, not a dated business event; excluding them would leave every customer's product catalog and private pricing empty after a "clean test cycle," which is very unlikely to be the intended outcome |
| `product_supplier_links` | Reference data linking a product to its supplier(s), no transactional shape |

## 4. Transactional Table Deletion List

Every table below was confirmed to actually exist and hold the shape described — none were assumed from naming alone.

| Table | Rows (as of audit) | Classification reason |
|---|---|---|
| `debt_installment_payments` | 0 | Child of `debt_installment_plans`; a payment event |
| `debt_transactions` | 35 | Append-only debt ledger; confirmed real FKs to `customers`/`orders`/`payments`/`users` |
| `payment_allocations` | 10 | Payment-to-bill split record |
| `payment_unapplied_credits` | 0 | Unapplied customer credit ledger |
| `payments` | 9 | Money-received event; real FKs to `customers`/`orders`/`users` |
| `order_items` | 198 | Sale line items; real FKs to `orders`/`products` |
| `orders` | 28 | Sale transaction header; real FKs to `customers`/`users` |
| `debt_installment_plans` | 0 | Installment plan header |
| `debt_monthly_installments` | 1 | Scheduled installment config per customer/period |
| `stock_transactions` | 240 | Append-only inventory ledger; real FKs to `products`/`users` |
| `inventory_adjustments` | 1 | Standalone adjustment header |
| `inventory_receive_items` | 19 | Goods-receipt line items |
| `inventory_receives` | 10 | Goods-receipt header |
| `purchase_order_items` | 24 | PO line items; real FKs to `purchase_orders`/`products` |
| `supplier_payable_transactions` | 0 | Supplier payable ledger |
| `supplier_purchase_payments` | 0 | PO-domain supplier payment header |
| `purchase_lot_items` | 0 | See **schema-drift warning** below |
| `purchase_lots` | 4 | Legacy carcass-purchase lot header; real FK to `suppliers` |
| `supplier_payments` | 3 | Legacy lot-keyed supplier payment |
| `purchase_orders` | 14 | PO header; real FKs to `suppliers`/`users` |

**⚠ Schema-drift warning (`purchase_lot_items`):** the live table's columns (`id, purchase_order_id, product_id, quantity, estimated_sale_price, sold_quantity, sold_amount, note`, with a real FK `purchase_order_id → purchase_orders.id`) **do not match** `backend/src/config/bootstrap.js`'s current `CREATE TABLE IF NOT EXISTS purchase_lot_items` definition (which describes `lot_id, supplier_purchase_option_id, purchase_qty, ...`, with an FK to `purchase_lots`, not `purchase_orders`). This means the live table was created by an earlier migration that no longer matches the code, and `bootstrap.js`'s current definition has never actually executed against this database. **The deletion order below uses the live schema's real FK (`purchase_order_id → purchase_orders`), not `bootstrap.js`'s aspirational one.** This discrepancy predates this task and is not caused by it — reported for CTO awareness, not resolved here.

### Business/Operational audit — reported separately, not silently bundled into "transactional data" (see §9)
`price_change_logs` (196 rows), `import_audit_logs` (0), `ai_action_logs` (566), `ai_error_logs` (0), `ai_learning_logs` (0), `ai_chat_sessions` (0), `retail_daily_summary` (0), `delete_logs` (0).

## 5. Ambiguous Tables — Excluded, `REQUIRES_CTO_DECISION`

These tables have **zero references anywhere in the tracked application source** (`backend/src`) — confirmed by exhaustive grep, not inferred from naming. Their true purpose (still-live vs. dead/legacy) cannot be determined from code, so per the task's own rule ("If a table is ambiguous: do not delete it"), **none of them appear in either the master-preserve list or the transactional-delete list** — they are excluded entirely from this reset script.

| Table | Rows | Why ambiguous |
|---|---|---|
| `customer_groups` | 3 | No code reference found anywhere; shape (`code`,`name`,`is_active`) looks like reference data |
| `payment_methods` | 3 | No code reference found anywhere; shape looks like reference data |
| `system_settings` | 4 | No code reference found anywhere; possibly superseded by `business_settings`, which *is* actively used |
| `electronic_invoices` | 0 | No code reference found anywhere; shape looks transactional (linked to `orders`) but is entirely orphaned |
| `product_purchase_options` | 0 | Has **real DB-level FK constraints** to `products`/`units` (unlike the other four), yet has no `CREATE TABLE` statement anywhere in tracked source and zero query references — likely superseded by `supplier_purchase_options` |
| `sponsor_ad_campaigns` | 0 | Content/workflow table (draft→ready→published marketing campaigns) — not named in either the master or transactional concept list; defaulted to **excluded/preserved** pending confirmation |
| `business_portal_pages` | 3 | Public CMS-style content pages — same reasoning as above, defaulted to **excluded/preserved** |

## 6. Foreign-Key Dependency Order

Full FK list (31 constraints) queried directly from `information_schema.KEY_COLUMN_USAGE`; the deletion order in the execution script (§ below) was derived from this plus the logical (non-FK-enforced) relationships found by reading the application code. Order (children before parents):

```
1.  debt_installment_payments
2.  debt_transactions
3.  payment_allocations
4.  payment_unapplied_credits
5.  payments
6.  order_items
7.  orders
8.  debt_installment_plans
9.  debt_monthly_installments
10. stock_transactions
11. inventory_adjustments
12. inventory_receive_items
13. inventory_receives
14. purchase_order_items
15. supplier_payable_transactions
16. supplier_purchase_payments
17. purchase_lot_items      -- (FK is to purchase_orders, per live-schema evidence — see §4 warning)
18. purchase_lots
19. supplier_payments
20. purchase_orders
```
Business/operational audit tables (§9) have no FK relationships to anything above and can be cleared independently, in any order.

## 7. Inventory Balance Analysis

`products.stock_quantity` is **directly stored and incrementally updated** by `InventoryMovementService.js` (confirmed by reading the actual `UPDATE products SET stock_quantity = stock_quantity ± ? WHERE id = ?` statements at 5 call sites) — it is **not** computed on-the-fly from `stock_transactions`. This means clearing `stock_transactions` alone, without also addressing `products.stock_quantity`, would leave every product's stock balance **stale and untraceable to any ledger entry** — exactly the risk the task warned against.

**Options (not silently chosen — REQUIRES_CEO_DECISION, see §17):**
- **A. Reset every product's `stock_quantity` to 0** alongside clearing `stock_transactions`. Simplest, fully consistent (ledger and balance both start empty). Risk: any product whose real-world opening stock should not be zero needs to be re-entered manually after reset.
- **B. Preserve an explicit opening balance** — i.e., after clearing the ledger, insert one `OPENING_BALANCE`-type `stock_transactions` row per `TRACK_STOCK` product equal to its pre-reset `stock_quantity`, so the ledger and balance stay consistent *and* nothing is zeroed. Risk: this treats the pre-reset stock level as "correct," which may itself include test-data noise the CEO wants gone.
- **C. Rebuild balances from retained opening movements** — not applicable here, since this reset clears the entire ledger; there would be nothing to rebuild from.
- **D. Use the application's official recalculation mechanism** — **NOT_VERIFIED**: no dedicated "recalculate stock from ledger" function was found in the codebase during this audit (`InventoryMovementService.js`/`InventoryService.js` only ever apply incremental deltas, never a full recompute-from-ledger pass). If one exists elsewhere, it wasn't located.

The dry-run script reports current `stock_quantity` per `TRACK_STOCK` product so the CEO can see exactly what's at stake before choosing. **The execution script does not touch `products.stock_quantity` by default** — Option A (or B) is provided as a clearly separated, commented, opt-in section, never applied automatically.

## 8. Customer Debt Analysis

`customers` has **no stored debt/balance column** — confirmed directly from `information_schema.COLUMNS` (only `debt_limit`, a ceiling, exists). The `current_debt` value shown in the UI (`Customers.jsx`, `PaymentAgent.summary()`) is **always computed live** via `SUM(CASE WHEN type IN ('SALE','ADJUSTMENT_INCREASE') THEN amount WHEN type IN ('PAYMENT','ADJUSTMENT_DECREASE') THEN -amount ELSE 0 END) FROM debt_transactions WHERE customer_id=?` — confirmed by reading `CustomerAgent.js:127` and `PaymentAgent.js` directly, not assumed.

**Conclusion: there is no stale-debt risk for customers.** Once `debt_transactions` (and its sources, `orders`/`payments`) are cleared, every customer's computed `current_debt` becomes 0 automatically, with **no additional UPDATE required**. `suppliers` was checked the same way — no debt/balance/payable column exists there either; supplier payable is computed the same live-aggregate way from `supplier_payable_transactions`.

The only *stored* per-order values (`orders.paid_amount`, `orders.debt_amount`, `orders.total_amount`) are moot, since `orders` itself is being deleted entirely.

## 9. Audit-Log Treatment

Separated per the task's four-way split, evidence-based:

1. **Business transaction audit/history** — `price_change_logs`, `import_audit_logs`, `ai_action_logs`, `ai_error_logs`, `ai_learning_logs`, `ai_chat_sessions`, `retail_daily_summary`, `delete_logs`. These record *what happened* during real usage (price edits, AI interactions, import attempts, soft-deletes). For a clean test cycle, these are reasonable to clear — **but they are listed in their own section of the dry-run/execution scripts, not silently merged into the core transactional list**, so the CEO/CTO can include or exclude them independently.
2. **Security/authentication audit** — `auth_event_logs`, `user_login_otps`, `password_reset_requests`, `customer_account_registrations`. **Defaulted to PRESERVED, excluded from the execution script**, per the task's explicit instruction ("Preserve security... audit unless there is a clear test-reset requirement") — no such requirement was stated.
3. **System/configuration audit** — none found as a distinct table (no separate "config change log" table exists).
4. **Master Data audit** — none found as a distinct table (no separate "master data change log" table exists); `delete_logs` records deletions of any entity type (product, customer, etc.) and is treated under category 1 above since it's tied to specific business-transaction-adjacent actions, not a standing security/config record.

## 10–13. Dry-run / Execution / Verification Scripts / Backup Template
See the companion files:
- `reset_non_master_data_dry_run.sql` — read-only, reports counts and classifications only.
- `reset_non_master_data.sql` — the actual DELETE script (not executed).
- `verify_non_master_data_reset.sql` — post-reset verification queries.
- `rollback_or_backup_notes.md` — backup command template and rollback guidance.
- `restore_demo_data.sql` — **(added, Phase 4)** idempotent minimal demo-data seed, intended to run immediately after a reset so the system has a coherent, testable dataset again. Not executed.
- `../scripts/restore-demo-opening-stock.js` — **(added, Phase 4)** Node helper that posts opening stock for the demo TRACK_STOCK product via `InventoryService.opening()` (the Single Writer), since `products.stock_quantity` must never be written directly from SQL. Not executed.
- `demo_smoke_test_checklist.md` — **(added, Phase 4)** manual browser verification steps to run after demo data is restored.

## 14. Execution Instructions
1. Run a full backup using the template in `rollback_or_backup_notes.md`.
2. Run `reset_non_master_data_dry_run.sql` and review every row count and classification.
3. Get explicit CEO/CTO sign-off on: the ambiguous-table list (§5), the inventory-balance option (§7), and the audit-log inclusion/exclusion (§9).
4. Only then, manually run `reset_non_master_data.sql` (never automated, never scheduled).
5. Run `verify_non_master_data_reset.sql` and confirm the expected post-reset state (§ Post-Reset Expected State, in `reset_non_master_data.sql`'s header).
6. **(Optional, Phase 4)** If a testable dataset is needed after the reset, run `restore_demo_data.sql`, then `../scripts/restore-demo-opening-stock.js`, then work through `demo_smoke_test_checklist.md`. This step is independent of steps 1–5 and may be skipped if the reset alone was the goal.

## 15. Risks
- Running the execution script without first resolving §7 (inventory balance) leaves stock balances stale — the script defaults to *not* touching them, so the risk is an *incomplete* reset, not a *corrupting* one.
- The `purchase_lot_items` schema-drift (§4) means any assumption based on `bootstrap.js`'s documented schema for that one table would be wrong — the script uses the verified live schema instead.
- Excluding the 5+2 ambiguous tables (§5) means a "fully clean" test cycle may still show old rows in `customer_groups`/`payment_methods`/`system_settings`/`electronic_invoices`/`product_purchase_options`/`sponsor_ad_campaigns`/`business_portal_pages` — flagged, not silently resolved either way.

## 16. `REQUIRES_CTO_DECISION`
- Should `sponsor_ad_campaigns` and `business_portal_pages` be treated as Master Data (preserved) or test content (cleared)? Currently defaulted to preserved/excluded.
- Should the 5 orphaned, code-referenceless tables (§5) be investigated/resolved (confirmed dead → safe to include in a future reset, or confirmed live → formally added to the Master whitelist) before the *next* reset cycle?
- Should the business/operational audit tables (§9.1) be included in this reset by default, or opted in explicitly each time?

## 17. `REQUIRES_CEO_DECISION`
- **Inventory balance treatment** (§7): Option A (reset to 0) vs Option B (preserve as an explicit opening balance) vs declining to touch `stock_quantity` at all this cycle. This is a business decision about what "clean" means for test inventory, not a technical one.
- Confirmation that clearing all 28 orders / 9 payments / 35 debt transactions / 4 purchase lots / 14 purchase orders (and their line items) is the intended scope for "one clean end-to-end test cycle."
