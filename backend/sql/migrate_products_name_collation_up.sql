-- ============================================================================
-- MIGRATION UP — products.name: utf8mb4_0900_ai_ci -> utf8mb4_0900_as_ci
-- ============================================================================
-- !!! DO NOT RUN WITHOUT FIRST RUNNING AND REVIEWING
-- !!! migrate_products_name_collation_precheck.sql — IN PARTICULAR SECTION 6
-- !!! (duplicate-name safety check) MUST SHOW ZERO ROWS.
--
-- Scope: this touches ONLY products.name's collation. No other column, no
-- other table, no index, no default value, no NULL/NOT NULL attribute is
-- changed. Every other attribute below is copied VERBATIM from the live
-- `SHOW CREATE TABLE products` captured during this task's audit:
--   `name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_ci NOT NULL
-- (the table's own DEFAULT CHARSET/COLLATE stays utf8mb4/utf8mb4_0900_ai_ci —
-- unrelated table-level default, not this migration's concern; only the
-- COLUMN-level override on `name` is set explicitly here, same as it already
-- is in the environment this was verified against).
--
-- This statement is idempotent: if products.name is already
-- utf8mb4_0900_as_ci (confirmed to be the case in the dev environment this
-- was audited against, 2026-07-28), running this is a harmless no-op —
-- MySQL re-applies the identical column definition.
--
-- Engine: MySQL 8.0.35 (utf8mb4_0900_as_ci requires MySQL 8.0.1+, confirmed
-- supported by the pre-check's VERSION() query).
-- ============================================================================

ALTER TABLE products
  MODIFY COLUMN name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_ci NOT NULL;

-- Immediate in-transaction-less confirmation (DDL auto-commits in MySQL —
-- there is no transaction to roll back for an ALTER TABLE; use
-- migrate_products_name_collation_down.sql to revert if needed).
SELECT COLUMN_NAME, COLLATION_NAME
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'name';
-- EXPECTED: COLLATION_NAME = 'utf8mb4_0900_as_ci'.

SELECT id, name FROM products WHERE name IN ('Nạm','Nầm') ORDER BY id;
SELECT COUNT(*) AS rows_matching_literal_Nam FROM products WHERE name = 'Nạm';
SELECT COUNT(*) AS rows_matching_literal_Nam2 FROM products WHERE name = 'Nầm';
-- EXPECTED: each COUNT(*) above returns 1 (only its own row) — confirms the
-- accent-insensitive comparison bug is closed at the database layer.

-- Run migrate_products_name_collation_postcheck.sql next for the full
-- verification pass, then MYSQL_INDEX/table-wide business regression checks
-- per the deliverable's test plan.
