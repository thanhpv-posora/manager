-- ============================================================================
-- SAFE TEST-DATA CLEANUP — POST-CLEANUP VERIFICATION (READ-ONLY)
-- ============================================================================
-- Run this AFTER cleanup_all_test_data.sql has been committed. Contains only
-- SELECT statements — makes no changes.
-- ============================================================================

SELECT '=== 1. TRANSACTIONAL TABLES — all must be EMPTY ===' AS section;
SELECT 'debt_installment_payments' t, COUNT(*) c FROM debt_installment_payments
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
UNION ALL SELECT 'purchase_orders', COUNT(*) FROM purchase_orders
UNION ALL SELECT 'price_change_logs', COUNT(*) FROM price_change_logs
UNION ALL SELECT 'import_audit_logs', COUNT(*) FROM import_audit_logs
UNION ALL SELECT 'ai_action_logs', COUNT(*) FROM ai_action_logs
UNION ALL SELECT 'ai_error_logs', COUNT(*) FROM ai_error_logs
UNION ALL SELECT 'ai_learning_logs', COUNT(*) FROM ai_learning_logs
UNION ALL SELECT 'ai_chat_sessions', COUNT(*) FROM ai_chat_sessions
UNION ALL SELECT 'retail_daily_summary', COUNT(*) FROM retail_daily_summary
UNION ALL SELECT 'delete_logs', COUNT(*) FROM delete_logs;
-- EXPECTED: every row above shows c = 0 (or, for any audit-log line the
-- CTO explicitly opted to keep this cycle per audit .md section 13, a
-- non-zero count there is expected and not an error).


SELECT '=== 2. NO DEMO_ PRODUCT CODES REMAIN ===' AS section;
SELECT id, product_code, name FROM products WHERE product_code IN ('DEMO_PRD_CARCASS', 'DEMO_PRD_STOCK');
-- EXPECTED: zero rows.

SELECT '=== 3. NO DEMO_ CUSTOMER CODES REMAIN ===' AS section;
SELECT id, customer_code, name FROM customers WHERE customer_code IN ('DEMO_CUS_CARCASS', 'DEMO_CUS_STOCK');
-- EXPECTED: zero rows.

SELECT '=== 4. NO DEMO_ SUPPLIER CODES REMAIN ===' AS section;
SELECT id, supplier_code, name FROM suppliers WHERE supplier_code = 'DEMO_SUP_001';
-- EXPECTED: zero rows.

SELECT '=== 5. NO DEMO_ WAREHOUSE CODES REMAIN ===' AS section;
SELECT id, code, name FROM warehouses WHERE code = 'DEMO_WH_001';
-- EXPECTED: zero rows.

SELECT '=== 6. NO EXACT DEMO CATEGORIES REMAIN ===' AS section;
SELECT id, name FROM product_categories WHERE name IN ('DEMO - Danh mục Bò xô', 'DEMO - Danh mục Hàng kho');
-- EXPECTED: zero rows.

SELECT '=== 7. NO DEMO PRICE BOOKS / ITEMS REMAIN ===' AS section;
SELECT id, book_name FROM customer_price_books WHERE book_name IN ('DEMO - Bảng giá Bò xô', 'DEMO - Bảng giá Hàng kho');
SELECT COUNT(*) AS orphan_check_price_book_items_referencing_nonexistent_book
FROM customer_price_book_items cpbi
LEFT JOIN customer_price_books cpb ON cpb.id = cpbi.price_book_id
WHERE cpb.id IS NULL;
-- EXPECTED: zero rows in the first query; 0 in the second (no orphaned items).

SELECT '=== 8. NO DEMO CATALOG / PRICE ASSIGNMENTS REMAIN ===' AS section;
SELECT COUNT(*) AS demo_customer_price_categories FROM customer_price_categories cpc
  WHERE NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = cpc.customer_id)
     OR NOT EXISTS (SELECT 1 FROM product_categories pc WHERE pc.id = cpc.category_id);
SELECT COUNT(*) AS demo_customer_product_catalogs FROM customer_product_catalogs cat
  WHERE NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = cat.customer_id)
     OR NOT EXISTS (SELECT 1 FROM products p WHERE p.id = cat.product_id);
