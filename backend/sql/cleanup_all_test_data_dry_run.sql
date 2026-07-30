-- ============================================================================
-- SAFE TEST-DATA CLEANUP — DRY RUN (READ-ONLY)
-- ============================================================================
-- This script performs ZERO writes. It contains ONLY SELECT / SHOW /
-- information_schema statements. No INSERT, UPDATE, DELETE, TRUNCATE, ALTER,
-- DROP, or CREATE appears anywhere in this file.
--
-- Purpose: show exactly what cleanup_all_test_data.sql would affect —
-- both Stage A (all transactional data) and Stage B (Claude-generated demo
-- Master Data only, identified by exact DEMO_ codes/names) — before anyone
-- runs it. See CLEANUP_ALL_TEST_DATA_AUDIT.md for full evidence and
-- reasoning behind every table/identifier below.
--
-- Safe to run against any environment for inspection purposes only — it
-- changes nothing either way.
-- ============================================================================

SELECT '=== 1. SCHEMA IDENTITY (confirm you are pointed at the right database) ===' AS section;
SELECT DATABASE() AS current_schema, VERSION() AS mysql_version, @@sql_mode AS sql_mode;


SELECT '=== 2. STAGE A — TRANSACTION TABLE ROW COUNTS (all will be deleted) ===' AS section;
SELECT 'debt_installment_payments' t, COUNT(*) rows_before FROM debt_installment_payments
UNION ALL SELECT 'debt_transactions', COUNT(*) FROM debt_transactions
UNION ALL SELECT 'payment_allocations', COUNT(*) FROM payment_allocations
UNION ALL SELECT 'payment_unapplied_credits', COUNT(*) FROM payment_unapplied_credits
UNION ALL SELECT 'payments', COUNT(*) FROM payments
UNION ALL SELECT 'order_items', COUNT(*) FROM order_items
UNION ALL SELECT 'orders', COUNT(*) FROM orders
UNION ALL SELECT 'debt_installment_plans', COUNT(*) FROM debt_installment_plans
UNION ALL SELECT 'debt_monthly_installments', COUNT(*) FROM debt_monthly_installments
UNION ALL SELECT 'stock_transactions', COUNT(*) FROM stock_transactions
UNION ALL SELECT 'inventory_adjustments', COUNT(*) FROM inventory_adjustments
UNION ALL SELECT 'inventory_receive_items', COUNT(*) FROM inventory_receive_items
UNION ALL SELECT 'inventory_receives', COUNT(*) FROM inventory_receives
UNION ALL SELECT 'purchase_order_items', COUNT(*) FROM purchase_order_items
UNION ALL SELECT 'supplier_payable_transactions', COUNT(*) FROM supplier_payable_transactions
UNION ALL SELECT 'supplier_purchase_payments', COUNT(*) FROM supplier_purchase_payments
UNION ALL SELECT 'purchase_lot_items', COUNT(*) FROM purchase_lot_items
UNION ALL SELECT 'purchase_lots', COUNT(*) FROM purchase_lots
UNION ALL SELECT 'supplier_payments', COUNT(*) FROM supplier_payments
UNION ALL SELECT 'purchase_orders', COUNT(*) FROM purchase_orders;

SELECT '=== 2b. STAGE A — BUSINESS/OPERATIONAL AUDIT TABLES (separate decision, see audit .md section 13) ===' AS section;
SELECT 'price_change_logs' t, COUNT(*) rows_before FROM price_change_logs
UNION ALL SELECT 'import_audit_logs', COUNT(*) FROM import_audit_logs
UNION ALL SELECT 'ai_action_logs', COUNT(*) FROM ai_action_logs
UNION ALL SELECT 'ai_error_logs', COUNT(*) FROM ai_error_logs
UNION ALL SELECT 'ai_learning_logs', COUNT(*) FROM ai_learning_logs
UNION ALL SELECT 'ai_chat_sessions', COUNT(*) FROM ai_chat_sessions
UNION ALL SELECT 'retail_daily_summary', COUNT(*) FROM retail_daily_summary
UNION ALL SELECT 'delete_logs', COUNT(*) FROM delete_logs;


