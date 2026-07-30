-- ============================================================================
-- MIGRATION POST-CHECK — products.name collation
-- ============================================================================
-- READ-ONLY. Run after migrate_products_name_collation_up.sql.
-- ============================================================================

SELECT '=== 1. Column collation is now accent-sensitive ===' AS section;
SELECT COLUMN_NAME, COLUMN_TYPE, CHARACTER_SET_NAME, COLLATION_NAME, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'name';
-- EXPECTED: COLLATION_NAME = 'utf8mb4_0900_as_ci'; every other attribute
-- (COLUMN_TYPE=varchar(255), CHARACTER_SET_NAME=utf8mb4, IS_NULLABLE=NO,
-- COLUMN_DEFAULT=NULL, EXTRA='') identical to the pre-check's section 2 output.

SELECT '=== 2. All other column attributes unchanged (compare row-by-row against the pre-check capture) ===' AS section;
SHOW CREATE TABLE products;
-- EXPECTED: identical to the pre-check's SHOW CREATE TABLE output except for
-- the single COLLATE token on the `name` column definition.

SELECT '=== 3. Business rule: Nạm != Nầm, case-insensitive within itself ===' AS section;
SELECT id, name FROM products WHERE name IN ('Nạm','Nầm') ORDER BY id;
SELECT COUNT(*) AS matches_Nam FROM products WHERE name = 'Nạm';
SELECT COUNT(*) AS matches_Nam2 FROM products WHERE name = 'Nầm';
-- EXPECTED: both counts = 1, matching only their own row.

SELECT '=== 4. No unrelated column/table was touched (spot-check a few other columns still carry the table default) ===' AS section;
SELECT COLUMN_NAME, COLLATION_NAME
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products'
  AND COLLATION_NAME IS NOT NULL
ORDER BY ORDINAL_POSITION;
-- EXPECTED: only `name` shows utf8mb4_0900_as_ci; any other text column on
-- this table (if present) still shows whatever it had before this migration
-- (e.g. utf8mb4_0900_ai_ci, the table default) — this migration must not
-- have changed anything else.

SELECT '=== 5. No duplicate-name conflicts were created by this change (sanity re-check) ===' AS section;
SELECT name, COUNT(*) AS cnt FROM products WHERE del_flg = 0 GROUP BY name HAVING COUNT(*) > 1;
-- EXPECTED: zero rows (unchanged from pre-check section 6 — this migration
-- cannot create new duplicates, only split apart previously-merged ones).

SELECT '=== POST-CHECK COMPLETE ===' AS section;