SELECT COUNT(*) AS demo_customer_product_prices FROM customer_product_prices cpp
  WHERE NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = cpp.customer_id)
     OR NOT EXISTS (SELECT 1 FROM products p WHERE p.id = cpp.product_id);
-- EXPECTED: 0 for all three (these are orphan-reference checks — if any is
-- non-zero, a demo-linked row survived without its parent, or a real row's
-- parent was incorrectly removed; investigate before considering cleanup done).

SELECT '=== 9. NO DEMO SUPPLIER PURCHASE OPTIONS REMAIN ===' AS section;
SELECT COUNT(*) AS orphan_supplier_purchase_options FROM supplier_purchase_options spo
  WHERE NOT EXISTS (SELECT 1 FROM suppliers s WHERE s.id = spo.supplier_id)
     OR NOT EXISTS (SELECT 1 FROM products p WHERE p.id = spo.product_id);
-- EXPECTED: 0.

SELECT '=== 10. NO DEMO INVENTORY MOVEMENTS REMAIN ===' AS section;
SELECT COUNT(*) c FROM stock_transactions;
-- EXPECTED: 0 (Stage A empties this table entirely — demo or otherwise).

SELECT '=== 11. REAL MASTER DATA STILL EXISTS (compare vs the dry-run baseline you captured earlier) ===' AS section;
SELECT 'products' t, COUNT(*) c FROM products
UNION ALL SELECT 'customers', COUNT(*) FROM customers
UNION ALL SELECT 'suppliers', COUNT(*) FROM suppliers
UNION ALL SELECT 'product_categories', COUNT(*) FROM product_categories
UNION ALL SELECT 'units', COUNT(*) FROM units
UNION ALL SELECT 'warehouses', COUNT(*) FROM warehouses
UNION ALL SELECT 'customer_price_categories', COUNT(*) FROM customer_price_categories
UNION ALL SELECT 'customer_price_books', COUNT(*) FROM customer_price_books
UNION ALL SELECT 'customer_price_book_items', COUNT(*) FROM customer_price_book_items
UNION ALL SELECT 'customer_product_catalogs', COUNT(*) FROM customer_product_catalogs
UNION ALL SELECT 'supplier_purchase_options', COUNT(*) FROM supplier_purchase_options;
-- Do NOT assume any of these must be non-zero — a fresh/near-empty
-- environment legitimately has low counts. Compare against the SAME
-- environment's own dry-run baseline, not a hardcoded expectation.
SELECT id, code, name FROM units WHERE code = 'kg';
-- EXPECTED: exactly 1 row — the shared real unit must never have been touched.

