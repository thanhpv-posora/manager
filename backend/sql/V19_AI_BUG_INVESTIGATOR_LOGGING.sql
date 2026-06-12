-- =========================================
-- V19 AI Bug Investigator + Production Logging
-- Compatible with old MySQL versions
-- =========================================

CREATE TABLE IF NOT EXISTS ai_action_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id VARCHAR(255) NULL,
  user_id BIGINT NULL,
  action_type VARCHAR(120) NOT NULL,
  intent VARCHAR(120) NULL,
  request_text TEXT NULL,
  request_json LONGTEXT NULL,
  response_json LONGTEXT NULL,
  success_flg TINYINT(1) NOT NULL DEFAULT 1,
  error_message TEXT NULL,
  error_stack LONGTEXT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ai_action_logs_session (session_id),
  INDEX idx_ai_action_logs_action (action_type),
  INDEX idx_ai_action_logs_created (created_at)
);

CREATE TABLE IF NOT EXISTS ai_error_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id VARCHAR(255) NULL,
  user_id BIGINT NULL,
  action_type VARCHAR(120) NOT NULL,
  intent VARCHAR(120) NULL,
  request_text TEXT NULL,
  request_json LONGTEXT NULL,
  error_message TEXT NULL,
  error_stack LONGTEXT NULL,
  extra_json LONGTEXT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'NEW',
  resolved_note TEXT NULL,
  resolved_at DATETIME NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ai_error_logs_session (session_id),
  INDEX idx_ai_error_logs_action (action_type),
  INDEX idx_ai_error_logs_status (status),
  INDEX idx_ai_error_logs_created (created_at)
);

-- Optional schema compatibility helpers for AI order save.
-- Run only if your old DB misses these columns.

SET @exists_order_code := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'order_code'
);
SET @sql_order_code := IF(@exists_order_code = 0,
  'ALTER TABLE orders ADD COLUMN order_code VARCHAR(100) NULL',
  'SELECT "orders.order_code already exists"'
);
PREPARE stmt FROM @sql_order_code; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists_paid_amount := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'paid_amount'
);
SET @sql_paid_amount := IF(@exists_paid_amount = 0,
  'ALTER TABLE orders ADD COLUMN paid_amount DECIMAL(15,2) NOT NULL DEFAULT 0',
  'SELECT "orders.paid_amount already exists"'
);
PREPARE stmt FROM @sql_paid_amount; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists_debt_amount := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'debt_amount'
);
SET @sql_debt_amount := IF(@exists_debt_amount = 0,
  'ALTER TABLE orders ADD COLUMN debt_amount DECIMAL(15,2) NOT NULL DEFAULT 0',
  'SELECT "orders.debt_amount already exists"'
);
PREPARE stmt FROM @sql_debt_amount; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists_note := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'note'
);
SET @sql_note := IF(@exists_note = 0,
  'ALTER TABLE orders ADD COLUMN note TEXT NULL',
  'SELECT "orders.note already exists"'
);
PREPARE stmt FROM @sql_note; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT 'V19_AI_BUG_INVESTIGATOR_LOGGING DONE' AS result;
