-- V65.43 Profit/FIFO foundation for MeatBiz production
-- Supports 2 inventory flows:
-- 1) NON_STOCK/NO_STOCK/CARCASS_PART: bò xô/xào trong ngày, không kiểm tồn, profit allocated by NCC import day cost.
-- 2) TRACK_STOCK/STOCK/STOCK_FIFO: kiểm tồn, FIFO cost trace by stock layers.

CREATE TABLE IF NOT EXISTS inventory_fifo_layers (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT NOT NULL,
  lot_id BIGINT NULL,
  lot_item_id BIGINT NULL,
  source_type VARCHAR(50) NOT NULL DEFAULT 'PURCHASE',
  source_id BIGINT NULL,
  source_date DATE NOT NULL,
  qty_in DECIMAL(15,3) NOT NULL DEFAULT 0,
  qty_remaining DECIMAL(15,3) NOT NULL DEFAULT 0,
  unit_cost DECIMAL(15,2) NOT NULL DEFAULT 0,
  total_cost DECIMAL(15,2) NOT NULL DEFAULT 0,
  inventory_mode VARCHAR(50) NOT NULL DEFAULT 'STOCK_FIFO',
  note VARCHAR(255) NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_fifo_product_date(product_id, source_date, id),
  INDEX idx_fifo_lot(lot_id),
  INDEX idx_fifo_remaining(product_id, qty_remaining)
);

CREATE TABLE IF NOT EXISTS order_item_fifo_allocations (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_id BIGINT NOT NULL,
  order_item_id BIGINT NOT NULL,
  product_id BIGINT NOT NULL,
  fifo_layer_id BIGINT NULL,
  lot_id BIGINT NULL,
  lot_item_id BIGINT NULL,
  source_date DATE NULL,
  qty DECIMAL(15,3) NOT NULL DEFAULT 0,
  unit_cost DECIMAL(15,2) NOT NULL DEFAULT 0,
  total_cost DECIMAL(15,2) NOT NULL DEFAULT 0,
  allocation_mode VARCHAR(50) NOT NULL DEFAULT 'FIFO',
  note VARCHAR(255) NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_oifa_order(order_id),
  INDEX idx_oifa_order_item(order_item_id),
  INDEX idx_oifa_product(product_id),
  INDEX idx_oifa_layer(fifo_layer_id)
);

-- Optional columns for product mode normalization.
ALTER TABLE products ADD COLUMN IF NOT EXISTS profit_cost_method VARCHAR(50) NOT NULL DEFAULT 'AUTO';
