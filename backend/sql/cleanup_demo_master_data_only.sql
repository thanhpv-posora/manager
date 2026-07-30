-- ============================================================================
-- CLEANUP — DEMO MASTER DATA ONLY (Stage B, standalone) — OPTIONAL CONVENIENCE
-- ============================================================================
-- !!! DO NOT RUN. NOT EXECUTED. !!!
--
-- Use this ONLY if you want to remove Claude-generated demo Master Data
-- WITHOUT running the full transactional cleanup (Stage A). Because Stage A
-- has NOT necessarily emptied the transactional tables in this standalone
-- path, this script includes its OWN safety-net deletes of any transactional
-- rows that reference the demo entities, scoped exclusively to resolved
-- demo IDs, BEFORE removing the demo Master Data rows themselves — this is
-- required by the task's rule "their stock movement/history must be deleted
-- first, then their demo product record may be removed," applied here to
-- every demo-linked transactional domain, not just inventory.
--
-- If Stage A (cleanup_all_test_data.sql or cleanup_transaction_data_only.sql)
-- has already run, every safety-net delete below is a documented no-op
-- (the tables are already empty) — safe to run either way.
--
-- Every predicate below is an exact code/name match or an exact resolved-ID
-- foreign-key match. No LIKE '%DEMO%' pattern is used anywhere.
-- ============================================================================

SET @EXPECTED_SCHEMA    = 'REPLACE_WITH_EXACT_TARGET_SCHEMA_NAME';
SET @BACKUP_CONFIRMED    = 0;
SET @EXECUTION_CONFIRMED = 0;

SET @SCHEMA_OK = (SELECT CASE WHEN DATABASE() = @EXPECTED_SCHEMA THEN 1 ELSE 0 END);

-- Resolve demo identifiers
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

SET @cat_carcass_dup_count = (SELECT COUNT(*) FROM product_categories WHERE name = 'DEMO - Danh mục Bò xô');
SET @cat_stock_dup_count   = (SELECT COUNT(*) FROM product_categories WHERE name = 'DEMO - Danh mục Hàng kho');
SET @DEMO_IDS_OK = (SELECT CASE WHEN @cat_carcass_dup_count <= 1 AND @cat_stock_dup_count <= 1 THEN 1 ELSE 0 END);

SET @SAFE_TO_DELETE = (SELECT CASE WHEN @SCHEMA_OK = 1 AND @BACKUP_CONFIRMED = 1 AND @EXECUTION_CONFIRMED = 1 AND @DEMO_IDS_OK = 1 THEN 1 ELSE 0 END);
SELECT CONCAT('SCHEMA_OK=', @SCHEMA_OK, ' BACKUP_CONFIRMED=', @BACKUP_CONFIRMED, ' EXECUTION_CONFIRMED=', @EXECUTION_CONFIRMED, ' DEMO_IDS_OK=', @DEMO_IDS_OK, ' => SAFE_TO_DELETE=', @SAFE_TO_DELETE) AS master_gate;

SELECT 'demo_customer_carcass_id' k, @demo_customer_carcass_id v
UNION ALL SELECT 'demo_customer_stock_id', @demo_customer_stock_id
UNION ALL SELECT 'demo_supplier_id', @demo_supplier_id
UNION ALL SELECT 'demo_product_carcass_id', @demo_product_carcass_id
UNION ALL SELECT 'demo_product_stock_id', @demo_product_stock_id;

START TRANSACTION;

-- ============================================================================
-- SAFETY-NET: remove transactional rows referencing demo entities FIRST
-- (children before the demo Master Data parents below). Every predicate is
-- scoped exclusively to the resolved demo IDs above — never a broad delete.
-- ============================================================================

DELETE dt FROM debt_transactions dt
WHERE @SAFE_TO_DELETE = 1 AND dt.customer_id IN (@demo_customer_carcass_id, @demo_customer_stock_id);

DELETE pa FROM payment_allocations pa
JOIN payments p ON p.id = pa.payment_id
WHERE @SAFE_TO_DELETE = 1 AND p.customer_id IN (@demo_customer_carcass_id, @demo_customer_stock_id);

