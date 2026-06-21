-- =============================================================================
-- DB_RESET_KEEP_MASTER_ONLY.sql
-- MeatBiz V6.65 — Development / Staging Database Reset
--
-- PURPOSE : DELETE all transaction, runtime, and log rows while keeping all
--           master data intact (customers, products, pricing, config, etc.)
--
-- WHEN TO USE:
--   - After a QA/test cycle to return DB to a clean baseline
--   - Before a new demo/training session
--   - When transaction data is corrupt and master data is still valid
--
-- HOW TO RUN:
--   1. Run the PRE-CHECK section and confirm all 4 runtime tables exist
--   2. Review the TABLE CLASSIFICATION LEGEND at the bottom of this file
--   3. Connect to the target database (dev/staging ONLY — never production)
--   4. Run the script up to (but not including) COMMIT
--   5. Inspect the VERIFICATION QUERIES section at the end
--   6. Uncomment COMMIT and re-run the verification block, OR run ROLLBACK
--
-- SAFETY:
--   - Wrapped in START TRANSACTION / ROLLBACK guard
--   - COMMIT is commented out — you must explicitly enable it
--   - Backup tables created before deletion (suffix: _bak_reset_20260621)
--   - No DROP TABLE or TRUNCATE — only DELETE FROM (transaction-safe)
--   - No hard FK constraints exist in this schema (logical-only), so DELETE
--     order is based on logical data dependency, not MySQL enforcement
--
-- WARNING : DO NOT RUN ON PRODUCTION. This script cannot be undone once
--           COMMIT is issued. Backup tables must be dropped manually after
--           verification.
--
-- Generated : 2026-06-21
-- Schema version : MeatBiz V6.65 (bootstrap.js + V65_42 / V65_43 / V65_44)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- CONFIGURATION — set your target DB before running
-- ---------------------------------------------------------------------------
-- USE `meatbiz_dev`;       -- <-- uncomment and set your DB name here

-- ---------------------------------------------------------------------------
-- PRE-CHECK : Verify that all migration-created runtime tables exist.
--             Each statement below must return 1 row. If any result is empty,
--             run the application startup (AutoMigrationAgent + SQL migrations)
--             first, OR manually comment out the DELETE block for that table.
-- ---------------------------------------------------------------------------

SHOW TABLES LIKE 'payment_allocations';
SHOW TABLES LIKE 'payment_unapplied_credits';
SHOW TABLES LIKE 'inventory_fifo_layers';
SHOW TABLES LIKE 'order_item_fifo_allocations';

-- ---------------------------------------------------------------------------
-- STEP 0 : Create backup tables (outside transaction — DDL auto-commits)
--          Re-running is safe: IF NOT EXISTS prevents duplicate backups.
--          Tables are populated inside the transaction so the backup
--          reflects the pre-delete state.
--          Backup suffix: _bak_reset_20260621
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS _orders_bak_reset_20260621 LIKE orders;
CREATE TABLE IF NOT EXISTS _order_items_bak_reset_20260621 LIKE order_items;
CREATE TABLE IF NOT EXISTS _payments_bak_reset_20260621 LIKE payments;
CREATE TABLE IF NOT EXISTS _payment_allocations_bak_reset_20260621 LIKE payment_allocations;
CREATE TABLE IF NOT EXISTS _payment_unapplied_credits_bak_reset_20260621 LIKE payment_unapplied_credits;
CREATE TABLE IF NOT EXISTS _debt_transactions_bak_reset_20260621 LIKE debt_transactions;
CREATE TABLE IF NOT EXISTS _debt_installment_plans_bak_reset_20260621 LIKE debt_installment_plans;
CREATE TABLE IF NOT EXISTS _debt_installment_payments_bak_reset_20260621 LIKE debt_installment_payments;
CREATE TABLE IF NOT EXISTS _debt_monthly_installments_bak_reset_20260621 LIKE debt_monthly_installments;
CREATE TABLE IF NOT EXISTS _stock_transactions_bak_reset_20260621 LIKE stock_transactions;
CREATE TABLE IF NOT EXISTS _purchase_lots_bak_reset_20260621 LIKE purchase_lots;
CREATE TABLE IF NOT EXISTS _supplier_payments_bak_reset_20260621 LIKE supplier_payments;
CREATE TABLE IF NOT EXISTS _purchase_orders_bak_reset_20260621 LIKE purchase_orders;
CREATE TABLE IF NOT EXISTS _purchase_order_items_bak_reset_20260621 LIKE purchase_order_items;
CREATE TABLE IF NOT EXISTS _inventory_fifo_layers_bak_reset_20260621 LIKE inventory_fifo_layers;
CREATE TABLE IF NOT EXISTS _order_item_fifo_allocations_bak_reset_20260621 LIKE order_item_fifo_allocations;

