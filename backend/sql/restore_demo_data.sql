-- ============================================================================
-- RESTORE MINIMAL DEMO DATA
-- ============================================================================
-- !!! DO NOT RUN THIS SCRIPT AS PART OF THIS TASK. IT HAS NOT BEEN EXECUTED. !!!
--
-- Purpose: after backup -> dry-run -> reset_non_master_data.sql, seed the
-- smallest coherent demo dataset needed for one clean end-to-end test cycle
-- (one Bò Xô bill, one Hàng Kho bill), without duplicating existing Master
-- Data on repeated runs.
--
-- IDEMPOTENCY STRATEGY (see backend/sql/audit_non_master_data_reset.md and
-- the accompanying report for the full evidence trail):
--   - Tables with a real UNIQUE constraint on a stable code column
--     (products.product_code, customers.customer_code,
--     suppliers.supplier_code, units.code, warehouses.code) use
--     INSERT ... SELECT ... WHERE NOT EXISTS keyed on that column, then a
--     separate SELECT to resolve the id into a session variable — safe
--     whether this run creates the row or a prior run already did.
--   - product_categories has NO unique constraint on `name` (verified via
--     information_schema.STATISTICS — only a PRIMARY KEY exists). The
--     distinctive "DEMO - " prefix is used as the de-facto dedup key via the
--     same WHERE NOT EXISTS pattern. This is an application-level guarantee,
--     not a DB-enforced one — documented, not silently assumed safe.
--   - customer_price_categories, customer_price_books,
--     customer_price_book_items, customer_product_catalogs all have real
--     UNIQUE constraints (verified) and use the same guarded-insert pattern
--     keyed on those constraints.
--   - customer_product_prices and supplier_purchase_options have NO unique
--     constraint (verified) — guarded via an explicit NOT EXISTS check on
--     the same (customer_id/supplier_id, product_id) pair the application
--     itself treats as the logical identity.
--   - customer_price_books.effective_from uses a FIXED constant date
--     (2024-01-01), NEVER CURDATE() — the table's unique constraints include
--     effective_from, so using "today" would create a NEW duplicate-looking
--     book every time this script is re-run on a different day. A fixed,
--     far-past, open-ended (effective_to = NULL) date resolves correctly for
--     any order date from then until a real future price change.
--
-- OPENING STOCK: deliberately NOT included in this SQL script. See
-- backend/scripts/restore-demo-opening-stock.js and the trade-off
-- explanation in the accompanying report — products.stock_quantity is a
-- Single-Writer-owned balance (InventoryMovementService), and this script
-- does not bypass that. Run the Node helper as a separate, explicit step
-- after this script.
--
-- SAFETY: this script never disables FOREIGN_KEY_CHECKS, never truncates,
-- never deletes, and never updates any row that isn't itself carrying the
-- "DEMO - " / "DEMO_" identity it created or is reusing.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- STEP 0 — SCHEMA/ENVIRONMENT ASSERTION
-- ----------------------------------------------------------------------------
-- Same pattern as reset_non_master_data.sql. Edit and uncomment before use.
--
-- SET @EXPECTED_SCHEMA = 'REPLACE_WITH_EXACT_TARGET_SCHEMA_NAME';
-- SELECT IF(DATABASE() = @EXPECTED_SCHEMA, 'OK', NULL) INTO @schema_check;
-- SELECT CASE WHEN @schema_check IS NULL THEN (SELECT 1/0)
--   ELSE 'Schema assertion passed' END AS schema_assertion_result;

SELECT CONCAT('Restoring demo data into schema: ', DATABASE()) AS environment_warning;
SELECT 'THIS IS TEST/DEMO DATA ONLY. Do not run against a schema containing real customer/business records you do not intend to mix demo rows into.' AS demo_warning;

-- Pre-check: confirm the tables this script depends on actually exist before
-- attempting anything (fails loudly and early rather than partway through).
SELECT COUNT(*) AS required_tables_found FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (
  'warehouses','product_categories','customers','suppliers','products','units',
  'customer_price_categories','customer_price_books','customer_price_book_items',
  'customer_product_catalogs','customer_product_prices','supplier_purchase_options'
);
-- EXPECTED: 12. If less, STOP — the schema does not match what this script assumes.


START TRANSACTION;

-- ----------------------------------------------------------------------------
-- 1. Demo warehouse
-- ----------------------------------------------------------------------------
INSERT INTO warehouses (code, name, is_default, is_active)
SELECT 'DEMO_WH_001', 'DEMO - Kho kiểm thử', 0, 1
WHERE NOT EXISTS (SELECT 1 FROM warehouses WHERE code = 'DEMO_WH_001');
SET @demo_warehouse_id = (SELECT id FROM warehouses WHERE code = 'DEMO_WH_001' LIMIT 1);

