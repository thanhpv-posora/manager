ALTER TABLE products
MODIFY inventory_mode ENUM(
  'NON_STOCK',
  'TRACK_STOCK',
  'CARCASS_PART'
) DEFAULT 'NON_STOCK';

-- NON_STOCK: không kiểm tồn / không trừ kho
-- TRACK_STOCK: kiểm tồn thật / trừ kho thật
-- CARCASS_PART: không chặn bán nhưng ghi stock_transactions OUT để phân tích carcass/yield
