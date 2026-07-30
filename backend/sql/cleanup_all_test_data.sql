-- ============================================================================
-- SAFE TEST-DATA CLEANUP — EXECUTION SCRIPT
-- ============================================================================
-- !!! DO NOT RUN THIS SCRIPT AS PART OF ANY AUTOMATED TASK. IT HAS NOT BEEN
-- !!! EXECUTED. MANUAL EXECUTION ONLY, AFTER EVERY STEP BELOW IS COMPLETE.
--
-- MANDATORY BEFORE RUNNING:
--   1. Stop application writes or enable maintenance mode.
--   2. Take a full mysqldump backup (see rollback_or_backup_notes.md for the
--      exact command template — no credentials are embedded there or here).
--   3. Run cleanup_all_test_data_dry_run.sql and review every section.
--   4. Review all selected DEMO records shown by the dry run (section 4).
--   5. Confirm real Master Data is not selected (dry run sections 6, 8, 9).
--   6. Obtain CTO/CEO approval where required (see CLEANUP_ALL_TEST_DATA_
--      AUDIT.md sections 21-22 — ambiguous tables, audit-log inclusion,
--      inventory-balance option).
--   7. Execute this script manually (statement-by-statement or as one file
--      via a controlled admin session).
--   8. Run verify_cleanup_all_test_data.sql.
--   9. Resume application writes only after successful verification.
--
-- STAGE A deletes ALL transactional/non-master data (FK-safe order, identical
-- scope to the previously-audited reset_non_master_data.sql).
-- STAGE B deletes ONLY Claude-generated demo Master Data, identified
-- exclusively by exact stable codes/names resolved from restore_demo_data.sql,
-- plus exact foreign-key relationships to the IDs those codes resolve to.
-- See CLEANUP_ALL_TEST_DATA_AUDIT.md for full evidence.
--
-- ENGINE: MySQL 8.0.35, InnoDB (all tables, confirmed live). FOREIGN_KEY_CHECKS
-- is NOT disabled anywhere. TRUNCATE is NOT used anywhere (auto-commits per
-- statement, resets AUTO_INCREMENT unconditionally, can fail against an
-- active FK reference). No broad `LIKE '%DEMO%'` matching is ever used to
-- SELECT rows for deletion — every Stage B predicate is an exact code/name
-- match or an exact resolved-ID foreign-key match.
--
-- ----------------------------------------------------------------------------
-- SAFETY MECHANISM — READ THIS BEFORE EDITING ANYTHING BELOW
-- ----------------------------------------------------------------------------
-- MySQL cannot programmatically ABORT a plain, non-stored-program, multi-
-- statement .sql script partway through based on a runtime condition (no
-- IF/SIGNAL is valid outside a stored procedure/function/trigger, and this
-- task's instructions explicitly forbid inventing invalid procedural SQL to
-- fake one). A prior generation of these scripts used a `SELECT CASE WHEN
-- <bad> THEN (SELECT 1/0) ELSE 'ok' END` pattern intending to force a fatal
-- error — this was TESTED LIVE against this exact database during this
-- audit and CONFIRMED NOT TO WORK: `SELECT 1/0` returns NULL with a warning
-- in a plain SELECT (ERROR_FOR_DIVISION_BY_ZERO only affects INSERT/UPDATE/
-- DELETE under STRICT_TRANS_TABLES, not SELECT). That pattern is NOT reused
-- here.
--
-- Instead, this script uses a verified, fail-SAFE (not fail-stop) mechanism:
-- every single DELETE statement below is individually gated by
-- `WHERE @SAFE_TO_DELETE = 1 AND <real condition>`. @SAFE_TO_DELETE is
-- computed ONCE, after the manual confirmation variables and all assertions,
-- from the AND of every guard. If ANY guard is not satisfied, EVERY DELETE
-- in this script affects ZERO rows — the script can be run start-to-finish
-- by mistake and nothing is deleted unless every condition is genuinely met.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- STEP 0 — MANUAL CONFIRMATION GUARDS (edit these three lines only)
-- ----------------------------------------------------------------------------
SET @EXPECTED_SCHEMA    = 'REPLACE_WITH_EXACT_TARGET_SCHEMA_NAME'; -- e.g. 'meat_business_db'
SET @BACKUP_CONFIRMED    = 0;  -- change to 1 only after a real mysqldump backup was taken THIS session
SET @EXECUTION_CONFIRMED = 0;  -- change to 1 only after CTO/CEO approval per audit .md sections 21-22


