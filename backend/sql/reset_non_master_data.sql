-- ============================================================================
-- NON-MASTER DATA RESET — EXECUTION SCRIPT
-- ============================================================================
-- !!! DO NOT RUN THIS SCRIPT AS PART OF THIS TASK. IT HAS NOT BEEN EXECUTED. !!!
--
-- This script permanently DELETEs transactional/test data (orders, payments,
-- debts, inventory movements, purchasing) while preserving all Master Data
-- (users, products, customers/suppliers, pricing, permissions, configuration).
--
-- MANDATORY SEQUENCE BEFORE THIS SCRIPT MAY EVER RUN:
--   1. Take a full backup (see rollback_or_backup_notes.md for the exact
--      command template).
--   2. Run reset_non_master_data_dry_run.sql and review every count.
--   3. Get explicit CEO/CTO sign-off on:
--        - the ambiguous-table exclusion list (audit .md section 5)
--        - the inventory-balance treatment (audit .md section 7 — the
--          OPTIONAL section near the bottom of this file is disabled by
--          default and must not be enabled without that sign-off)
--        - whether the business/operational audit tables (Section 3 below)
--          should be included this cycle
--   4. Only then run this script manually, statement-by-statement or as one
--      file via a controlled admin session — never automated, never scheduled.
--   5. Run verify_non_master_data_reset.sql afterward.
--
-- ENGINE: MySQL 8.0.35, InnoDB (all tables, confirmed live — supports
-- transactions, so this script uses one).
--
-- FOREIGN_KEY_CHECKS: NOT disabled. Every table below is deleted in explicit
-- dependency order (children before parents), derived from the actual live
-- schema's foreign keys (information_schema.KEY_COLUMN_USAGE), not from
-- bootstrap.js's schema definitions where they've been found to disagree
-- (see the purchase_lot_items warning below). TRUNCATE is deliberately not
-- used anywhere — it auto-commits per statement (defeating the single
-- transaction below), resets AUTO_INCREMENT unconditionally, and can fail
-- outright against a table with an active FK reference.
--
-- ROLLBACK: this script runs inside one explicit transaction. If run via the
-- mysql CLI without -f/--force (the default), execution stops at the first
-- error and the transaction is left OPEN, uncommitted — run ROLLBACK
-- manually in that case. Do not run COMMIT unless every statement above it
-- executed with no error.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- STEP 0 — SCHEMA/ENVIRONMENT ASSERTION
-- ----------------------------------------------------------------------------
-- Edit EXPECTED_SCHEMA below to the exact schema name you intend to target,
-- then uncomment the assertion. This is a deliberate manual step — there is
-- no default value, so this script cannot accidentally run against the wrong
-- database by inheriting a default.
--
-- SET @EXPECTED_SCHEMA = 'REPLACE_WITH_EXACT_TARGET_SCHEMA_NAME';
-- SELECT IF(DATABASE() = @EXPECTED_SCHEMA, 'OK', NULL) INTO @schema_check;
-- SELECT CASE WHEN @schema_check IS NULL
--   THEN (SELECT 1/0)  -- forces a visible error, aborting the session, if the schema doesn't match
--   ELSE 'Schema assertion passed' END AS schema_assertion_result;

SELECT CONCAT('About to reset non-master data in schema: ', DATABASE()) AS environment_warning;
SELECT 'If this is not the intended database, STOP NOW.' AS environment_warning;


-- ----------------------------------------------------------------------------
-- STEP 1 — ROW COUNTS BEFORE DELETION (for the operator's own record; the
-- authoritative pre-reset counts are in reset_non_master_data_dry_run.sql,
-- run separately and reviewed BEFORE this script is ever executed)
-- ----------------------------------------------------------------------------
SELECT 'orders' t, COUNT(*) c FROM orders
UNION ALL SELECT 'order_items', COUNT(*) FROM order_items
UNION ALL SELECT 'payments', COUNT(*) FROM payments
UNION ALL SELECT 'debt_transactions', COUNT(*) FROM debt_transactions
UNION ALL SELECT 'stock_transactions', COUNT(*) FROM stock_transactions
UNION ALL SELECT 'purchase_orders', COUNT(*) FROM purchase_orders;


-- ----------------------------------------------------------------------------
-- STEP 2 — BEGIN TRANSACTION
-- ----------------------------------------------------------------------------
START TRANSACTION;

-- --- Section 1: Sales / Payment / Debt domain (children first) -------------