-- ----------------------------------------------------------------------------
-- 2. Demo categories (no unique key on name — dedup via WHERE NOT EXISTS,
--    documented above)
-- ----------------------------------------------------------------------------
INSERT INTO product_categories (name, sort_order, is_active)
SELECT 'DEMO - Danh mục Bò xô', 999, 1
WHERE NOT EXISTS (SELECT 1 FROM product_categories WHERE name = 'DEMO - Danh mục Bò xô');
SET @demo_cat_carcass_id = (SELECT id FROM product_categories WHERE name = 'DEMO - Danh mục Bò xô' LIMIT 1);

INSERT INTO product_categories (name, sort_order, is_active)
SELECT 'DEMO - Danh mục Hàng kho', 999, 1
WHERE NOT EXISTS (SELECT 1 FROM product_categories WHERE name = 'DEMO - Danh mục Hàng kho');
SET @demo_cat_stock_id = (SELECT id FROM product_categories WHERE name = 'DEMO - Danh mục Hàng kho' LIMIT 1);

-- ----------------------------------------------------------------------------
-- 3. Reuse existing unit (kg) — Master Data already present, confirmed via
--    live query (units.code='kg', id=1 at audit time). Falls back to creating
--    a demo unit ONLY if 'kg' is genuinely absent, never assumed.
-- ----------------------------------------------------------------------------
INSERT INTO units (code, name, is_active, sort_order)
SELECT 'DEMO_UNIT_KG', 'Kg (demo)', 1, 999
WHERE NOT EXISTS (SELECT 1 FROM units WHERE code = 'kg')
  AND NOT EXISTS (SELECT 1 FROM units WHERE code = 'DEMO_UNIT_KG');
SET @demo_unit_id = COALESCE(
  (SELECT id FROM units WHERE code = 'kg' LIMIT 1),
  (SELECT id FROM units WHERE code = 'DEMO_UNIT_KG' LIMIT 1)
);

-- ----------------------------------------------------------------------------
-- 4. Demo customers — default_sales_flow set explicitly per the task's
--    business-configuration instruction, never inferred from inventory_mode.
-- ----------------------------------------------------------------------------
INSERT INTO customers (customer_code, name, phone, address, price_mode, billing_calendar_type, is_active, del_flg, partner_type, default_sales_flow)
SELECT 'DEMO_CUS_CARCASS', 'DEMO - Khách Bò xô', '0900000001', 'Demo address - Bò xô', 'COMMON_PRICE', 'SOLAR', 1, 0, 2, 'CARCASS_POS'
WHERE NOT EXISTS (SELECT 1 FROM customers WHERE customer_code = 'DEMO_CUS_CARCASS');
SET @demo_customer_carcass_id = (SELECT id FROM customers WHERE customer_code = 'DEMO_CUS_CARCASS' LIMIT 1);

INSERT INTO customers (customer_code, name, phone, address, price_mode, billing_calendar_type, is_active, del_flg, partner_type, default_sales_flow)
SELECT 'DEMO_CUS_STOCK', 'DEMO - Khách Hàng kho', '0900000002', 'Demo address - Hàng kho', 'COMMON_PRICE', 'SOLAR', 1, 0, 2, 'INVENTORY_SALE'
WHERE NOT EXISTS (SELECT 1 FROM customers WHERE customer_code = 'DEMO_CUS_STOCK');
SET @demo_customer_stock_id = (SELECT id FROM customers WHERE customer_code = 'DEMO_CUS_STOCK' LIMIT 1);

-- ----------------------------------------------------------------------------
-- 5. Demo supplier
-- ----------------------------------------------------------------------------
INSERT INTO suppliers (supplier_code, name, phone, address, is_active, del_flg, billing_calendar_type)
SELECT 'DEMO_SUP_001', 'DEMO - Nhà cung cấp', '0900000003', 'Demo address - NCC', 1, 0, 'SOLAR'
WHERE NOT EXISTS (SELECT 1 FROM suppliers WHERE supplier_code = 'DEMO_SUP_001');
SET @demo_supplier_id = (SELECT id FROM suppliers WHERE supplier_code = 'DEMO_SUP_001' LIMIT 1);