SELECT '=== 3. STAGE B — RESOLVE EXACT DEMO IDENTIFIERS (from restore_demo_data.sql) ===' AS section;
SET @demo_warehouse_id     = (SELECT id FROM warehouses WHERE code = 'DEMO_WH_001' LIMIT 1);
SET @demo_cat_carcass_id   = (SELECT id FROM product_categories WHERE name = 'DEMO - Danh mục Bò xô' LIMIT 1);
SET @demo_cat_stock_id     = (SELECT id FROM product_categories WHERE name = 'DEMO - Danh mục Hàng kho' LIMIT 1);
SET @demo_customer_carcass_id = (SELECT id FROM customers WHERE customer_code = 'DEMO_CUS_CARCASS' LIMIT 1);
SET @demo_customer_stock_id   = (SELECT id FROM customers WHERE customer_code = 'DEMO_CUS_STOCK' LIMIT 1);
SET @demo_supplier_id      = (SELECT id FROM suppliers WHERE supplier_code = 'DEMO_SUP_001' LIMIT 1);
SET @demo_product_carcass_id = (SELECT id FROM products WHERE product_code = 'DEMO_PRD_CARCASS' LIMIT 1);
SET @demo_product_stock_id   = (SELECT id FROM products WHERE product_code = 'DEMO_PRD_STOCK' LIMIT 1);
SET @demo_unit_id          = (SELECT id FROM units WHERE code = 'DEMO_UNIT_KG' LIMIT 1);

SELECT 'demo_warehouse_id' k, @demo_warehouse_id v
UNION ALL SELECT 'demo_cat_carcass_id', @demo_cat_carcass_id
UNION ALL SELECT 'demo_cat_stock_id', @demo_cat_stock_id
UNION ALL SELECT 'demo_customer_carcass_id', @demo_customer_carcass_id
UNION ALL SELECT 'demo_customer_stock_id', @demo_customer_stock_id
UNION ALL SELECT 'demo_supplier_id', @demo_supplier_id
UNION ALL SELECT 'demo_product_carcass_id', @demo_product_carcass_id
UNION ALL SELECT 'demo_product_stock_id', @demo_product_stock_id
UNION ALL SELECT 'demo_unit_id (NULL is expected/correct if kg was reused instead — see audit .md section 8)', @demo_unit_id;
-- A NULL value above means that specific demo row does not currently exist —
-- correct and expected in an environment where restore_demo_data.sql was
-- never run (confirmed to be the case as of this audit). Every Stage B
-- SELECT below is NULL-safe: a NULL id matches zero rows in any WHERE clause.


SELECT '=== 4. STAGE B — EXACT DEMO ROWS SELECTED FOR DELETION, BY TABLE ===' AS section;

SELECT 'warehouses (DEMO)' t, id, code, name FROM warehouses WHERE code = 'DEMO_WH_001';
SELECT 'product_categories (DEMO)' t, id, name FROM product_categories WHERE name IN ('DEMO - Danh mục Bò xô', 'DEMO - Danh mục Hàng kho');
SELECT 'units (DEMO, conditional)' t, id, code, name FROM units WHERE code = 'DEMO_UNIT_KG';
SELECT 'customers (DEMO)' t, id, customer_code, name FROM customers WHERE customer_code IN ('DEMO_CUS_CARCASS', 'DEMO_CUS_STOCK');
SELECT 'suppliers (DEMO)' t, id, supplier_code, name FROM suppliers WHERE supplier_code = 'DEMO_SUP_001';
SELECT 'products (DEMO)' t, id, product_code, name, stock_quantity, inventory_mode FROM products WHERE product_code IN ('DEMO_PRD_CARCASS', 'DEMO_PRD_STOCK');

SELECT 'customer_product_catalogs (DEMO, by resolved FK)' t, id, customer_id, product_id
FROM customer_product_catalogs
WHERE customer_id IN (@demo_customer_carcass_id, @demo_customer_stock_id)
   OR product_id IN (@demo_product_carcass_id, @demo_product_stock_id);

SELECT 'customer_price_categories (DEMO, by resolved FK)' t, id, customer_id, category_id
FROM customer_price_categories
WHERE customer_id IN (@demo_customer_carcass_id, @demo_customer_stock_id)
   OR category_id IN (@demo_cat_carcass_id, @demo_cat_stock_id);

SET @demo_price_cat_carcass_id = (SELECT id FROM customer_price_categories WHERE customer_id = @demo_customer_carcass_id AND category_id = @demo_cat_carcass_id LIMIT 1);
SET @demo_price_cat_stock_id   = (SELECT id FROM customer_price_categories WHERE customer_id = @demo_customer_stock_id AND category_id = @demo_cat_stock_id LIMIT 1);

