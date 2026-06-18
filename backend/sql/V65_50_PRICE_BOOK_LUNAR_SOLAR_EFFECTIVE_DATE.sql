-- V65.50 Price Book hiệu lực theo lịch của khách hàng
-- Rule: khách âm lịch -> bảng giá âm lịch; khách dương lịch -> bảng giá dương lịch.
-- Không cần effective_to để tính giá. POS lấy bảng giá có ngày bắt đầu gần nhất <= ngày xuất hàng.

ALTER TABLE customer_price_books
  ADD COLUMN effective_calendar_type ENUM('SOLAR','LUNAR') NOT NULL DEFAULT 'SOLAR' AFTER effective_to;

ALTER TABLE customer_price_books
  ADD COLUMN effective_lunar_date_text VARCHAR(30) NULL AFTER effective_calendar_type;

ALTER TABLE customer_price_books
  ADD COLUMN effective_lunar_sort INT NULL AFTER effective_lunar_date_text;

CREATE INDEX idx_price_book_lookup_solar
  ON customer_price_books(customer_id, effective_calendar_type, status, effective_from, id);

CREATE INDEX idx_price_book_lookup_lunar
  ON customer_price_books(customer_id, effective_calendar_type, status, effective_lunar_sort, id);

-- Backfill bảng giá cũ: mặc định SOLAR, giữ effective_from cũ.
UPDATE customer_price_books
SET effective_calendar_type='SOLAR'
WHERE effective_calendar_type IS NULL OR effective_calendar_type='';
