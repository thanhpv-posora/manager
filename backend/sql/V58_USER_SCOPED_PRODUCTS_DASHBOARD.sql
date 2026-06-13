-- V58_USER_SCOPED_PRODUCTS_DASHBOARD
-- Scope products by creator and protect customer dashboard data.

SET @has_created_by := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='products' AND COLUMN_NAME='created_by'
);
SET @sql_created_by := IF(@has_created_by=0,
  'ALTER TABLE products ADD COLUMN created_by BIGINT NULL AFTER allow_negative_stock',
  'SELECT "products.created_by already exists" AS info'
);
PREPARE stmt FROM @sql_created_by; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_idx := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='products' AND INDEX_NAME='idx_products_created_by'
);
SET @sql_idx := IF(@has_idx=0,
  'ALTER TABLE products ADD INDEX idx_products_created_by(created_by)',
  'SELECT "idx_products_created_by already exists" AS info'
);
PREPARE stmt FROM @sql_idx; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Existing products remain ADMIN/global until reassigned manually.
-- New products are written with created_by from the logged-in user.
SELECT 'V58_USER_SCOPED_PRODUCTS_DASHBOARD DONE' AS result;