SELECT 'customer_price_books (DEMO, by resolved FK)' t, id, book_name, customer_price_category_id
FROM customer_price_books
WHERE customer_price_category_id IN (@demo_price_cat_carcass_id, @demo_price_cat_stock_id)
   OR customer_id IN (@demo_customer_carcass_id, @demo_customer_stock_id);

SELECT 'customer_price_book_items (DEMO, by resolved FK)' t, cpbi.id, cpbi.price_book_id, cpbi.product_id
FROM customer_price_book_items cpbi
WHERE cpbi.price_book_id IN (SELECT id FROM customer_price_books WHERE customer_price_category_id IN (@demo_price_cat_carcass_id, @demo_price_cat_stock_id))
   OR cpbi.product_id IN (@demo_product_carcass_id, @demo_product_stock_id);

SELECT 'customer_product_prices (DEMO, by resolved FK)' t, id, customer_id, product_id
FROM customer_product_prices
WHERE customer_id IN (@demo_customer_carcass_id, @demo_customer_stock_id)
   OR product_id IN (@demo_product_carcass_id, @demo_product_stock_id);

SELECT 'supplier_purchase_options (DEMO, by resolved FK)' t, id, supplier_id, product_id
FROM supplier_purchase_options
WHERE supplier_id = @demo_supplier_id
   OR product_id IN (@demo_product_carcass_id, @demo_product_stock_id);

SELECT 'product_ocr_aliases (DEMO, by resolved FK)' t, id, customer_id, product_id, alias_text
FROM product_ocr_aliases
WHERE customer_id IN (@demo_customer_carcass_id, @demo_customer_stock_id)
   OR product_id IN (@demo_product_carcass_id, @demo_product_stock_id);

SELECT 'product_supplier_links (DEMO, by resolved FK)' t, id, product_id, supplier_id
FROM product_supplier_links
WHERE product_id IN (@demo_product_carcass_id, @demo_product_stock_id)
   OR supplier_id = @demo_supplier_id;

SELECT 'stock_transactions (DEMO OPENING_BALANCE, by resolved FK — expected empty, Stage A already clears the whole table first)' t, id, product_id, reference_type, quantity
FROM stock_transactions
WHERE reference_type = 'OPENING_BALANCE' AND product_id = @demo_product_stock_id;


SELECT '=== 5. INVENTORY BALANCES FOR DEMO PRODUCTS (informational) ===' AS section;
SELECT id, product_code, name, stock_quantity, inventory_mode
FROM products WHERE product_code IN ('DEMO_PRD_CARCASS', 'DEMO_PRD_STOCK');


SELECT '=== 6. RECORDS THAT WILL BE PRESERVED (Real Master Data — sample counts) ===' AS section;
SELECT 'users' t, COUNT(*) rows_kept FROM users
UNION ALL SELECT 'role_menu_permissions', COUNT(*) FROM role_menu_permissions
UNION ALL SELECT 'user_menu_permissions', COUNT(*) FROM user_menu_permissions
UNION ALL SELECT 'app_menus', COUNT(*) FROM app_menus
UNION ALL SELECT 'business_settings', COUNT(*) FROM business_settings
UNION ALL SELECT 'ocr_provider_configs', COUNT(*) FROM ocr_provider_configs
UNION ALL SELECT 'products (ALL, incl. demo — see row 4 above for the demo subset)', COUNT(*) FROM products
UNION ALL SELECT 'products (NON-demo only)', COUNT(*) FROM products WHERE product_code NOT IN ('DEMO_PRD_CARCASS','DEMO_PRD_STOCK') OR product_code IS NULL
UNION ALL SELECT 'customers (ALL)', COUNT(*) FROM customers
UNION ALL SELECT 'customers (NON-demo only)', COUNT(*) FROM customers WHERE customer_code NOT IN ('DEMO_CUS_CARCASS','DEMO_CUS_STOCK') OR customer_code IS NULL
UNION ALL SELECT 'suppliers (ALL)', COUNT(*) FROM suppliers
UNION ALL SELECT 'suppliers (NON-demo only)', COUNT(*) FROM suppliers WHERE supplier_code NOT IN ('DEMO_SUP_001') OR supplier_code IS NULL
UNION ALL SELECT 'product_categories (ALL)', COUNT(*) FROM product_categories
UNION ALL SELECT 'product_categories (NON-demo only)', COUNT(*) FROM product_categories WHERE name NOT IN ('DEMO - Danh mục Bò xô','DEMO - Danh mục Hàng kho')
UNION ALL SELECT 'units (ALL, incl. kg — never deleted)', COUNT(*) FROM units
UNION ALL SELECT 'warehouses (NON-demo only)', COUNT(*) FROM warehouses WHERE code NOT IN ('DEMO_WH_001') OR code IS NULL;


