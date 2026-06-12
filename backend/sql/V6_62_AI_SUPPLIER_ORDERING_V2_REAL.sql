-- V6.62 AI Supplier Ordering v2 REAL
-- AI tạo nháp nhập hàng từ DB thật, người dùng xác nhận mới ghi purchase_orders.

CREATE TABLE IF NOT EXISTS ai_chat_sessions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id VARCHAR(100) NOT NULL,
  customer_id BIGINT NULL,
  draft_json LONGTEXT NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'DRAFT',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_ai_chat_session_status(session_id,status,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS product_supplier_links (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT NOT NULL,
  supplier_id BIGINT NOT NULL,
  purchase_price DECIMAL(15,2) NOT NULL DEFAULT 0,
  min_order_qty DECIMAL(15,3) NOT NULL DEFAULT 0,
  order_multiple_qty DECIMAL(15,3) NOT NULL DEFAULT 0,
  lead_time_days INT NOT NULL DEFAULT 0,
  is_default TINYINT(1) NOT NULL DEFAULT 1,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  note TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_product_supplier(product_id,supplier_id),
  INDEX idx_product_supplier_default(product_id,is_default,is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'default_supplier_id') = 0,
  'ALTER TABLE products ADD COLUMN default_supplier_id BIGINT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS purchase_orders (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_code VARCHAR(50) NOT NULL UNIQUE,
  supplier_id BIGINT NOT NULL,
  order_date DATE NOT NULL,
  expected_date DATE NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'DRAFT',
  source VARCHAR(50) NOT NULL DEFAULT 'MANUAL',
  total_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  note TEXT NULL,
  created_by BIGINT NULL,
  del_flg TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_purchase_orders_supplier_date(supplier_id,order_date,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  purchase_order_id BIGINT NOT NULL,
  product_id BIGINT NOT NULL,
  product_name VARCHAR(255) NOT NULL,
  unit VARCHAR(50) NOT NULL DEFAULT 'kg',
  quantity DECIMAL(15,3) NOT NULL DEFAULT 0,
  purchase_price DECIMAL(15,2) NOT NULL DEFAULT 0,
  total_price DECIMAL(15,2) NOT NULL DEFAULT 0,
  received_quantity DECIMAL(15,3) NOT NULL DEFAULT 0,
  note TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_purchase_order_items_order(purchase_order_id),
  INDEX idx_purchase_order_items_product(product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
