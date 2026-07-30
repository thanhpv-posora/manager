-- ============================================================================
-- NON-MASTER DATA RESET — POST-RESET VERIFICATION (READ-ONLY)
-- ============================================================================
-- Run this AFTER reset_non_master_data.sql has been committed. Contains only
-- SELECT statements — makes no changes.
-- ============================================================================

SELECT '=== 1. Transactional tables must all be EMPTY ===' AS section;
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
UNION ALL SELECT 'purchase_orders', COUNT(*) FROM purchase_orders;
-- EXPECTED: every row above shows c = 0.

SELECT '=== 2. Master Data must be UNCHANGED (compare against the dry-run counts you captured earlier) ===' AS section;
SELECT 'users' t, COUNT(*) c FROM users
UNION ALL SELECT 'products', COUNT(*) FROM products
UNION ALL SELECT 'customers', COUNT(*) FROM customers
UNION ALL SELECT 'suppliers', COUNT(*) FROM suppliers
UNION ALL SELECT 'customer_price_categories', COUNT(*) FROM customer_price_categories
UNION ALL SELECT 'customer_price_books', COUNT(*) FROM customer_price_books
UNION ALL SELECT 'customer_price_book_items', COUNT(*) FROM customer_price_book_items
UNION ALL SELECT 'customer_product_catalogs', COUNT(*) FROM customer_product_catalogs
UNION ALL SELECT 'product_categories', COUNT(*) FROM product_categories
UNION ALL SELECT 'units', COUNT(*) FROM units
UNION ALL SELECT 'warehouses', COUNT(*) FROM warehouses
UNION ALL SELECT 'app_menus', COUNT(*) FROM app_menus
UNION ALL SELECT 'role_menu_permissions', COUNT(*) FROM role_menu_permissions
UNION ALL SELECT 'user_menu_permissions', COUNT(*) FROM user_menu_permissions;
-- EXPECTED: identical to the "MASTER DATA TABLES" section of the dry-run output.

SELECT '=== 3. Customer debt must be internally consistent (0 for every customer, computed live) ===' AS section;
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
-- EXPECTED: zero rows returned (every customer's computed debt is 0).

SELECT '=== 4. Inventory balances (informational — only meaningful if the OPTIONAL reset section was run; see audit .md section 7) ===' AS section;
SELECT id, product_code, name, stock_quantity, inventory_mode
FROM products
WHERE inventory_mode = 'TRACK_STOCK' AND del_flg = 0 AND stock_quantity <> 0
ORDER BY stock_quantity DESC;
-- If the OPTIONAL "reset stock_quantity to 0" section was run and approved,
-- EXPECTED: zero rows. If that section was intentionally skipped (stock
-- balances left as pre-reset values by CEO decision), non-zero rows here are
-- expected and not an error — cross-check against that decision.

SELECT '=== 5. Application can create the first clean test bill: manual check, not a query ===' AS section;
SELECT 'Log in, open the POS/order screen, and create one order for an existing customer + existing product. Confirm it saves and appears in the Orders list.' AS manual_step;

SELECT '=== 6. Application can perform the next clean inventory/purchase test: manual check, not a query ===' AS section;
SELECT 'Create one purchase order / inventory receive for an existing supplier + existing product. Confirm stock_quantity updates correctly and the new stock_transactions row is consistent with it.' AS manual_step;

SELECT '=== VERIFICATION COMPLETE ===' AS section;
