-- V65.27 Supplier report mapping date
-- Đảm bảo lô NCC lưu cả lịch tính phiếu và ngày âm, còn purchase_date là ngày dương đã mapping để thống kê/dashboard không lệch kỳ.
ALTER TABLE purchase_lots
  ADD COLUMN calendar_type ENUM('SOLAR','LUNAR') NOT NULL DEFAULT 'SOLAR' AFTER purchase_date,
  ADD COLUMN lunar_date_text VARCHAR(50) NULL AFTER calendar_type;