-- debt_installment_payments: child of debt_installment_plans (application-
-- level FK only; no DB constraint found, but logically dependent).
DELETE FROM debt_installment_payments;

-- debt_transactions: append-only debt ledger. Real FKs to customers, orders,
-- payments, users. Deleted before orders/payments since it references both.
DELETE FROM debt_transactions;

-- payment_allocations: payment-to-bill split record. No DB FK found, but
-- logically references payments and orders — deleted before both.
DELETE FROM payment_allocations;

-- payment_unapplied_credits: unapplied customer credit ledger. No DB FK
-- found, logically references payments and customers.
DELETE FROM payment_unapplied_credits;

-- payments: money-received event. Real FKs to customers, orders, users.
-- Deleted after everything that references it above.
DELETE FROM payments;

-- order_items: sale line items. Real FKs to orders, products.
DELETE FROM order_items;

-- orders: sale transaction header. Real FKs to customers, users. Deleted
-- last in this section, after every child above.
DELETE FROM orders;

-- debt_installment_plans: installment plan header (application-level FK to
-- customers only).
DELETE FROM debt_installment_plans;

-- debt_monthly_installments: scheduled installment config per customer/
-- period (application-level FK to customers only).
DELETE FROM debt_monthly_installments;


-- --- Section 2: Inventory / Purchasing domain (children first) -------------

-- stock_transactions: append-only inventory ledger. Real FKs to products,
-- users. See the OPTIONAL inventory-balance section near the bottom of this
-- file for products.stock_quantity treatment — NOT applied automatically.
DELETE FROM stock_transactions;

-- inventory_adjustments: standalone adjustment header (application-level
-- reference from stock_transactions via reference_type='ADJUSTMENT', no DB
-- FK). Referenced products link is application-level only.
DELETE FROM inventory_adjustments;

-- inventory_receive_items: goods-receipt line items (application-level FK to
-- inventory_receives, products).
DELETE FROM inventory_receive_items;

-- inventory_receives: goods-receipt header (application-level FK to
-- purchase_orders, suppliers).
DELETE FROM inventory_receives;

-- purchase_order_items: PO line items. Real FKs to purchase_orders, products.
DELETE FROM purchase_order_items;

-- supplier_payable_transactions: supplier payable ledger (application-level
-- FKs to suppliers, purchase_orders, inventory_receives,
-- supplier_purchase_payments).
DELETE FROM supplier_payable_transactions;

-- supplier_purchase_payments: PO-domain supplier payment header
-- (application-level FK to suppliers only).
DELETE FROM supplier_purchase_payments;

-- purchase_lot_items: !!! SCHEMA-DRIFT WARNING (see audit_non_master_data_
-- reset.md section 4) !!! The LIVE table's real FK is
-- purchase_order_id -> purchase_orders.id — confirmed directly from
-- information_schema.KEY_COLUMN_USAGE — NOT lot_id -> purchase_lots.id as
-- bootstrap.js's (never-applied) current CREATE TABLE definition claims.
-- Deleted here, before purchase_orders, based on the verified live FK.
DELETE FROM purchase_lot_items;

-- purchase_lots: legacy carcass-purchase lot header. Real FK to suppliers.
DELETE FROM purchase_lots;

-- supplier_payments: legacy lot-keyed supplier payment (application-level FK
-- to purchase_lots).
DELETE FROM supplier_payments;

-- purchase_orders: PO header. Real FKs to suppliers, users. Deleted last in
-- this section, after every child above (including purchase_lot_items, per
-- the verified live FK).
DELETE FROM purchase_orders;


-- --- Section 3: Business/operational audit tables ---------------------------
-- These are NOT security/auth audit (which stays preserved, see below) and
-- NOT silently bundled into Sections 1-2 above. Per
-- audit_non_master_data_reset.md section 9, these are a SEPARATE decision.
-- Comment out any of the following lines individually if the CEO/CTO decides
-- a specific log should be kept for this cycle.

DELETE FROM price_change_logs;
DELETE FROM import_audit_logs;
DELETE FROM ai_action_logs;
DELETE FROM ai_error_logs;
DELETE FROM ai_learning_logs;
DELETE FROM ai_chat_sessions;
DELETE FROM retail_daily_summary;
DELETE FROM delete_logs;


