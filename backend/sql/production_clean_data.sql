-- MeatBiz V6.31 Production Clean Data Script
-- Chạy khi muốn đưa hệ thống vào sử dụng thật.
-- CẨN THẬN: script này xóa dữ liệu giao dịch test.

USE meat_business_db;

SET FOREIGN_KEY_CHECKS=0;

TRUNCATE TABLE order_items;
TRUNCATE TABLE orders;
TRUNCATE TABLE payments;
TRUNCATE TABLE debt_transactions;
TRUNCATE TABLE debt_installment_payments;
TRUNCATE TABLE debt_installment_plans;
TRUNCATE TABLE purchase_lot_items;
TRUNCATE TABLE purchase_lots;
TRUNCATE TABLE supplier_payments;
TRUNCATE TABLE ai_learning_logs;

-- Giữ master data: customers, products, suppliers, users, permissions, settings.
-- Nếu muốn xóa video test:
-- TRUNCATE TABLE sponsor_ad_campaigns;

SET FOREIGN_KEY_CHECKS=1;
