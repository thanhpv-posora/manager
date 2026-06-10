-- MeatBiz V6.51 Final Migration
-- 1) Customer default bill calendar type
-- 2) Mixed payment method
-- 3) Effective daily debt installment config

-- Khách hàng chọn mặc định tính bill theo dương lịch hoặc âm lịch
ALTER TABLE customers
ADD COLUMN billing_calendar_type ENUM('SOLAR','LUNAR') NOT NULL DEFAULT 'SOLAR';

-- Thu tiền hỗ trợ TM + CK cùng lúc
ALTER TABLE payments
MODIFY payment_method ENUM('CASH','BANK_TRANSFER','MIXED','OTHER') NOT NULL DEFAULT 'CASH';

-- Cấu hình góp nợ/ngày theo ngày áp dụng, âm/dương
ALTER TABLE debt_monthly_installments
ADD COLUMN calendar_type ENUM('SOLAR','LUNAR') NOT NULL DEFAULT 'SOLAR';

ALTER TABLE debt_monthly_installments
ADD COLUMN apply_date DATE NULL;

ALTER TABLE debt_monthly_installments
ADD COLUMN del_flg TINYINT(1) NOT NULL DEFAULT 0;

-- Lưu ID config góp nợ đã được dùng khi thu tiền / in bill
ALTER TABLE payments
ADD COLUMN monthly_installment_id BIGINT NULL;

-- Index query POS: lấy config gần nhất <= ngày bill
CREATE INDEX idx_debt_monthly_effective_lookup
ON debt_monthly_installments(customer_id, calendar_type, apply_date, status, del_flg);

-- Gợi ý query POS:
-- SELECT *
-- FROM debt_monthly_installments
-- WHERE customer_id = ?
--   AND calendar_type = ?
--   AND apply_date <= ?
--   AND status = 'ACTIVE'
--   AND del_flg = 0
-- ORDER BY apply_date DESC, id DESC
-- LIMIT 1;