-- ---------------------------------------------------------------------------
-- STEP 1 : BEGIN TRANSACTION
-- ---------------------------------------------------------------------------

START TRANSACTION;

-- ---------------------------------------------------------------------------
-- STEP 2 : Populate backup tables (snapshot pre-delete state)
-- ---------------------------------------------------------------------------

INSERT IGNORE INTO _orders_bak_reset_20260621                  SELECT * FROM orders;
INSERT IGNORE INTO _order_items_bak_reset_20260621             SELECT * FROM order_items;
INSERT IGNORE INTO _payments_bak_reset_20260621                SELECT * FROM payments;
INSERT IGNORE INTO _payment_allocations_bak_reset_20260621     SELECT * FROM payment_allocations;
INSERT IGNORE INTO _payment_unapplied_credits_bak_reset_20260621 SELECT * FROM payment_unapplied_credits;
INSERT IGNORE INTO _debt_transactions_bak_reset_20260621       SELECT * FROM debt_transactions;
INSERT IGNORE INTO _debt_installment_plans_bak_reset_20260621  SELECT * FROM debt_installment_plans;
INSERT IGNORE INTO _debt_installment_payments_bak_reset_20260621 SELECT * FROM debt_installment_payments;
INSERT IGNORE INTO _debt_monthly_installments_bak_reset_20260621 SELECT * FROM debt_monthly_installments;
INSERT IGNORE INTO _stock_transactions_bak_reset_20260621      SELECT * FROM stock_transactions;
INSERT IGNORE INTO _purchase_lots_bak_reset_20260621           SELECT * FROM purchase_lots;
INSERT IGNORE INTO _supplier_payments_bak_reset_20260621       SELECT * FROM supplier_payments;
INSERT IGNORE INTO _purchase_orders_bak_reset_20260621         SELECT * FROM purchase_orders;
INSERT IGNORE INTO _purchase_order_items_bak_reset_20260621    SELECT * FROM purchase_order_items;
INSERT IGNORE INTO _inventory_fifo_layers_bak_reset_20260621   SELECT * FROM inventory_fifo_layers;
INSERT IGNORE INTO _order_item_fifo_allocations_bak_reset_20260621 SELECT * FROM order_item_fifo_allocations;

-- ---------------------------------------------------------------------------
-- STEP 3 : DELETE TRANSACTION / RUNTIME DATA — FK-safe order
--
-- Logical dependency tree (most-dependent first):
--
--   order_item_fifo_allocations  →  order_items, inventory_fifo_layers
--   inventory_fifo_layers        →  purchase_lots
--   payment_allocations          →  payments, orders
--   payment_unapplied_credits    →  payments
--   debt_transactions            →  orders, payments
--   stock_transactions           →  orders (reference_id = order_id for SALE)
--   order_items                  →  orders
--   price_change_logs            →  (product_id ref, safe to delete anytime)
--   payments                     →  orders
--   orders                       (root of sale chain)
--   debt_installment_payments    →  debt_installment_plans
--   debt_installment_plans       →  (customer ref)
--   debt_monthly_installments    →  (customer ref, installment config)
--   purchase_order_items         →  purchase_orders
--   purchase_orders              →  (supplier ref)
--   supplier_payments            →  purchase_lots
--   purchase_lots                (root of stock chain)
--   ai_chat_sessions / *_logs    (no FK dependencies)
--   auth_event_logs / otps       (no FK dependencies)
-- ---------------------------------------------------------------------------