-- --- NOT touched by this script (explicitly, for the record) ---------------
-- Security/auth audit (preserved per task instruction, no reset requirement
-- stated): auth_event_logs, user_login_otps, password_reset_requests,
-- customer_account_registrations.
--
-- All Master Data tables (users, role_menu_permissions, user_menu_
-- permissions, user_menu_preferences, app_menus, business_settings,
-- ocr_provider_configs, product_categories, products, product_ocr_aliases,
-- product_supplier_links, units, customers, suppliers,
-- customer_price_categories, customer_price_books, customer_price_book_items,
-- customer_product_catalogs, customer_product_prices,
-- supplier_purchase_options, warehouses, user_app_preferences).
--
-- Ambiguous, excluded tables (REQUIRES_CTO_DECISION, see audit .md section
-- 5): customer_groups, payment_methods, system_settings, electronic_invoices,
-- product_purchase_options, sponsor_ad_campaigns, business_portal_pages.


-- ----------------------------------------------------------------------------
-- STEP 3 — POST-DELETE, PRE-COMMIT VERIFICATION (inside the same transaction)
-- ----------------------------------------------------------------------------
SELECT 'orders' t, COUNT(*) remaining FROM orders
UNION ALL SELECT 'order_items', COUNT(*) FROM order_items
UNION ALL SELECT 'payments', COUNT(*) FROM payments
UNION ALL SELECT 'debt_transactions', COUNT(*) FROM debt_transactions
UNION ALL SELECT 'stock_transactions', COUNT(*) FROM stock_transactions
UNION ALL SELECT 'purchase_orders', COUNT(*) FROM purchase_orders;
-- Expect 0 for every row above. If any is non-zero, do NOT commit — ROLLBACK
-- and investigate.

SELECT 'products (must be UNCHANGED count vs before)' t, COUNT(*) c FROM products;
SELECT 'customers (must be UNCHANGED count vs before)' t, COUNT(*) c FROM customers;
SELECT 'suppliers (must be UNCHANGED count vs before)' t, COUNT(*) c FROM suppliers;


-- ----------------------------------------------------------------------------
-- STEP 4 — COMMIT
-- ----------------------------------------------------------------------------
-- Only run this line if every statement above completed with no error and
-- the Step 3 counts look correct. Otherwise run ROLLBACK instead.
COMMIT;
-- ROLLBACK;   -- <-- uncomment and run this INSTEAD of COMMIT if anything above looked wrong


-- ============================================================================
-- OPTIONAL — INVENTORY BALANCE RESET (DISABLED BY DEFAULT)
-- ============================================================================
-- REQUIRES_CEO_DECISION (see audit_non_master_data_reset.md section 7).
-- products.stock_quantity is a directly-stored, incrementally-updated
-- balance (confirmed by reading InventoryMovementService.js), NOT computed
-- from stock_transactions on read. After Section 2 above clears the ledger,
-- every TRACK_STOCK product's stock_quantity is now STALE (no longer backed
-- by any ledger row) unless this section is run too.
--
-- This is Option A from the audit (reset to zero) — the simplest, fully
-- ledger-consistent choice. Option B (preserve an explicit opening balance)
-- would instead INSERT one OPENING_BALANCE stock_transactions row per
-- product equal to its pre-reset stock_quantity — not scripted here, since
-- it requires the CEO to decide the reset should NOT zero out real stock.
--
-- Do not uncomment and run this without explicit CEO sign-off on Option A.
--
-- START TRANSACTION;
-- UPDATE products SET stock_quantity = 0 WHERE inventory_mode = 'TRACK_STOCK' AND del_flg = 0;
-- SELECT id, product_code, name, stock_quantity FROM products WHERE inventory_mode = 'TRACK_STOCK' AND del_flg = 0;
-- COMMIT; -- or ROLLBACK


-- ============================================================================
-- OPTIONAL — AUTO_INCREMENT RESET (DISABLED BY DEFAULT, NOT RECOMMENDED)
-- ============================================================================
-- Per task instruction: do not reset IDs to 1 by default. order_code (the
-- business-visible bill number, e.g. BILL202607280001) is generated from
-- today's date plus a same-day sequence count (backend/src/utils/code.js),
-- NOT from the orders.id AUTO_INCREMENT value — confirmed by reading that
-- function directly. Resetting AUTO_INCREMENT therefore does not break
-- order_code uniqueness. However, other tables' raw `id` values were not
-- individually audited for external references (e.g. any printed/shared
-- URL that might embed a raw numeric id rather than a token), so this
-- remains off by default as instructed.
--
-- If desired after separate confirmation, per table, e.g.:
-- ALTER TABLE orders AUTO_INCREMENT = 1;
-- ALTER TABLE order_items AUTO_INCREMENT = 1;
-- ... (repeat only for tables explicitly approved)