-- ----------------------------------------------------------------------------
-- STEP 1 — SCHEMA ASSERTION
-- ----------------------------------------------------------------------------
SET @SCHEMA_OK = (SELECT CASE WHEN DATABASE() = @EXPECTED_SCHEMA THEN 1 ELSE 0 END);
SELECT CONCAT('Target schema: ', DATABASE(), ' | Expected: ', @EXPECTED_SCHEMA, ' | Match: ', @SCHEMA_OK) AS schema_check;

-- Required tables exist (fails loudly via a NULL/short count, not silently)
SELECT COUNT(*) AS required_tables_found FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (
  'orders','order_items','payments','payment_allocations','payment_unapplied_credits',
  'debt_transactions','debt_installment_plans','debt_installment_payments','debt_monthly_installments',
  'stock_transactions','inventory_adjustments','inventory_receive_items','inventory_receives',
  'purchase_order_items','supplier_payable_transactions','supplier_purchase_payments',
  'purchase_lot_items','purchase_lots','supplier_payments','purchase_orders',
  'price_change_logs','import_audit_logs','ai_action_logs','ai_error_logs','ai_learning_logs',
  'ai_chat_sessions','retail_daily_summary','delete_logs',
  'warehouses','product_categories','units','customers','suppliers','products',
  'customer_price_categories','customer_price_books','customer_price_book_items',
  'customer_product_catalogs','customer_product_prices','supplier_purchase_options',
  'product_ocr_aliases','product_supplier_links'
);
-- EXPECTED: 40. If less, the schema does not match what this script assumes — STOP.


-- ----------------------------------------------------------------------------
-- STEP 2 — PRE-DELETE COUNTS (for the operator's own record; authoritative
-- counts are in cleanup_all_test_data_dry_run.sql, reviewed BEFORE this runs)
-- ----------------------------------------------------------------------------
SELECT 'orders' t, COUNT(*) c FROM orders
UNION ALL SELECT 'payments', COUNT(*) FROM payments
UNION ALL SELECT 'debt_transactions', COUNT(*) FROM debt_transactions
UNION ALL SELECT 'stock_transactions', COUNT(*) FROM stock_transactions
UNION ALL SELECT 'purchase_orders', COUNT(*) FROM purchase_orders
UNION ALL SELECT 'products (total)', COUNT(*) FROM products
UNION ALL SELECT 'customers (total)', COUNT(*) FROM customers
UNION ALL SELECT 'suppliers (total)', COUNT(*) FROM suppliers;


-- ----------------------------------------------------------------------------
-- STEP 3 — RESOLVE DEMO IDENTIFIERS + AMBIGUITY GUARD
-- ----------------------------------------------------------------------------
SET @demo_warehouse_id     = (SELECT id FROM warehouses WHERE code = 'DEMO_WH_001' LIMIT 1);
SET @demo_cat_carcass_id   = (SELECT id FROM product_categories WHERE name = 'DEMO - Danh mục Bò xô' LIMIT 1);
SET @demo_cat_stock_id     = (SELECT id FROM product_categories WHERE name = 'DEMO - Danh mục Hàng kho' LIMIT 1);
SET @demo_customer_carcass_id = (SELECT id FROM customers WHERE customer_code = 'DEMO_CUS_CARCASS' LIMIT 1);
SET @demo_customer_stock_id   = (SELECT id FROM customers WHERE customer_code = 'DEMO_CUS_STOCK' LIMIT 1);
SET @demo_supplier_id      = (SELECT id FROM suppliers WHERE supplier_code = 'DEMO_SUP_001' LIMIT 1);
SET @demo_product_carcass_id = (SELECT id FROM products WHERE product_code = 'DEMO_PRD_CARCASS' LIMIT 1);
SET @demo_product_stock_id   = (SELECT id FROM products WHERE product_code = 'DEMO_PRD_STOCK' LIMIT 1);
SET @demo_unit_id          = (SELECT id FROM units WHERE code = 'DEMO_UNIT_KG' LIMIT 1);
SET @demo_price_cat_carcass_id = (SELECT id FROM customer_price_categories WHERE customer_id = @demo_customer_carcass_id AND category_id = @demo_cat_carcass_id LIMIT 1);
SET @demo_price_cat_stock_id   = (SELECT id FROM customer_price_categories WHERE customer_id = @demo_customer_stock_id AND category_id = @demo_cat_stock_id LIMIT 1);

