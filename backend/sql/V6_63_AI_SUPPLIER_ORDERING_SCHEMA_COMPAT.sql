-- V6.63 - AI Supplier Ordering schema compatibility
-- Dùng cho DB đã có purchase_orders cũ nhưng thiếu order_code/source/del_flg.

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS order_code VARCHAR(50) NULL;

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS source VARCHAR(50) NOT NULL DEFAULT 'MANUAL';

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS del_flg TINYINT(1) NOT NULL DEFAULT 0;

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS note TEXT NULL;

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS created_by BIGINT NULL;

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS expected_date DATE NULL;

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS total_amount DECIMAL(15,2) NOT NULL DEFAULT 0;

CREATE INDEX idx_purchase_orders_order_code ON purchase_orders(order_code);
