-- V6.61 AI Inventory Prediction + Supplier Ordering
-- Chuẩn hóa mode cũ STOCK sang rule production TRACK_STOCK.
-- Chạy trước khi test dự báo tồn kho nếu DB đang dùng bản cũ.

-- Step 1: cho phép cả mode cũ và mode mới để update an toàn.
ALTER TABLE products
MODIFY inventory_mode ENUM(
  'STOCK',
  'NON_STOCK',
  'TRACK_STOCK',
  'CARCASS_PART'
) DEFAULT 'NON_STOCK';

-- Step 2: convert mode cũ.
UPDATE products
SET inventory_mode = 'TRACK_STOCK'
WHERE inventory_mode = 'STOCK';

-- Step 3: khóa lại đúng business rule production.
ALTER TABLE products
MODIFY inventory_mode ENUM(
  'NON_STOCK',
  'TRACK_STOCK',
  'CARCASS_PART'
) DEFAULT 'NON_STOCK';

-- Gợi ý index để dự báo nhanh hơn trên dữ liệu bill lớn.
CREATE INDEX idx_orders_date_status ON orders(order_date, status);
CREATE INDEX idx_order_items_product_order ON order_items(product_id, order_id);