SELECT 'demo_warehouse_id' k, @demo_warehouse_id v
UNION ALL SELECT 'demo_cat_carcass_id', @demo_cat_carcass_id
UNION ALL SELECT 'demo_cat_stock_id', @demo_cat_stock_id
UNION ALL SELECT 'demo_customer_carcass_id', @demo_customer_carcass_id
UNION ALL SELECT 'demo_customer_stock_id', @demo_customer_stock_id
UNION ALL SELECT 'demo_supplier_id', @demo_supplier_id
UNION ALL SELECT 'demo_product_carcass_id', @demo_product_carcass_id
UNION ALL SELECT 'demo_product_stock_id', @demo_product_stock_id
UNION ALL SELECT 'demo_unit_id (NULL is normal/expected — see audit .md section 8)', @demo_unit_id;
-- A NULL value is normal and safe: every WHERE clause below that references
-- a NULL demo id matches zero rows (never all rows) in standard SQL — this
-- is NOT a source of accidental broad deletion.

-- Ambiguity guard: product_categories.name has no unique constraint, so this
-- is the one identifier this script cannot rely on the database to enforce.
SET @cat_carcass_dup_count = (SELECT COUNT(*) FROM product_categories WHERE name = 'DEMO - Danh mục Bò xô');
SET @cat_stock_dup_count   = (SELECT COUNT(*) FROM product_categories WHERE name = 'DEMO - Danh mục Hàng kho');
SET @DEMO_IDS_OK = (SELECT CASE WHEN @cat_carcass_dup_count <= 1 AND @cat_stock_dup_count <= 1 THEN 1 ELSE 0 END);
SELECT CONCAT('Demo category duplicate check — Bò xô: ', @cat_carcass_dup_count, ' | Hàng kho: ', @cat_stock_dup_count, ' | OK to proceed: ', @DEMO_IDS_OK) AS demo_id_ambiguity_check;


-- ----------------------------------------------------------------------------
-- STEP 4 — COMPUTE THE MASTER SAFETY GATE
-- ----------------------------------------------------------------------------
-- Every DELETE below is gated by @SAFE_TO_DELETE = 1. If ANY of the three
-- inputs is not satisfied, every DELETE in this script affects zero rows.
SET @SAFE_TO_DELETE = (SELECT CASE WHEN @SCHEMA_OK = 1 AND @BACKUP_CONFIRMED = 1 AND @EXECUTION_CONFIRMED = 1 AND @DEMO_IDS_OK = 1 THEN 1 ELSE 0 END);
SELECT CONCAT('SCHEMA_OK=', @SCHEMA_OK, ' BACKUP_CONFIRMED=', @BACKUP_CONFIRMED, ' EXECUTION_CONFIRMED=', @EXECUTION_CONFIRMED, ' DEMO_IDS_OK=', @DEMO_IDS_OK, ' => SAFE_TO_DELETE=', @SAFE_TO_DELETE) AS master_gate;
-- If SAFE_TO_DELETE shows 0, every statement below is a documented no-op.
-- Do not proceed to STEP 5 unless it shows 1.


START TRANSACTION;

-- ============================================================================
-- STAGE A — TRANSACTIONAL / NON-MASTER DATA (children before parents)
-- ============================================================================

-- --- Section A1: Sales / Payment / Debt domain -----------------------------
DELETE FROM debt_installment_payments WHERE @SAFE_TO_DELETE = 1;
DELETE FROM debt_transactions         WHERE @SAFE_TO_DELETE = 1;
DELETE FROM payment_allocations       WHERE @SAFE_TO_DELETE = 1;
DELETE FROM payment_unapplied_credits WHERE @SAFE_TO_DELETE = 1;
DELETE FROM payments                  WHERE @SAFE_TO_DELETE = 1;
DELETE FROM order_items               WHERE @SAFE_TO_DELETE = 1;
DELETE FROM orders                    WHERE @SAFE_TO_DELETE = 1;
DELETE FROM debt_installment_plans    WHERE @SAFE_TO_DELETE = 1;
DELETE FROM debt_monthly_installments WHERE @SAFE_TO_DELETE = 1;

