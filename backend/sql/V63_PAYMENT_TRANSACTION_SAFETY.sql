-- V63 Payment Transaction Safety
-- Adds idempotency and payment allocation tracking for safe Thu tien workflow.

CREATE TABLE IF NOT EXISTS payment_transaction_requests (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  idempotency_key VARCHAR(100) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'PROCESSING',
  request_json LONGTEXT NULL,
  response_json LONGTEXT NULL,
  error_message TEXT NULL,
  created_by BIGINT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_payment_tx_key (idempotency_key),
  KEY idx_payment_tx_status (status),
  KEY idx_payment_tx_created (created_at)
);

CREATE TABLE IF NOT EXISTS payment_allocations (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  payment_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  customer_id BIGINT NOT NULL,
  amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  allocation_type VARCHAR(30) NOT NULL DEFAULT 'CURRENT_BILL',
  note TEXT NULL,
  created_by BIGINT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_payment_alloc_payment (payment_id),
  KEY idx_payment_alloc_order (order_id),
  KEY idx_payment_alloc_customer (customer_id),
  KEY idx_payment_alloc_type (allocation_type)
);
