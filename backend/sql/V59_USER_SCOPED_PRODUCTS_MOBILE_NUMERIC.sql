-- V59 - User scoped products + dashboard scope + mobile numeric support
-- Compatible with older MySQL: no ADD COLUMN IF NOT EXISTS used.

SET @has_product_owner_user_id := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='products' AND COLUMN_NAME='product_owner_user_id'
);
SET @sql_product_owner_user_id := IF(@has_product_owner_user_id=0,
  'ALTER TABLE products ADD COLUMN product_owner_user_id BIGINT NULL',
  'SELECT "products.product_owner_user_id already exists"'
);
PREPARE stmt FROM @sql_product_owner_user_id; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_owner_prefix := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='products' AND COLUMN_NAME='owner_prefix'
);
SET @sql_owner_prefix := IF(@has_owner_prefix=0,
  'ALTER TABLE products ADD COLUMN owner_prefix VARCHAR(50) NULL',
  'SELECT "products.owner_prefix already exists"'
);
PREPARE stmt FROM @sql_owner_prefix; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_created_by := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='products' AND COLUMN_NAME='created_by'
);
SET @sql_created_by := IF(@has_created_by=0,
  'ALTER TABLE products ADD COLUMN created_by BIGINT NULL',
  'SELECT "products.created_by already exists"'
);
PREPARE stmt FROM @sql_created_by; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_idx_products_owner_user := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='products' AND INDEX_NAME='idx_products_owner_user'
);
SET @sql_idx_products_owner_user := IF(@has_idx_products_owner_user=0,
  'ALTER TABLE products ADD INDEX idx_products_owner_user (product_owner_user_id)',
  'SELECT "idx_products_owner_user already exists"'
);
PREPARE stmt FROM @sql_idx_products_owner_user; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_idx_products_owner_code := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='products' AND INDEX_NAME='idx_products_owner_code'
);
SET @sql_idx_products_owner_code := IF(@has_idx_products_owner_code=0,
  'ALTER TABLE products ADD INDEX idx_products_owner_code (product_owner_user_id, product_code)',
  'SELECT "idx_products_owner_code already exists"'
);
PREPARE stmt FROM @sql_idx_products_owner_code; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Existing products are left as admin/common legacy data. New products will get product_owner_user_id automatically.
-- Non-admin users will only see products they create after deploying V59.

SELECT 'V59_USER_SCOPED_PRODUCTS_MOBILE_NUMERIC DONE' AS result;
