-- ============================================================================
-- MIGRATION PRE-CHECK — products.name collation (accent-sensitive fix)
-- ============================================================================
-- READ-ONLY. No writes. Run this BEFORE migrate_products_name_collation_up.sql
-- and review every result.
--
-- Context: CTO-reported bug states products.name currently compares as
-- accent-INSENSITIVE ('Nầm' = 'Nạm' -> 1) under utf8mb4_0900_ai_ci, which
-- would let two visually-different, business-distinct products (e.g.
-- "Nạm" vs "Nầm") be treated as equal by any SQL comparison that goes
-- through the products.name column. This script captures the exact current
-- state before changing anything.
-- ============================================================================

SELECT '=== 1. Target schema / MySQL version (utf8mb4_0900_as_ci requires MySQL 8.0.1+) ===' AS section;
SELECT DATABASE() AS current_schema, VERSION() AS mysql_version;
-- EXPECTED: mysql_version starts with 8.0 or higher. utf8mb4_0900_as_ci is
-- NOT available before MySQL 8.0.1 — do not proceed on an older server.

SELECT '=== 2. Exact CURRENT column definition (do not guess — this is what the UP migration must preserve byte-for-byte except collation) ===' AS section;
SELECT COLUMN_NAME, COLUMN_TYPE, CHARACTER_SET_NAME, COLLATION_NAME, IS_NULLABLE,
       COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'name';
-- Cross-check this against SHOW CREATE TABLE products below — both must agree.

SELECT '=== 3. Full current table DDL (for manual review before altering) ===' AS section;
SHOW CREATE TABLE products;

SELECT '=== 4. Is products.name already utf8mb4_0900_as_ci? ===' AS section;
SELECT
  (SELECT COLLATION_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='products' AND COLUMN_NAME='name') AS current_collation,
  (SELECT COLLATION_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='products' AND COLUMN_NAME='name') = 'utf8mb4_0900_as_ci' AS already_migrated;
-- If already_migrated = 1: the UP migration below is a safe, idempotent
-- no-op (re-applying the identical column definition) — this has been
-- observed to already be the case in this environment as of this audit
-- (2026-07-28); do not assume every environment (e.g. production) matches.

SELECT '=== 5. Does products.name (or any column combination including it) carry a UNIQUE constraint? ===' AS section;
SELECT INDEX_NAME, NON_UNIQUE, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products'
GROUP BY INDEX_NAME, NON_UNIQUE
ORDER BY NON_UNIQUE, INDEX_NAME;
-- Only `product_code` is expected to be UNIQUE (verified separately) — `name`
-- itself is not expected to carry a UNIQUE constraint. If this ever changes,
-- re-run section 6 below before proceeding, since a collation change could
-- then interact with that constraint.

SELECT '=== 6. Duplicate-name safety check (would ANY two active products already collide under the new, stricter accent-sensitive comparison?) ===' AS section;
-- Changing ai_ci -> as_ci only ever makes comparisons STRICTER (fewer values
-- considered equal), so it can only ever SPLIT existing duplicates apart —
-- it can never merge two previously-distinct names into a new collision.
-- This query is a defensive completeness check, not because the direction
-- of this specific change can create new duplicates.
SELECT name, COUNT(*) AS cnt, GROUP_CONCAT(id) AS product_ids, GROUP_CONCAT(product_code) AS codes
FROM products
WHERE del_flg = 0
GROUP BY name COLLATE utf8mb4_0900_as_ci
HAVING COUNT(*) > 1;
-- EXPECTED: zero rows. If any row appears, two active products already have
-- the byte-identical name today (a pre-existing data-quality issue,
-- unrelated to collation) — investigate before proceeding, do not silently
-- alter the column while this is true.

SELECT '=== 7. Smoke test: does the TARGET collation itself distinguish the reported pair, independent of the live column? ===' AS section;
SELECT
  ('Nạm' COLLATE utf8mb4_0900_as_ci) = ('Nầm' COLLATE utf8mb4_0900_as_ci) AS nam_eq_nam_AS_CI_expect_0,
  ('Nầm' COLLATE utf8mb4_0900_as_ci) = ('nầm' COLLATE utf8mb4_0900_as_ci) AS nam_eq_lower_AS_CI_expect_1,
  ('Nầm' COLLATE utf8mb4_0900_as_ci) = ('NẦM' COLLATE utf8mb4_0900_as_ci) AS nam_eq_upper_AS_CI_expect_1;
-- EXPECTED: 0, 1, 1 in that order — confirms utf8mb4_0900_as_ci is
-- accent-sensitive but still case-insensitive, exactly matching the
-- required business rule, BEFORE the column itself is touched.

SELECT '=== 8. Current live comparison via the actual column (what the bug report is about) ===' AS section;
SELECT id, name FROM products WHERE name IN ('Nạm','Nầm') ORDER BY id;
SELECT COUNT(*) AS rows_matching_literal_Nam FROM products WHERE name = 'Nạm';
SELECT COUNT(*) AS rows_matching_literal_Nam2 FROM products WHERE name = 'Nầm';
-- If products.name is still utf8mb4_0900_ai_ci in this environment, BOTH
-- counts above will incorrectly include both rows. If it is already
-- utf8mb4_0900_as_ci, each count will correctly show only its own row.

SELECT '=== PRE-CHECK COMPLETE. No data was modified. ===' AS section;
