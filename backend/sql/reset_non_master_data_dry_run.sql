-- ============================================================================
-- NON-MASTER DATA RESET — DRY RUN (READ-ONLY)
-- ============================================================================
-- This script performs ZERO writes. It contains no INSERT, UPDATE, DELETE,
-- or TRUNCATE statement anywhere. Every statement below is a SELECT.
--
-- Purpose: show exactly what reset_non_master_data.sql would affect, BEFORE
-- anyone runs it, so the CEO/CTO can review counts and make the decisions
-- flagged in audit_non_master_data_reset.md (REQUIRES_CTO_DECISION /
-- REQUIRES_CEO_DECISION) with real numbers in front of them.
--
-- Safe to run against production for inspection purposes ONLY IF you are
-- comfortable running read-only SELECTs there — it changes nothing either way.
-- ============================================================================

SELECT '=== SCHEMA IDENTITY (confirm you are pointed at the right database) ===' AS section;
SELECT DATABASE() AS current_schema, VERSION() AS mysql_version;

SELECT '=== TRANSACTIONAL TABLES TARGETED FOR RESET (row counts BEFORE reset) ===' AS section;
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

SELECT '=== BUSINESS/OPERATIONAL AUDIT TABLES (separate decision — see audit .md section 9) ===' AS section;
SELECT 'price_change_logs' t, COUNT(*) rows_before FROM price_change_logs
UNION ALL SELECT 'import_audit_logs', COUNT(*) FROM import_audit_logs
UNION ALL SELECT 'ai_action_logs', COUNT(*) FROM ai_action_logs
UNION ALL SELECT 'ai_error_logs', COUNT(*) FROM ai_error_logs
UNION ALL SELECT 'ai_learning_logs', COUNT(*) FROM ai_learning_logs
UNION ALL SELECT 'ai_chat_sessions', COUNT(*) FROM ai_chat_sessions
UNION ALL SELECT 'retail_daily_summary', COUNT(*) FROM retail_daily_summary
UNION ALL SELECT 'delete_logs', COUNT(*) FROM delete_logs;

SELECT '=== SECURITY/AUTH AUDIT TABLES (PRESERVED BY DEFAULT — not targeted) ===' AS section;
SELECT 'auth_event_logs' t, COUNT(*) rows_kept FROM auth_event_logs
UNION ALL SELECT 'user_login_otps', COUNT(*) FROM user_login_otps
UNION ALL SELECT 'password_reset_requests', COUNT(*) FROM password_reset_requests
UNION ALL SELECT 'customer_account_registrations', COUNT(*) FROM customer_account_registrations;

SELECT '=== MASTER DATA TABLES (EXPLICITLY PRESERVED — shown for confirmation only, never touched) ===' AS section;
SELECT 'users' t, COUNT(*) rows_kept FROM users
UNION ALL SELECT 'role_menu_permissions', COUNT(*) FROM role_menu_permissions
UNION ALL SELECT 'user_menu_permissions', COUNT(*) FROM user_menu_permissions
UNION ALL SELECT 'user_menu_preferences', COUNT(*) FROM user_menu_preferences
UNION ALL SELECT 'app_menus', COUNT(*) FROM app_menus
UNION ALL SELECT 'business_settings', COUNT(*) FROM business_settings
UNION ALL SELECT 'ocr_provider_configs', COUNT(*) FROM ocr_provider_configs
UNION ALL SELECT 'product_categories', COUNT(*) FROM product_categories
UNION ALL SELECT 'products', COUNT(*) FROM products
UNION ALL SELECT 'product_ocr_aliases', COUNT(*) FROM product_ocr_aliases
UNION ALL SELECT 'product_supplier_links', COUNT(*) FROM product_supplier_links
UNION ALL SELECT 'units', COUNT(*) FROM units
UNION ALL SELECT 'customers', COUNT(*) FROM customers
UNION ALL SELECT 'suppliers', COUNT(*) FROM suppliers
UNION ALL SELECT 'customer_price_categories', COUNT(*) FROM customer_price_categories
UNION ALL SELECT 'customer_price_books', COUNT(*) FROM customer_price_books
UNION ALL SELECT 'customer_price_book_items', COUNT(*) FROM customer_price_book_items
UNION ALL SELECT 'customer_product_catalogs', COUNT(*) FROM customer_product_catalogs
UNION ALL SELECT 'customer_product_prices', COUNT(*) FROM customer_product_prices
UNION ALL SELECT 'supplier_purchase_options', COUNT(*) FROM supplier_purchase_options
UNION ALL SELECT 'warehouses', COUNT(*) FROM warehouses
UNION ALL SELECT 'user_app_preferences', COUNT(*) FROM user_app_preferences;