-- 3.1  FIFO allocations (must go before order_items and inventory_fifo_layers)
DELETE FROM order_item_fifo_allocations;
DELETE FROM inventory_fifo_layers;

-- 3.2  Payment detail tables (must go before payments and orders)
DELETE FROM payment_allocations;
DELETE FROM payment_unapplied_credits;

-- 3.3  Debt transactions (must go before orders)
DELETE FROM debt_transactions;

-- 3.4  Stock movements (must go before orders)
DELETE FROM stock_transactions;

-- 3.5  Order items (must go before orders)
DELETE FROM order_items;

-- 3.6  Price change audit log (product/order ref — safe after order_items)
DELETE FROM price_change_logs;

-- 3.7  Payments (must go before orders)
DELETE FROM payments;

-- 3.8  Orders (root of sale chain)
DELETE FROM orders;

-- 3.9  Debt installment chain (plans after transactions; config after plans)
DELETE FROM debt_installment_payments;
DELETE FROM debt_installment_plans;
DELETE FROM debt_monthly_installments;

-- 3.10 Purchase chain
DELETE FROM purchase_order_items;
DELETE FROM purchase_orders;
DELETE FROM supplier_payments;
DELETE FROM purchase_lots;

-- 3.11 AI / session / log tables (no FK dependencies)
DELETE FROM ai_chat_sessions;
DELETE FROM ai_learning_logs;
DELETE FROM ai_action_logs;
DELETE FROM ai_error_logs;

-- 3.12 General audit logs
DELETE FROM audit_logs;
DELETE FROM delete_logs;
DELETE FROM import_audit_logs;

-- 3.13 Auth runtime tables
DELETE FROM auth_event_logs;
DELETE FROM user_login_otps;
DELETE FROM password_reset_requests;

-- 3.14 Customer account registrations (pending/approved requests — transactional)
DELETE FROM customer_account_registrations;

-- ---------------------------------------------------------------------------
-- STEP 4 : VERIFICATION QUERIES
--          Run these BEFORE committing.  All counts must be 0.
-- ---------------------------------------------------------------------------

SELECT 'order_item_fifo_allocations'    tbl, COUNT(*) remaining FROM order_item_fifo_allocations
UNION ALL SELECT 'inventory_fifo_layers',          COUNT(*) FROM inventory_fifo_layers
UNION ALL SELECT 'payment_allocations',            COUNT(*) FROM payment_allocations
UNION ALL SELECT 'payment_unapplied_credits',      COUNT(*) FROM payment_unapplied_credits
UNION ALL SELECT 'debt_transactions',              COUNT(*) FROM debt_transactions
UNION ALL SELECT 'stock_transactions',             COUNT(*) FROM stock_transactions
UNION ALL SELECT 'order_items',                    COUNT(*) FROM order_items
UNION ALL SELECT 'payments',                       COUNT(*) FROM payments
UNION ALL SELECT 'orders',                         COUNT(*) FROM orders
UNION ALL SELECT 'debt_installment_payments',      COUNT(*) FROM debt_installment_payments
UNION ALL SELECT 'debt_installment_plans',         COUNT(*) FROM debt_installment_plans
UNION ALL SELECT 'debt_monthly_installments',      COUNT(*) FROM debt_monthly_installments
UNION ALL SELECT 'purchase_order_items',           COUNT(*) FROM purchase_order_items
UNION ALL SELECT 'purchase_orders',                COUNT(*) FROM purchase_orders
UNION ALL SELECT 'supplier_payments',              COUNT(*) FROM supplier_payments
UNION ALL SELECT 'purchase_lots',                  COUNT(*) FROM purchase_lots
UNION ALL SELECT 'ai_chat_sessions',               COUNT(*) FROM ai_chat_sessions
UNION ALL SELECT 'ai_learning_logs',               COUNT(*) FROM ai_learning_logs
UNION ALL SELECT 'ai_action_logs',                 COUNT(*) FROM ai_action_logs
UNION ALL SELECT 'ai_error_logs',                  COUNT(*) FROM ai_error_logs
UNION ALL SELECT 'audit_logs',                     COUNT(*) FROM audit_logs
UNION ALL SELECT 'delete_logs',                    COUNT(*) FROM delete_logs
UNION ALL SELECT 'import_audit_logs',              COUNT(*) FROM import_audit_logs
UNION ALL SELECT 'auth_event_logs',                COUNT(*) FROM auth_event_logs
UNION ALL SELECT 'user_login_otps',                COUNT(*) FROM user_login_otps
UNION ALL SELECT 'password_reset_requests',        COUNT(*) FROM password_reset_requests
UNION ALL SELECT 'customer_account_registrations', COUNT(*) FROM customer_account_registrations
UNION ALL SELECT 'price_change_logs',              COUNT(*) FROM price_change_logs;

