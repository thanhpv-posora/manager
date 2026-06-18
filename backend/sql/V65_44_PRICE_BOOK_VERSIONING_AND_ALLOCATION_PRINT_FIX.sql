-- V65.44 - Production-safe price book versioning + payment allocation print repair
-- Rule: append-only/versioning, never rewrite historical bills.

CREATE TABLE IF NOT EXISTS customer_price_books (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  customer_id BIGINT NOT NULL,
  book_name VARCHAR(255) NULL,
  effective_from DATE NOT NULL,
  effective_to DATE NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
  note VARCHAR(255) NULL,
  created_by BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_cpb_customer_effective (customer_id,effective_from,effective_to,status),
  KEY idx_cpb_customer_status (customer_id,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS customer_price_book_items (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  price_book_id BIGINT NOT NULL,
  customer_id BIGINT NOT NULL,
  product_id BIGINT NOT NULL,
  sale_price DECIMAL(15,2) NOT NULL DEFAULT 0,
  note VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_cpbi_book_product (price_book_id,product_id),
  KEY idx_cpbi_customer_product (customer_id,product_id),
  KEY idx_cpbi_product (product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- MySQL 8 production-safe column guards for older V65 schemas.
SET @db := DATABASE();
SET @sql := IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='payment_allocations' AND COLUMN_NAME='cash_amount')=0,
  'ALTER TABLE payment_allocations ADD COLUMN cash_amount DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER amount',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql := IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='payment_allocations' AND COLUMN_NAME='bank_amount')=0,
  'ALTER TABLE payment_allocations ADD COLUMN bank_amount DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER cash_amount',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;



-- V65.44.1: price book source marker must be allowed in historical order_items.
-- Fixes: WARN_DATA_TRUNCATED / Data truncated for column 'price_type' when inserting PRICE_BOOK.
SET @sql := IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='order_items' AND COLUMN_NAME='price_type')=1,
  'ALTER TABLE order_items MODIFY COLUMN price_type ENUM(''COMMON_PRICE'',''PRIVATE_PRICE'',''MANUAL_PRICE'',''PRICE_BOOK'') NOT NULL DEFAULT ''COMMON_PRICE''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Optional traceability: store which price book was used for a new bill item.
SET @sql := IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='order_items' AND COLUMN_NAME='price_book_id')=0,
  'ALTER TABLE order_items ADD COLUMN price_book_id BIGINT NULL AFTER price_type',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Optional backfill: convert current active private prices into the first price book per customer.
-- This does not modify old price rows and does not touch order_items.
INSERT INTO customer_price_books(customer_id, book_name, effective_from, effective_to, status, note, created_at)
SELECT x.customer_id, 'AUTO_BACKFILL_CURRENT_PRIVATE_PRICE', CURDATE(), NULL, 'ACTIVE', 'Backfilled from customer_product_prices V65.44', NOW()
FROM (SELECT DISTINCT customer_id FROM customer_product_prices WHERE is_active=1) x
WHERE NOT EXISTS (
  SELECT 1 FROM customer_price_books b
  WHERE b.customer_id=x.customer_id AND b.status='ACTIVE' AND b.effective_to IS NULL
);

INSERT INTO customer_price_book_items(price_book_id, customer_id, product_id, sale_price, note, created_at)
SELECT b.id, cpp.customer_id, cpp.product_id, cpp.sale_price, 'Backfilled from customer_product_prices V65.44', NOW()
FROM customer_product_prices cpp
JOIN customer_price_books b ON b.customer_id=cpp.customer_id AND b.status='ACTIVE' AND b.effective_to IS NULL
WHERE cpp.is_active=1
ON DUPLICATE KEY UPDATE sale_price=VALUES(sale_price);