SELECT '=== AMBIGUOUS TABLES — EXCLUDED FROM RESET, REQUIRES_CTO_DECISION (see audit .md section 5) ===' AS section;
SELECT 'customer_groups' t, COUNT(*) rows_untouched FROM customer_groups
UNION ALL SELECT 'payment_methods', COUNT(*) FROM payment_methods
UNION ALL SELECT 'system_settings', COUNT(*) FROM system_settings
UNION ALL SELECT 'electronic_invoices', COUNT(*) FROM electronic_invoices
UNION ALL SELECT 'product_purchase_options', COUNT(*) FROM product_purchase_options
UNION ALL SELECT 'sponsor_ad_campaigns', COUNT(*) FROM sponsor_ad_campaigns
UNION ALL SELECT 'business_portal_pages', COUNT(*) FROM business_portal_pages;

SELECT '=== INVENTORY BALANCE SUMMARY (before reset) — see audit .md section 7 for options ===' AS section;
SELECT
  COUNT(*) AS track_stock_product_count,
  SUM(stock_quantity) AS total_stock_quantity_all_track_stock_products,
  SUM(CASE WHEN stock_quantity <> 0 THEN 1 ELSE 0 END) AS products_with_nonzero_stock
FROM products
WHERE inventory_mode = 'TRACK_STOCK' AND del_flg = 0;

SELECT id, product_code, name, stock_quantity, allow_negative_stock
FROM products
WHERE inventory_mode = 'TRACK_STOCK' AND del_flg = 0 AND stock_quantity <> 0
ORDER BY stock_quantity DESC;

SELECT '=== CUSTOMER DEBT SUMMARY (before reset) — computed live, will be 0 for all after reset, no UPDATE needed (see audit .md section 8) ===' AS section;
SELECT
  c.id, c.customer_code, c.name,
  COALESCE(SUM(CASE WHEN dt.type IN ('SALE','ADJUSTMENT_INCREASE') THEN dt.amount
                     WHEN dt.type IN ('PAYMENT','ADJUSTMENT_DECREASE') THEN -dt.amount
                     ELSE 0 END), 0) AS current_debt_before_reset
FROM customers c
LEFT JOIN debt_transactions dt ON dt.customer_id = c.id
WHERE c.del_flg = 0
GROUP BY c.id, c.customer_code, c.name
HAVING current_debt_before_reset <> 0
ORDER BY current_debt_before_reset DESC;

SELECT '=== FOREIGN KEY DEPENDENCY ORDER USED BY THE EXECUTION SCRIPT ===' AS section;
SELECT
  1 AS step, 'debt_installment_payments' AS table_name UNION ALL SELECT 2,'debt_transactions'
  UNION ALL SELECT 3,'payment_allocations' UNION ALL SELECT 4,'payment_unapplied_credits'
  UNION ALL SELECT 5,'payments' UNION ALL SELECT 6,'order_items' UNION ALL SELECT 7,'orders'
  UNION ALL SELECT 8,'debt_installment_plans' UNION ALL SELECT 9,'debt_monthly_installments'
  UNION ALL SELECT 10,'stock_transactions' UNION ALL SELECT 11,'inventory_adjustments'
  UNION ALL SELECT 12,'inventory_receive_items' UNION ALL SELECT 13,'inventory_receives'
  UNION ALL SELECT 14,'purchase_order_items' UNION ALL SELECT 15,'supplier_payable_transactions'
  UNION ALL SELECT 16,'supplier_purchase_payments' UNION ALL SELECT 17,'purchase_lot_items'
  UNION ALL SELECT 18,'purchase_lots' UNION ALL SELECT 19,'supplier_payments'
  UNION ALL SELECT 20,'purchase_orders'
  ORDER BY step;

SELECT '=== DRY RUN COMPLETE. No data was modified. Review counts above before proceeding. ===' AS section;
