USE meat_business_db;

-- Fix nhanh cho dữ liệu cũ:
-- Các mã bò/pha lóc chuyển sang không kiểm tồn từng phần.
UPDATE products
SET inventory_mode='CARCASS_PART',
    allow_negative_stock=1
WHERE del_flg=0
  AND (
    product_code LIKE 'BO_%'
    OR name LIKE '%bò%'
    OR name LIKE '%Đùi%'
    OR name LIKE '%đùi%'
    OR name LIKE '%Búp%'
    OR name LIKE '%búp%'
    OR name LIKE '%Nạm%'
    OR name LIKE '%nạm%'
    OR name LIKE '%Sườn%'
    OR name LIKE '%sườn%'
    OR name LIKE '%Thăn%'
    OR name LIKE '%thăn%'
  );
