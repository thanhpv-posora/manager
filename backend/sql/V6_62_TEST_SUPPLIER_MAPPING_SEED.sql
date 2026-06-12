-- Seed test để AI Supplier Ordering v2 tạo được purchase_orders thật.
-- Chạy sau seed sản phẩm TEST_BON_GAN_HET / TEST_BON_CON_NHIEU.

INSERT INTO suppliers (supplier_code, name, phone, address, note, is_active, del_flg)
VALUES ('TEST_NCC_BO', 'Nhà cung cấp bò test', '0900000001', 'Test', 'NCC test cho AI Supplier Ordering v2', 1, 0)
ON DUPLICATE KEY UPDATE name = VALUES(name), is_active = 1, del_flg = 0;

INSERT INTO product_supplier_links
(product_id, supplier_id, purchase_price, min_order_qty, order_multiple_qty, lead_time_days, is_default, is_active, note)
SELECT p.id, s.id, p.default_purchase_price, 5, 1, 1, 1, 1, 'Mapping test AI nhập hàng'
FROM products p
JOIN suppliers s ON s.supplier_code = 'TEST_NCC_BO'
WHERE p.product_code IN ('TEST_BON_GAN_HET', 'TEST_BON_CON_NHIEU', 'TEST_GAU_HET_HANG')
ON DUPLICATE KEY UPDATE
purchase_price = VALUES(purchase_price),
min_order_qty = VALUES(min_order_qty),
order_multiple_qty = VALUES(order_multiple_qty),
lead_time_days = VALUES(lead_time_days),
is_default = 1,
is_active = 1;

UPDATE products p
JOIN suppliers s ON s.supplier_code = 'TEST_NCC_BO'
SET p.default_supplier_id = s.id
WHERE p.product_code IN ('TEST_BON_GAN_HET', 'TEST_BON_CON_NHIEU', 'TEST_GAU_HET_HANG');
