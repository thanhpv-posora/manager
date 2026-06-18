-- V65.42 - Payment allocation/report schema
-- Run this before testing Thu tiền allocation/report.

CREATE TABLE IF NOT EXISTS payment_allocations (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  payment_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  customer_id BIGINT NOT NULL DEFAULT 0,
  amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  cash_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  bank_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  allocation_type VARCHAR(50) DEFAULT 'CURRENT_BILL',
  note VARCHAR(255) NULL,
  created_by BIGINT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_payment_allocations_payment_id (payment_id),
  INDEX idx_payment_allocations_order_id (order_id),
  INDEX idx_payment_allocations_customer_id (customer_id)
);

-- If you already created payment_allocations manually and it is missing columns,
-- run the ALTER lines you need below. Ignore duplicate-column errors if any.
-- ALTER TABLE payment_allocations ADD COLUMN customer_id BIGINT NOT NULL DEFAULT 0;
-- ALTER TABLE payment_allocations ADD COLUMN amount DECIMAL(15,2) NOT NULL DEFAULT 0;
-- ALTER TABLE payment_allocations ADD COLUMN cash_amount DECIMAL(15,2) NOT NULL DEFAULT 0;
-- ALTER TABLE payment_allocations ADD COLUMN bank_amount DECIMAL(15,2) NOT NULL DEFAULT 0;
-- ALTER TABLE payment_allocations ADD COLUMN allocation_type VARCHAR(50) DEFAULT 'CURRENT_BILL';
-- ALTER TABLE payment_allocations ADD COLUMN note VARCHAR(255) NULL;
-- ALTER TABLE payment_allocations ADD COLUMN created_by BIGINT NULL;
-- ALTER TABLE payment_allocations ADD COLUMN created_at DATETIME DEFAULT CURRENT_TIMESTAMP;