-- ----------------------------------------------------------------------------
-- 6. Demo products — sales_flow/inventory_mode set per the verified compat
--    matrix (backend/src/utils/productSalesFlow.js:
--    CARCASS_POS -> NON_STOCK only, INVENTORY_SALE -> TRACK_STOCK only).
--    stock_quantity intentionally left at its column default (0) here — see
--    the Opening Stock note at the top of this file.
-- ----------------------------------------------------------------------------
INSERT INTO products (category_id, product_code, name, unit, default_sale_price, default_purchase_price, low_stock_threshold, is_active, del_flg, inventory_mode, allow_negative_stock, sales_flow)
SELECT @demo_cat_carcass_id, 'DEMO_PRD_CARCASS', 'DEMO - Thịt bò xô', 'kg', 150000, 120000, 5, 1, 0, 'NON_STOCK', 1, 'CARCASS_POS'
WHERE NOT EXISTS (SELECT 1 FROM products WHERE product_code = 'DEMO_PRD_CARCASS');
SET @demo_product_carcass_id = (SELECT id FROM products WHERE product_code = 'DEMO_PRD_CARCASS' LIMIT 1);

INSERT INTO products (category_id, product_code, name, unit, default_sale_price, default_purchase_price, low_stock_threshold, is_active, del_flg, inventory_mode, allow_negative_stock, sales_flow)
SELECT @demo_cat_stock_id, 'DEMO_PRD_STOCK', 'DEMO - Bắp bò kho', 'kg', 180000, 140000, 5, 1, 0, 'TRACK_STOCK', 0, 'INVENTORY_SALE'
WHERE NOT EXISTS (SELECT 1 FROM products WHERE product_code = 'DEMO_PRD_STOCK');
SET @demo_product_stock_id = (SELECT id FROM products WHERE product_code = 'DEMO_PRD_STOCK' LIMIT 1);

-- ----------------------------------------------------------------------------
-- 7. Customer product catalogs — required for PriceMatrixAgent.
--    customerCatalogForOrder() to surface these products in the POS catalog
--    at all (verified: it JOINs customer_product_catalogs).
-- ----------------------------------------------------------------------------
INSERT INTO customer_product_catalogs (customer_id, product_id, sort_order, is_default, is_active, del_flg)
SELECT @demo_customer_carcass_id, @demo_product_carcass_id, 999, 1, 1, 0
WHERE NOT EXISTS (SELECT 1 FROM customer_product_catalogs WHERE customer_id = @demo_customer_carcass_id AND product_id = @demo_product_carcass_id);

INSERT INTO customer_product_catalogs (customer_id, product_id, sort_order, is_default, is_active, del_flg)
SELECT @demo_customer_stock_id, @demo_product_stock_id, 999, 1, 1, 0
WHERE NOT EXISTS (SELECT 1 FROM customer_product_catalogs WHERE customer_id = @demo_customer_stock_id AND product_id = @demo_product_stock_id);

-- ----------------------------------------------------------------------------
-- 8. Customer price categories (one per demo customer, matching its flow)
-- ----------------------------------------------------------------------------
INSERT INTO customer_price_categories (customer_id, category_id, is_default, display_order, sales_flow)
SELECT @demo_customer_carcass_id, @demo_cat_carcass_id, 1, 1, 'CARCASS_POS'
WHERE NOT EXISTS (SELECT 1 FROM customer_price_categories WHERE customer_id = @demo_customer_carcass_id AND category_id = @demo_cat_carcass_id);
SET @demo_price_cat_carcass_id = (SELECT id FROM customer_price_categories WHERE customer_id = @demo_customer_carcass_id AND category_id = @demo_cat_carcass_id LIMIT 1);

INSERT INTO customer_price_categories (customer_id, category_id, is_default, display_order, sales_flow)
SELECT @demo_customer_stock_id, @demo_cat_stock_id, 1, 1, 'INVENTORY_SALE'
WHERE NOT EXISTS (SELECT 1 FROM customer_price_categories WHERE customer_id = @demo_customer_stock_id AND category_id = @demo_cat_stock_id);
SET @demo_price_cat_stock_id = (SELECT id FROM customer_price_categories WHERE customer_id = @demo_customer_stock_id AND category_id = @demo_cat_stock_id LIMIT 1);

-- ----------------------------------------------------------------------------
-- 9. Customer price books — FIXED effective_from (see idempotency note at
--    top of file). effective_to left NULL (open-ended).
-- ----------------------------------------------------------------------------
INSERT INTO customer_price_books (customer_id, category_id, customer_price_category_id, book_name, effective_from, effective_calendar_type, status, note)
SELECT @demo_customer_carcass_id, @demo_cat_carcass_id, @demo_price_cat_carcass_id, 'DEMO - Bảng giá Bò xô', '2024-01-01', 'SOLAR', 'ACTIVE', 'Demo price book - test data'
WHERE NOT EXISTS (
  SELECT 1 FROM customer_price_books
  WHERE customer_price_category_id = @demo_price_cat_carcass_id AND effective_from = '2024-01-01' AND effective_calendar_type = 'SOLAR'
);
SET @demo_book_carcass_id = (SELECT id FROM customer_price_books WHERE customer_price_category_id = @demo_price_cat_carcass_id AND effective_from = '2024-01-01' AND effective_calendar_type = 'SOLAR' LIMIT 1);