-- Confirm master data is untouched
SELECT 'customers'                    tbl, COUNT(*) kept FROM customers
UNION ALL SELECT 'users',                      COUNT(*) FROM users
UNION ALL SELECT 'products',                   COUNT(*) FROM products
UNION ALL SELECT 'product_categories',         COUNT(*) FROM product_categories
UNION ALL SELECT 'suppliers',                  COUNT(*) FROM suppliers
UNION ALL SELECT 'customer_product_prices',    COUNT(*) FROM customer_product_prices
UNION ALL SELECT 'customer_product_catalogs',  COUNT(*) FROM customer_product_catalogs
UNION ALL SELECT 'customer_price_books',       COUNT(*) FROM customer_price_books
UNION ALL SELECT 'customer_price_book_items',  COUNT(*) FROM customer_price_book_items
UNION ALL SELECT 'user_menu_permissions',      COUNT(*) FROM user_menu_permissions
UNION ALL SELECT 'role_menu_permissions',      COUNT(*) FROM role_menu_permissions
UNION ALL SELECT 'business_settings',          COUNT(*) FROM business_settings
UNION ALL SELECT 'migration_history',          COUNT(*) FROM migration_history
UNION ALL SELECT 'product_supplier_links',     COUNT(*) FROM product_supplier_links
UNION ALL SELECT 'sponsors',                   COUNT(*) FROM sponsors
UNION ALL SELECT 'sponsor_ad_campaigns',       COUNT(*) FROM sponsor_ad_campaigns
UNION ALL SELECT 'business_portal_pages',      COUNT(*) FROM business_portal_pages
UNION ALL SELECT 'product_ocr_aliases',        COUNT(*) FROM product_ocr_aliases
UNION ALL SELECT 'ocr_provider_configs',       COUNT(*) FROM ocr_provider_configs
UNION ALL SELECT 'user_app_preferences',       COUNT(*) FROM user_app_preferences;

-- Confirm backup row counts match originals
SELECT
    'orders'                       AS backed_table,
    (SELECT COUNT(*) FROM _orders_bak_reset_20260621)                      AS backup_rows
UNION ALL SELECT 'order_items',
    (SELECT COUNT(*) FROM _order_items_bak_reset_20260621)
UNION ALL SELECT 'payments',
    (SELECT COUNT(*) FROM _payments_bak_reset_20260621)
UNION ALL SELECT 'debt_monthly_installments',
    (SELECT COUNT(*) FROM _debt_monthly_installments_bak_reset_20260621)
UNION ALL SELECT 'purchase_lots',
    (SELECT COUNT(*) FROM _purchase_lots_bak_reset_20260621);

-- ---------------------------------------------------------------------------
-- STEP 5 : COMMIT (uncomment only after reviewing verification results)
-- ---------------------------------------------------------------------------
-- COMMIT;