-- --- Section A2: Inventory / Purchasing domain ------------------------------
DELETE FROM stock_transactions            WHERE @SAFE_TO_DELETE = 1;
DELETE FROM inventory_adjustments         WHERE @SAFE_TO_DELETE = 1;
DELETE FROM inventory_receive_items       WHERE @SAFE_TO_DELETE = 1;
DELETE FROM inventory_receives            WHERE @SAFE_TO_DELETE = 1;
DELETE FROM purchase_order_items          WHERE @SAFE_TO_DELETE = 1;
DELETE FROM supplier_payable_transactions WHERE @SAFE_TO_DELETE = 1;
DELETE FROM supplier_purchase_payments    WHERE @SAFE_TO_DELETE = 1;
-- purchase_lot_items: live FK is purchase_order_id -> purchase_orders.id
-- (verified live, disagrees with bootstrap.js's never-applied definition —
-- see CLEANUP_ALL_TEST_DATA_AUDIT.md section 4). Deleted here, before
-- purchase_orders, per the verified live FK.
DELETE FROM purchase_lot_items WHERE @SAFE_TO_DELETE = 1;
DELETE FROM purchase_lots      WHERE @SAFE_TO_DELETE = 1;
DELETE FROM supplier_payments  WHERE @SAFE_TO_DELETE = 1;
DELETE FROM purchase_orders    WHERE @SAFE_TO_DELETE = 1;

-- --- Section A3: Business/operational audit tables --------------------------
-- Separate from Sections A1/A2 by design (see audit .md section 13) — comment
-- out any individual line if the CEO/CTO decides a specific log should be
-- kept for this cycle. Security/auth audit (auth_event_logs, user_login_otps,
-- password_reset_requests, customer_account_registrations) is intentionally
-- NOT listed here — never touched by this script.
DELETE FROM price_change_logs WHERE @SAFE_TO_DELETE = 1;
DELETE FROM import_audit_logs WHERE @SAFE_TO_DELETE = 1;
DELETE FROM ai_action_logs    WHERE @SAFE_TO_DELETE = 1;
DELETE FROM ai_error_logs     WHERE @SAFE_TO_DELETE = 1;
DELETE FROM ai_learning_logs  WHERE @SAFE_TO_DELETE = 1;
DELETE FROM ai_chat_sessions  WHERE @SAFE_TO_DELETE = 1;
DELETE FROM retail_daily_summary WHERE @SAFE_TO_DELETE = 1;
DELETE FROM delete_logs       WHERE @SAFE_TO_DELETE = 1;


-- ============================================================================
-- STAGE B — DEMO MASTER DATA ONLY (children before parents; every predicate
-- is an exact code/name match or an exact resolved-ID foreign-key match —
-- NEVER a LIKE '%DEMO%' pattern)
-- ============================================================================

-- By the time Stage B runs, Stage A has already emptied every transactional
-- table that could reference the demo entities (orders/order_items/payments/
-- debt_transactions/stock_transactions/purchase_order_items/etc.) — so no
-- separate "delete demo transactions first" step is needed here. This is the
-- combined script; the standalone cleanup_demo_master_data_only.sql includes
-- its own equivalent safety-net deletes for when Stage A has not run.

DELETE cpbi FROM customer_price_book_items cpbi
WHERE @SAFE_TO_DELETE = 1
  AND (
    cpbi.price_book_id IN (SELECT id FROM customer_price_books WHERE customer_price_category_id IN (@demo_price_cat_carcass_id, @demo_price_cat_stock_id))
    OR cpbi.product_id IN (@demo_product_carcass_id, @demo_product_stock_id)
  );

DELETE FROM customer_price_books
WHERE @SAFE_TO_DELETE = 1
  AND (
    customer_price_category_id IN (@demo_price_cat_carcass_id, @demo_price_cat_stock_id)
    OR customer_id IN (@demo_customer_carcass_id, @demo_customer_stock_id)
  );