SELECT '=== 7. AMBIGUOUS RECORDS EXCLUDED (never touched by any script in this package) ===' AS section;
SELECT 'customer_groups' t, COUNT(*) rows_untouched FROM customer_groups
UNION ALL SELECT 'payment_methods', COUNT(*) FROM payment_methods
UNION ALL SELECT 'system_settings', COUNT(*) FROM system_settings
UNION ALL SELECT 'electronic_invoices', COUNT(*) FROM electronic_invoices
UNION ALL SELECT 'product_purchase_options', COUNT(*) FROM product_purchase_options
UNION ALL SELECT 'sponsor_ad_campaigns', COUNT(*) FROM sponsor_ad_campaigns
UNION ALL SELECT 'business_portal_pages', COUNT(*) FROM business_portal_pages;


SELECT '=== 8. DUPLICATE DEMO IDENTIFIER CHECK (must be <=1 row each — product_categories has no unique constraint on name) ===' AS section;
SELECT 'DEMO - Danh mục Bò xô' AS demo_category_name, COUNT(*) AS matching_rows FROM product_categories WHERE name = 'DEMO - Danh mục Bò xô'
UNION ALL
SELECT 'DEMO - Danh mục Hàng kho', COUNT(*) FROM product_categories WHERE name = 'DEMO - Danh mục Hàng kho';
-- EXPECTED: 0 or 1 for each. If either shows >1, STOP — do not proceed to
-- execution until the duplicate is manually investigated (cleanup_all_test_
-- data.sql's safety guard will refuse to delete anything if this check fails).


SELECT '=== 9. ORPHAN RISK / ADVISORY-ONLY BROAD SCAN (NEVER used to select rows for deletion anywhere in this package) ===' AS section;
SELECT 'warehouses' t, id, code, name FROM warehouses WHERE code LIKE 'DEMO%' OR name LIKE 'DEMO %'
UNION ALL SELECT 'units', id, code, name FROM units WHERE code LIKE 'DEMO%' OR name LIKE 'DEMO %'
UNION ALL SELECT 'customers', id, customer_code, name FROM customers WHERE customer_code LIKE 'DEMO%' OR name LIKE 'DEMO %'
UNION ALL SELECT 'suppliers', id, supplier_code, name FROM suppliers WHERE supplier_code LIKE 'DEMO%' OR name LIKE 'DEMO %'
UNION ALL SELECT 'products', id, product_code, name FROM products WHERE product_code LIKE 'DEMO%' OR name LIKE 'DEMO %'
UNION ALL SELECT 'product_categories', id, NULL, name FROM product_categories WHERE name LIKE 'DEMO %';
-- If this advisory scan finds any row NOT already covered by section 4 above
-- (e.g. a demo-looking row with a naming variant this script's exact-match
-- list didn't anticipate), DO NOT delete it via broad matching. Investigate
-- manually, confirm it is genuinely Claude-generated test data, then add its
-- EXACT identifier to both this dry run and cleanup_all_test_data.sql before
-- re-running — per the task's explicit prohibition on `LIKE '%DEMO%'`-style
-- deletion.


SELECT '=== 10. EXPECTED ROWS DELETED PER TABLE (summary — cross-check against sections 2, 2b, and 4 above) ===' AS section;
SELECT 'See sections 2 (Stage A transactional), 2b (Stage A audit logs), and 4 (Stage B demo master + demo-linked children) above for the authoritative per-table counts. This section exists as a pointer, not a duplicate query, to avoid the count drifting out of sync with the real queries.' AS note;


SELECT '=== DRY RUN COMPLETE. No data was modified. Review every section above before proceeding to cleanup_all_test_data.sql. ===' AS section;