-- ---------------------------------------------------------------------------
-- To ABORT all changes:
-- ROLLBACK;
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- POST-COMMIT CLEANUP (run manually after verifying reset is correct)
-- Backup tables are NOT dropped automatically.
-- ---------------------------------------------------------------------------
-- DROP TABLE IF EXISTS _orders_bak_reset_20260621;
-- DROP TABLE IF EXISTS _order_items_bak_reset_20260621;
-- DROP TABLE IF EXISTS _payments_bak_reset_20260621;
-- DROP TABLE IF EXISTS _payment_allocations_bak_reset_20260621;
-- DROP TABLE IF EXISTS _payment_unapplied_credits_bak_reset_20260621;
-- DROP TABLE IF EXISTS _debt_transactions_bak_reset_20260621;
-- DROP TABLE IF EXISTS _debt_installment_plans_bak_reset_20260621;
-- DROP TABLE IF EXISTS _debt_installment_payments_bak_reset_20260621;
-- DROP TABLE IF EXISTS _debt_monthly_installments_bak_reset_20260621;
-- DROP TABLE IF EXISTS _stock_transactions_bak_reset_20260621;
-- DROP TABLE IF EXISTS _purchase_lots_bak_reset_20260621;
-- DROP TABLE IF EXISTS _supplier_payments_bak_reset_20260621;
-- DROP TABLE IF EXISTS _purchase_orders_bak_reset_20260621;
-- DROP TABLE IF EXISTS _purchase_order_items_bak_reset_20260621;
-- DROP TABLE IF EXISTS _inventory_fifo_layers_bak_reset_20260621;
-- DROP TABLE IF EXISTS _order_item_fifo_allocations_bak_reset_20260621;

-- =============================================================================
-- TABLE CLASSIFICATION LEGEND
-- =============================================================================
--
-- MASTER TABLES — NOT touched by this script (data preserved)
-- ─────────────────────────────────────────────────────────────────────────────
--  customers                 — customer registry
--  users                     — staff / admin accounts
--  products                  — product catalog
--  product_categories        — category tree
--  suppliers                 — supplier registry
--  customer_product_prices   — legacy per-customer prices
--  customer_product_catalogs — which products appear in each customer's UI
--  customer_price_books      — versioned price book headers (V65.44)
--  customer_price_book_items — versioned price book line items (V65.44)
--  user_menu_permissions     — per-user menu access control
--  role_menu_permissions     — role-level menu defaults
--  business_settings         — global system settings
--  business_portal_pages     — CMS portal content
--  sponsors                  — sponsor registry
--  sponsor_ad_campaigns      — ad campaign definitions
--  product_supplier_links    — product ↔ supplier mapping
--  product_ocr_aliases       — OCR alias overrides per product
--  ocr_provider_configs      — OCR provider settings (Google DocAI, etc.)
--  user_app_preferences      — per-user UI preferences (theme, last page, etc.)
--  migration_history         — applied migration tracking (NEVER delete)
--
-- TRANSACTION / RUNTIME / LOG TABLES — CLEARED by this script
-- ─────────────────────────────────────────────────────────────────────────────
--  orders                        — sale order headers
--  order_items                   — sale order lines
--  payments                      — customer payment records
--  payment_allocations           — payment ↔ order allocation ledger (V65.42)
--  payment_unapplied_credits     — unallocated payment credit pool
--  debt_transactions             — debt change journal
--  debt_installment_plans        — individual customer debt repayment plans
--  debt_installment_payments     — payments against installment plans
--  debt_monthly_installments     — per-customer installment schedule config (reset with data)
--  stock_transactions            — inventory movement journal
--  purchase_lots                 — goods receipt lots from suppliers
--  supplier_payments             — payments to suppliers
--  purchase_orders               — purchase order headers
--  purchase_order_items          — purchase order lines
--  inventory_fifo_layers         — FIFO cost layers built from purchase_lots (V65.43)
--  order_item_fifo_allocations   — FIFO cost allocation per order item (V65.43)
--  price_change_logs             — price change audit trail
--  audit_logs                    — general action audit log
--  delete_logs                   — soft-delete record log
--  import_audit_logs             — Excel / OCR import audit log
--  ai_chat_sessions              — AI chat conversation history
--  ai_learning_logs              — AI feedback / learning records
--  ai_action_logs                — AI agent action log (V19)
--  ai_error_logs                 — AI agent error log (V19)
--  auth_event_logs               — login / registration event log
--  user_login_otps               — OTP tokens (short-lived runtime)
--  password_reset_requests       — password reset tokens (short-lived runtime)
--  customer_account_registrations — pending customer self-registration requests
-- =============================================================================