DELETE FROM payments
WHERE @SAFE_TO_DELETE = 1 AND customer_id IN (@demo_customer_carcass_id, @demo_customer_stock_id);

DELETE oi FROM order_items oi
JOIN orders o ON o.id = oi.order_id
WHERE @SAFE_TO_DELETE = 1
  AND (o.customer_id IN (@demo_customer_carcass_id, @demo_customer_stock_id)
       OR oi.product_id IN (@demo_product_carcass_id, @demo_product_stock_id));

DELETE FROM orders
WHERE @SAFE_TO_DELETE = 1 AND customer_id IN (@demo_customer_carcass_id, @demo_customer_stock_id);

DELETE FROM stock_transactions
WHERE @SAFE_TO_DELETE = 1 AND product_id IN (@demo_product_carcass_id, @demo_product_stock_id);

DELETE iri FROM inventory_receive_items iri
JOIN inventory_receives ir ON ir.id = iri.inventory_receive_id
WHERE @SAFE_TO_DELETE = 1
  AND (ir.supplier_id = @demo_supplier_id OR iri.product_id IN (@demo_product_carcass_id, @demo_product_stock_id));

DELETE FROM inventory_receives
WHERE @SAFE_TO_DELETE = 1 AND supplier_id = @demo_supplier_id;

DELETE poi FROM purchase_order_items poi
JOIN purchase_orders po ON po.id = poi.purchase_order_id
WHERE @SAFE_TO_DELETE = 1
  AND (po.supplier_id = @demo_supplier_id OR poi.product_id IN (@demo_product_carcass_id, @demo_product_stock_id));

DELETE FROM purchase_orders
WHERE @SAFE_TO_DELETE = 1 AND supplier_id = @demo_supplier_id;

DELETE FROM purchase_lot_items
WHERE @SAFE_TO_DELETE = 1 AND product_id IN (@demo_product_carcass_id, @demo_product_stock_id);

DELETE FROM purchase_lots
WHERE @SAFE_TO_DELETE = 1 AND supplier_id = @demo_supplier_id;

DELETE FROM supplier_payments
WHERE @SAFE_TO_DELETE = 1 AND supplier_id = @demo_supplier_id;

-- ============================================================================
-- STAGE B — DEMO MASTER DATA (children before parents; identical logic to
-- cleanup_all_test_data.sql's Stage B — see that file/CLEANUP_ALL_TEST_DATA_
-- AUDIT.md for full reasoning)
-- ============================================================================

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
WHERE @SAFE_TO_DELETE = 1 AND product_code IN ('DEMO_PRD_CARCASS', 'DEMO_PRD_STOCK');

DELETE FROM customers
WHERE @SAFE_TO_DELETE = 1 AND customer_code IN ('DEMO_CUS_CARCASS', 'DEMO_CUS_STOCK');

DELETE FROM suppliers
WHERE @SAFE_TO_DELETE = 1 AND supplier_code = 'DEMO_SUP_001';

DELETE FROM product_categories
WHERE @SAFE_TO_DELETE = 1 AND name IN ('DEMO - Danh mục Bò xô', 'DEMO - Danh mục Hàng kho');

DELETE FROM warehouses
WHERE @SAFE_TO_DELETE = 1 AND code = 'DEMO_WH_001';

DELETE FROM units
WHERE @SAFE_TO_DELETE = 1 AND code = 'DEMO_UNIT_KG'; -- never matches 'kg'


SELECT 'products WHERE product_code IN DEMO codes (must be 0)' t, COUNT(*) c FROM products WHERE product_code IN ('DEMO_PRD_CARCASS','DEMO_PRD_STOCK')
UNION ALL SELECT 'customers WHERE customer_code IN DEMO codes (must be 0)', COUNT(*) FROM customers WHERE customer_code IN ('DEMO_CUS_CARCASS','DEMO_CUS_STOCK')
UNION ALL SELECT 'suppliers WHERE supplier_code = DEMO_SUP_001 (must be 0)', COUNT(*) FROM suppliers WHERE supplier_code = 'DEMO_SUP_001'
UNION ALL SELECT 'units (must be UNCHANGED, kg never deleted)', COUNT(*) FROM units;

COMMIT;
-- ROLLBACK;   -- <-- use instead of COMMIT if anything above looked wrong