DELETE FROM customer_product_prices
WHERE @SAFE_TO_DELETE = 1
  AND (
    customer_id IN (@demo_customer_carcass_id, @demo_customer_stock_id)
    OR product_id IN (@demo_product_carcass_id, @demo_product_stock_id)
  );

DELETE FROM customer_product_catalogs
WHERE @SAFE_TO_DELETE = 1
  AND (
    customer_id IN (@demo_customer_carcass_id, @demo_customer_stock_id)
    OR product_id IN (@demo_product_carcass_id, @demo_product_stock_id)
  );

DELETE FROM customer_price_categories
WHERE @SAFE_TO_DELETE = 1
  AND (
    customer_id IN (@demo_customer_carcass_id, @demo_customer_stock_id)
    OR category_id IN (@demo_cat_carcass_id, @demo_cat_stock_id)
  );

DELETE FROM supplier_purchase_options
WHERE @SAFE_TO_DELETE = 1
  AND (
    supplier_id = @demo_supplier_id
    OR product_id IN (@demo_product_carcass_id, @demo_product_stock_id)
  );

DELETE FROM product_ocr_aliases
WHERE @SAFE_TO_DELETE = 1
  AND (
    customer_id IN (@demo_customer_carcass_id, @demo_customer_stock_id)
    OR product_id IN (@demo_product_carcass_id, @demo_product_stock_id)
  );

DELETE FROM product_supplier_links
WHERE @SAFE_TO_DELETE = 1
  AND (
    product_id IN (@demo_product_carcass_id, @demo_product_stock_id)
    OR supplier_id = @demo_supplier_id
  );

DELETE FROM products
WHERE @SAFE_TO_DELETE = 1
  AND product_code IN ('DEMO_PRD_CARCASS', 'DEMO_PRD_STOCK');

DELETE FROM customers
WHERE @SAFE_TO_DELETE = 1
  AND customer_code IN ('DEMO_CUS_CARCASS', 'DEMO_CUS_STOCK');

DELETE FROM suppliers
WHERE @SAFE_TO_DELETE = 1
  AND supplier_code = 'DEMO_SUP_001';

DELETE FROM product_categories
WHERE @SAFE_TO_DELETE = 1
  AND name IN ('DEMO - Danh mục Bò xô', 'DEMO - Danh mục Hàng kho');

DELETE FROM warehouses
WHERE @SAFE_TO_DELETE = 1
  AND code = 'DEMO_WH_001';

-- units: NEVER matches 'kg' — this predicate only ever matches the
-- dedicated fallback code, which is created only in an environment where
-- 'kg' was absent when restore_demo_data.sql ran (not the case here).
DELETE FROM units
WHERE @SAFE_TO_DELETE = 1
  AND code = 'DEMO_UNIT_KG';


-- ----------------------------------------------------------------------------
-- STEP 5 — POST-DELETE, PRE-COMMIT VERIFICATION (inside the same transaction)
-- ----------------------------------------------------------------------------
SELECT 'orders' t, COUNT(*) remaining FROM orders
UNION ALL SELECT 'order_items', COUNT(*) FROM order_items
UNION ALL SELECT 'payments', COUNT(*) FROM payments
UNION ALL SELECT 'debt_transactions', COUNT(*) FROM debt_transactions
UNION ALL SELECT 'stock_transactions', COUNT(*) FROM stock_transactions
UNION ALL SELECT 'purchase_orders', COUNT(*) FROM purchase_orders;
-- If @SAFE_TO_DELETE was 1: expect 0 for every row above.
-- If @SAFE_TO_DELETE was 0: expect the SAME counts as STEP 2 (nothing changed).

SELECT 'products WHERE product_code IN DEMO codes (must be 0 after Stage B)' t, COUNT(*) c FROM products WHERE product_code IN ('DEMO_PRD_CARCASS','DEMO_PRD_STOCK')
UNION ALL SELECT 'customers WHERE customer_code IN DEMO codes (must be 0)', COUNT(*) FROM customers WHERE customer_code IN ('DEMO_CUS_CARCASS','DEMO_CUS_STOCK')
UNION ALL SELECT 'suppliers WHERE supplier_code = DEMO_SUP_001 (must be 0)', COUNT(*) FROM suppliers WHERE supplier_code = 'DEMO_SUP_001'
UNION ALL SELECT 'warehouses WHERE code = DEMO_WH_001 (must be 0)', COUNT(*) FROM warehouses WHERE code = 'DEMO_WH_001'
UNION ALL SELECT 'product_categories WHERE name IN DEMO names (must be 0)', COUNT(*) FROM product_categories WHERE name IN ('DEMO - Danh mục Bò xô','DEMO - Danh mục Hàng kho');

