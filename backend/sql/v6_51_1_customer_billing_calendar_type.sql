-- MeatBiz V6.51.1 - Customer default calendar type for POS bill
-- Chạy file này nếu DB chưa có cột billing_calendar_type.

ALTER TABLE customers
ADD COLUMN billing_calendar_type ENUM('SOLAR','LUNAR') NOT NULL DEFAULT 'SOLAR';

-- Nếu muốn set mặc định khách cũ tính bill theo dương lịch:
UPDATE customers
SET billing_calendar_type='SOLAR'
WHERE billing_calendar_type IS NULL;