SELECT '=== 12. AUTH/ROLES/PERMISSIONS STILL EXIST ===' AS section;
SELECT 'users' t, COUNT(*) c FROM users
UNION ALL SELECT 'role_menu_permissions', COUNT(*) FROM role_menu_permissions
UNION ALL SELECT 'user_menu_permissions', COUNT(*) FROM user_menu_permissions
UNION ALL SELECT 'user_menu_preferences', COUNT(*) FROM user_menu_preferences
UNION ALL SELECT 'app_menus', COUNT(*) FROM app_menus
UNION ALL SELECT 'auth_event_logs', COUNT(*) FROM auth_event_logs
UNION ALL SELECT 'user_login_otps', COUNT(*) FROM user_login_otps
UNION ALL SELECT 'password_reset_requests', COUNT(*) FROM password_reset_requests
UNION ALL SELECT 'customer_account_registrations', COUNT(*) FROM customer_account_registrations;
-- EXPECTED: identical to pre-cleanup counts — this script must never have
-- reduced any of these (cross-check against cleanup_all_test_data.sql STEP 2
-- if captured, or the dry run's section 6).

SELECT '=== 13. SYSTEM CONFIGURATION STILL EXISTS ===' AS section;
SELECT 'business_settings' t, COUNT(*) c FROM business_settings
UNION ALL SELECT 'ocr_provider_configs', COUNT(*) FROM ocr_provider_configs
UNION ALL SELECT 'user_app_preferences', COUNT(*) FROM user_app_preferences;
-- EXPECTED: identical to pre-cleanup counts.

SELECT '=== 14. NO ORPHAN FOREIGN-KEY RELATIONSHIPS ===' AS section;
SELECT COUNT(*) AS orphan_order_items FROM order_items oi LEFT JOIN orders o ON o.id = oi.order_id WHERE o.id IS NULL AND oi.order_id IS NOT NULL;
SELECT COUNT(*) AS orphan_products_missing_category FROM products p LEFT JOIN product_categories pc ON pc.id = p.category_id WHERE p.category_id IS NOT NULL AND pc.id IS NULL;
SELECT COUNT(*) AS orphan_customer_price_books FROM customer_price_books cpb LEFT JOIN customers c ON c.id = cpb.customer_id WHERE c.id IS NULL;
SELECT COUNT(*) AS orphan_supplier_purchase_options FROM supplier_purchase_options spo LEFT JOIN suppliers s ON s.id = spo.supplier_id WHERE s.id IS NULL;
-- EXPECTED: 0 for all — since transactional tables should be fully empty
-- (check 1) these will trivially be 0, but checked explicitly for certainty.

SELECT '=== 15. PRODUCT STOCK BALANCES — informational, consistent with the chosen clean-state rule ===' AS section;
SELECT id, product_code, name, stock_quantity, inventory_mode
FROM products WHERE inventory_mode = 'TRACK_STOCK' AND del_flg = 0 AND stock_quantity <> 0
ORDER BY stock_quantity DESC;
-- If the OPTIONAL inventory-balance reset section in cleanup_all_test_data.sql
-- was run and approved: EXPECTED zero rows. If it was intentionally skipped
-- (stock balances left as pre-cleanup values by CEO decision, per audit .md
-- section 10/22): non-zero rows here are expected and not an error — cross-
-- check against that decision, not against a hardcoded assumption.

SELECT '=== 16. CUSTOMER/SUPPLIER COMPUTED DEBT IS ZERO ===' AS section;
SELECT
  c.id, c.customer_code, c.name,
  COALESCE(SUM(CASE WHEN dt.type IN ('SALE','ADJUSTMENT_INCREASE') THEN dt.amount
                     WHEN dt.type IN ('PAYMENT','ADJUSTMENT_DECREASE') THEN -dt.amount
                     ELSE 0 END), 0) AS current_debt
FROM customers c
LEFT JOIN debt_transactions dt ON dt.customer_id = c.id
WHERE c.del_flg = 0
GROUP BY c.id, c.customer_code, c.name
HAVING current_debt <> 0;
-- EXPECTED: zero rows (every customer's computed debt is 0, since
-- debt_transactions is fully empty per check 1).

SELECT '=== 17. NO DUPLICATE OR RESIDUAL DEMO IDENTITIES REMAIN (advisory broad scan, informational only) ===' AS section;
SELECT 'warehouses' t, id, code, name FROM warehouses WHERE code LIKE 'DEMO%' OR name LIKE 'DEMO %'
UNION ALL SELECT 'units', id, code, name FROM units WHERE code LIKE 'DEMO%' OR name LIKE 'DEMO %'
UNION ALL SELECT 'customers', id, customer_code, name FROM customers WHERE customer_code LIKE 'DEMO%' OR name LIKE 'DEMO %'
UNION ALL SELECT 'suppliers', id, supplier_code, name FROM suppliers WHERE supplier_code LIKE 'DEMO%' OR name LIKE 'DEMO %'
UNION ALL SELECT 'products', id, product_code, name FROM products WHERE product_code LIKE 'DEMO%' OR name LIKE 'DEMO %'
UNION ALL SELECT 'product_categories', id, NULL, name FROM product_categories WHERE name LIKE 'DEMO %';
-- EXPECTED: zero rows across all six. If any row appears, it is a demo-
-- looking identity not covered by this package's exact-match list — do NOT
-- delete it via broad matching; investigate, confirm it is genuinely
-- Claude-generated test data, then handle it as a follow-up with its own
-- exact-identifier deletion, per the same rule cleanup_all_test_data.sql
-- itself follows.


SELECT '=== VERIFICATION COMPLETE ===' AS section;