SELECT 'products (must be UNCHANGED minus the 2 demo rows vs STEP 2 count)' t, COUNT(*) c FROM products;
SELECT 'customers (must be UNCHANGED minus the 2 demo rows vs STEP 2 count)' t, COUNT(*) c FROM customers;
SELECT 'suppliers (must be UNCHANGED minus the 1 demo row vs STEP 2 count)' t, COUNT(*) c FROM suppliers;
SELECT 'units (must be UNCHANGED — kg is never deleted)' t, COUNT(*) c FROM units;
SELECT 'users, role_menu_permissions, business_settings (must be fully UNCHANGED)' t, (SELECT COUNT(*) FROM users) users_c, (SELECT COUNT(*) FROM role_menu_permissions) rmp_c, (SELECT COUNT(*) FROM business_settings) bs_c;


-- ----------------------------------------------------------------------------
-- STEP 6 — COMMIT (clearly separated, manual, documented)
-- ----------------------------------------------------------------------------
-- Only run this line if:
--   (a) @SAFE_TO_DELETE showed 1 in STEP 4, AND
--   (b) every count in STEP 5 looks correct.
-- Otherwise run ROLLBACK instead — this undoes everything above with no need
-- to restore from the mysqldump backup, as long as COMMIT was not yet run.
COMMIT;
-- ROLLBACK;   -- <-- run this INSTEAD of COMMIT if anything in STEP 5 looked wrong


-- ============================================================================
-- OPTIONAL — INVENTORY BALANCE RESET FOR REAL, NON-DEMO PRODUCTS
-- (DISABLED BY DEFAULT — REQUIRES_CEO_DECISION, see audit .md section 10/22)
-- ============================================================================
-- Demo products' stock_quantity needs no separate treatment: their movements
-- were cleared by Stage A, then the product row itself was physically
-- deleted by Stage B — the stale balance is deleted along with the row.
--
-- For REAL, non-demo TRACK_STOCK products, no approval for a stock reset was
-- found on record (same conclusion as reset_non_master_data.sql). This is
-- Option A (reset to 0) — the simplest, fully ledger-consistent choice,
-- provided here as a clearly separated, commented, opt-in section, never
-- applied automatically. Do not uncomment without explicit CEO sign-off.
--
-- START TRANSACTION;
-- UPDATE products SET stock_quantity = 0
--   WHERE inventory_mode = 'TRACK_STOCK' AND del_flg = 0
--     AND product_code NOT IN ('DEMO_PRD_CARCASS','DEMO_PRD_STOCK'); -- demo already deleted, condition kept for defense-in-depth
-- SELECT id, product_code, name, stock_quantity FROM products WHERE inventory_mode = 'TRACK_STOCK' AND del_flg = 0;
-- COMMIT; -- or ROLLBACK


-- ============================================================================
-- OPTIONAL — AUTO_INCREMENT RESET (DISABLED BY DEFAULT, NOT RECOMMENDED)
-- ============================================================================
-- Per task instruction: do NOT reset AUTO_INCREMENT by default anywhere, and
-- NEVER on a table classified as REAL MASTER, SECURITY/AUTH, or CONFIGURATION
-- (products, customers, suppliers, users, etc. must never appear below).
-- order_code (the business-visible bill number) is generated from today's
-- date plus a same-day sequence, NOT from orders.id (confirmed by reading
-- backend/src/utils/code.js) — so resetting AUTO_INCREMENT on a purely
-- transactional table does not break code uniqueness. Left off by default
-- per instruction; only ever apply to a table that is confirmed EMPTY
-- (verified via STEP 5 above) and was never a Master/Security/Config table.
--
-- Example (uncomment only per-table, only after separate confirmation, only
-- for tables confirmed empty in STEP 5):
-- ALTER TABLE orders AUTO_INCREMENT = 1;
-- ALTER TABLE stock_transactions AUTO_INCREMENT = 1;