INSERT INTO customer_price_books (customer_id, category_id, customer_price_category_id, book_name, effective_from, effective_calendar_type, status, note)
SELECT @demo_customer_stock_id, @demo_cat_stock_id, @demo_price_cat_stock_id, 'DEMO - Bảng giá Hàng kho', '2024-01-01', 'SOLAR', 'ACTIVE', 'Demo price book - test data'
WHERE NOT EXISTS (
  SELECT 1 FROM customer_price_books
  WHERE customer_price_category_id = @demo_price_cat_stock_id AND effective_from = '2024-01-01' AND effective_calendar_type = 'SOLAR'
);
SET @demo_book_stock_id = (SELECT id FROM customer_price_books WHERE customer_price_category_id = @demo_price_cat_stock_id AND effective_from = '2024-01-01' AND effective_calendar_type = 'SOLAR' LIMIT 1);

-- ----------------------------------------------------------------------------
-- 10. Customer price book items — simple demo prices, clearly test data.
--     Never touches any other customer's/product's pricing.
-- ----------------------------------------------------------------------------
INSERT INTO customer_price_book_items (price_book_id, customer_id, product_id, sale_price, note)
SELECT @demo_book_carcass_id, @demo_customer_carcass_id, @demo_product_carcass_id, 150000, 'Demo price'
WHERE NOT EXISTS (SELECT 1 FROM customer_price_book_items WHERE price_book_id = @demo_book_carcass_id AND product_id = @demo_product_carcass_id);

INSERT INTO customer_price_book_items (price_book_id, customer_id, product_id, sale_price, note)
SELECT @demo_book_stock_id, @demo_customer_stock_id, @demo_product_stock_id, 180000, 'Demo price'
WHERE NOT EXISTS (SELECT 1 FROM customer_price_book_items WHERE price_book_id = @demo_book_stock_id AND product_id = @demo_product_stock_id);

-- ----------------------------------------------------------------------------
-- 11. Supplier purchase option — enables purchase/receive testing for the
--     Hàng kho demo product. No unique constraint exists on this table
--     (verified) — guarded via NOT EXISTS on (supplier_id, product_id), the
--     pair the application treats as the logical identity.
-- ----------------------------------------------------------------------------
INSERT INTO supplier_purchase_options (supplier_id, product_id, unit_id, default_conversion_qty, requires_actual_weight, display_order, is_active)
SELECT @demo_supplier_id, @demo_product_stock_id, @demo_unit_id, 1.0000, 0, 999, 1
WHERE NOT EXISTS (SELECT 1 FROM supplier_purchase_options WHERE supplier_id = @demo_supplier_id AND product_id = @demo_product_stock_id);


-- ----------------------------------------------------------------------------
-- POST-INSERT, PRE-COMMIT VERIFICATION (inside the same transaction)
-- ----------------------------------------------------------------------------
SELECT 'demo_warehouse' k, @demo_warehouse_id v
UNION ALL SELECT 'demo_cat_carcass_id', @demo_cat_carcass_id
UNION ALL SELECT 'demo_cat_stock_id', @demo_cat_stock_id
UNION ALL SELECT 'demo_unit_id', @demo_unit_id
UNION ALL SELECT 'demo_customer_carcass_id', @demo_customer_carcass_id
UNION ALL SELECT 'demo_customer_stock_id', @demo_customer_stock_id
UNION ALL SELECT 'demo_supplier_id', @demo_supplier_id
UNION ALL SELECT 'demo_product_carcass_id', @demo_product_carcass_id
UNION ALL SELECT 'demo_product_stock_id', @demo_product_stock_id
UNION ALL SELECT 'demo_price_cat_carcass_id', @demo_price_cat_carcass_id
UNION ALL SELECT 'demo_price_cat_stock_id', @demo_price_cat_stock_id
UNION ALL SELECT 'demo_book_carcass_id', @demo_book_carcass_id
UNION ALL SELECT 'demo_book_stock_id', @demo_book_stock_id;
-- EXPECTED: every value non-NULL. If any is NULL, do NOT commit — ROLLBACK
-- and investigate (a prerequisite insert likely failed silently on a schema
-- mismatch).

COMMIT;
-- ROLLBACK;   -- <-- run this INSTEAD of COMMIT if any id above was NULL


-- ============================================================================
-- NEXT STEP (separate, not part of this script)
-- ============================================================================
SELECT 'Demo data restored. Next: run backend/scripts/restore-demo-opening-stock.js to seed opening stock for DEMO_PRD_STOCK, then verify_non_master_data_reset.sql-style checks, then follow demo_smoke_test_checklist.md.' AS next_step;
