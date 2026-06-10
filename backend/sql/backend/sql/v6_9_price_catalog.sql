USE meat_business_db;

CREATE TABLE IF NOT EXISTS customer_product_catalogs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  customer_id BIGINT NOT NULL,
  product_id BIGINT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_default TINYINT(1) NOT NULL DEFAULT 1,
  note TEXT,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  del_flg TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_customer_product_catalog(customer_id,product_id),
  INDEX idx_customer_catalog_customer(customer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS price_change_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  customer_id BIGINT NOT NULL,
  product_id BIGINT NOT NULL,
  old_price DECIMAL(15,2) NULL,
  new_price DECIMAL(15,2) NOT NULL,
  reason TEXT,
  changed_by BIGINT NULL,
  changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_price_change_customer(customer_id, product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
