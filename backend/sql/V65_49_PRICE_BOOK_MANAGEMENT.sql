-- V65.49 - Price Book Management
-- Adds management workflow for customer_price_books.
-- No destructive migration is required. Existing V65.44 tables are reused.

SET @db := DATABASE();
SET @sql := IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='customer_price_books' AND COLUMN_NAME='updated_at')=0,
  'ALTER TABLE customer_price_books ADD COLUMN updated_at DATETIME NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP AFTER created_at',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Make sure order_items can safely detach a deleted price book from unpaid bills.
SET @sql := IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='order_items' AND COLUMN_NAME='price_book_id')=0,
  'ALTER TABLE order_items ADD COLUMN price_book_id BIGINT NULL AFTER price_type',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
