-- =========================================
-- V6_65 S1J — Simplify products.inventory_mode
-- Retires CARCASS_PART as a current Product inventory classification.
-- Final current values: NON_STOCK, TRACK_STOCK.
--
-- Does NOT touch: products.sales_flow, stock_quantity, order_items,
-- customer_price_books, or call any Product application route.
-- Idempotent — safe to run more than once (step 2's UPDATE matches zero
-- rows and step 4's MODIFY COLUMN redeclares the same definition on a
-- second run; neither errors nor changes any data further).
--
-- Historical order_items.inventory_mode snapshots (immutable, a different
-- column on a different table) are deliberately NOT touched by this file —
-- see ORDER_ITEMS POLICY in the S1J ticket. Application-level historical
-- reads/reversal already interpret a legacy CARCASS_PART snapshot with
-- NON_STOCK semantics via backend/src/utils/inventoryMode.js's
-- normalizeInventoryMode() (S1J).
-- =========================================

USE meat_business_db;

-- Step 1: count affected Product rows (informational — inspect this result
-- before proceeding if running interactively).
SELECT COUNT(*) AS affected_product_count
FROM products
WHERE inventory_mode = 'CARCASS_PART';

-- Step 2: update Product master data. Idempotent — matches zero rows once
-- already applied.
UPDATE products
SET inventory_mode = 'NON_STOCK'
WHERE inventory_mode = 'CARCASS_PART';

-- Step 3: verify no Product rows remain CARCASS_PART. Expected: 0.
SELECT COUNT(*) AS remaining_carcass_part_count
FROM products
WHERE inventory_mode = 'CARCASS_PART';

-- Step 4: tighten the Product column enum. Idempotent — MySQL allows
-- redeclaring a column with its current definition; running this a second
-- time is a no-op ALTER, not an error.
ALTER TABLE products
  MODIFY COLUMN inventory_mode ENUM('NON_STOCK','TRACK_STOCK') NOT NULL DEFAULT 'NON_STOCK';

-- Step 5: verify final schema.
SHOW COLUMNS FROM products LIKE 'inventory_mode';
