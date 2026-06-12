-- =========================================
-- V6_64 AI Voice POS Safe Customer Payment Rule
-- Compatible with old MySQL versions
-- =========================================

-- Optional customer_type column for clearer walk-in / regular customer policy.
-- Existing systems can also work by customer name such as 'Khách vãng lai'.

SET @exists_customer_type := (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'customers'
      AND COLUMN_NAME = 'customer_type'
);

SET @sql_customer_type := IF(
    @exists_customer_type = 0,
    'ALTER TABLE customers ADD COLUMN customer_type VARCHAR(30) NULL DEFAULT NULL',
    'SELECT "customers.customer_type already exists"'
);

PREPARE stmt FROM @sql_customer_type;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Suggested values:
-- REGULAR = khách hàng thường, tạo bill công nợ, thu tiền ở màn Thu tiền.
-- WALK_IN = khách vãng lai, thu tiền ngay tại POS.

UPDATE customers
SET customer_type = 'WALK_IN'
WHERE customer_type IS NULL
  AND (
    LOWER(name) LIKE '%vãng lai%'
    OR LOWER(name) LIKE '%vang lai%'
    OR LOWER(name) LIKE '%khách lẻ%'
    OR LOWER(name) LIKE '%khach le%'
  );

SELECT 'V6_64_AI_VOICE_POS_SAFE_CUSTOMER_PAYMENT_RULE DONE' AS result;
