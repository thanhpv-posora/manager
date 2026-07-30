-- ============================================================================
-- MIGRATION DOWN (ROLLBACK) — products.name: utf8mb4_0900_as_ci -> utf8mb4_0900_ai_ci
-- ============================================================================
-- !!! WARNING: This REINTRODUCES the reported bug ('Nầm' = 'Nạm' -> 1). Only
-- !!! run this to roll back an unexpected failure caused BY the up-migration
-- !!! itself (e.g. an application incompatibility discovered after
-- !!! deployment) — never as a routine operation, and never without CTO
-- !!! sign-off, since it deliberately restores accent-insensitive product
-- !!! name comparison.
--
-- Scope: identical to the up migration — ONLY products.name's collation is
-- touched, no other column/table/index/attribute.
-- ============================================================================

ALTER TABLE products
  MODIFY COLUMN name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL;

SELECT COLUMN_NAME, COLLATION_NAME
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'name';
-- EXPECTED after rollback: COLLATION_NAME = 'utf8mb4_0900_ai_ci'.

SELECT 'ROLLBACK APPLIED. products.name is now accent-insensitive again — the Excel-import fix at the application layer (orderImportParser.js exact-match matching) is the ONLY remaining protection against the Nạm/Nầm mapping bug until this migration is re-applied.' AS warning;
