-- MeatBiz V6.51.11 FINAL
-- Đồng bộ toàn bộ flow Âm/Dương + góp nợ/ngày:
-- Customer -> POS -> Orders -> Payments -> Print -> Stats.
-- Chạy sau khi backup DB. Script dùng MySQL 8+.

-- 1) Khách hàng chọn mặc định tính bill theo dương lịch/âm lịch.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS billing_calendar_type ENUM('SOLAR','LUNAR') NOT NULL DEFAULT 'SOLAR';

-- 2) Payment hỗ trợ tiền mặt + chuyển khoản.
ALTER TABLE payments
  MODIFY payment_method ENUM('CASH','BANK_TRANSFER','MIXED','OTHER') NOT NULL DEFAULT 'CASH';

-- 3) Orders lưu rõ bill hàng hôm nay và góp nợ/ngày.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS calendar_type ENUM('SOLAR','LUNAR') NOT NULL DEFAULT 'SOLAR';
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS lunar_date_text VARCHAR(30) NULL;
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS current_bill_amount DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS installment_amount DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS monthly_installment_id BIGINT NULL;

-- 4) Payments lưu số tiền góp nợ/ngày đã thu thật và lưu loại lịch của phiếu thu.
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS cash_amount DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS bank_amount DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS current_bill_amount DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS installment_amount DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS monthly_installment_id BIGINT NULL;
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS payment_calendar_type ENUM('SOLAR','LUNAR') NOT NULL DEFAULT 'SOLAR';
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS payment_lunar_date_text VARCHAR(30) NULL;

-- 5) Cấu hình góp nợ/ngày theo ngày áp dụng trong tháng Âm/Dương.
ALTER TABLE debt_monthly_installments
  ADD COLUMN IF NOT EXISTS installment_day INT NOT NULL DEFAULT 1;
ALTER TABLE debt_monthly_installments
  ADD COLUMN IF NOT EXISTS calendar_type ENUM('SOLAR','LUNAR') NOT NULL DEFAULT 'SOLAR';
ALTER TABLE debt_monthly_installments
  ADD COLUMN IF NOT EXISTS config_date DATE NULL;
ALTER TABLE debt_monthly_installments
  ADD COLUMN IF NOT EXISTS lunar_date_text VARCHAR(50) NULL;
ALTER TABLE debt_monthly_installments
  ADD COLUMN IF NOT EXISTS updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- 6) Đổi unique cũ để cho phép cùng khách có nhiều cấu hình trong cùng tháng theo ngày áp dụng khác nhau.
DROP PROCEDURE IF EXISTS mb_v651_drop_index_if_exists;
DELIMITER $$
CREATE PROCEDURE mb_v651_drop_index_if_exists(IN p_table VARCHAR(64), IN p_index VARCHAR(64))
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = p_table AND index_name = p_index
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` DROP INDEX `', p_index, '`');
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$
DELIMITER ;

CALL mb_v651_drop_index_if_exists('debt_monthly_installments','uq_customer_month_year');
CALL mb_v651_drop_index_if_exists('debt_monthly_installments','uq_customer_period_day');
CALL mb_v651_drop_index_if_exists('debt_monthly_installments','uq_customer_period_day_calendar');
DROP PROCEDURE IF EXISTS mb_v651_drop_index_if_exists;

ALTER TABLE debt_monthly_installments
  ADD UNIQUE KEY uq_customer_period_day_calendar (
    customer_id,
    installment_day,
    installment_month,
    installment_year,
    calendar_type
  );

DROP PROCEDURE IF EXISTS mb_v651_drop_index_if_exists;
DELIMITER $$
CREATE PROCEDURE mb_v651_drop_index_if_exists(IN p_table VARCHAR(64), IN p_index VARCHAR(64))
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = p_table AND index_name = p_index
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` DROP INDEX `', p_index, '`');
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$
DELIMITER ;
CALL mb_v651_drop_index_if_exists('debt_monthly_installments','idx_debt_monthly_effective_lookup');
DROP PROCEDURE IF EXISTS mb_v651_drop_index_if_exists;

CREATE INDEX idx_debt_monthly_effective_lookup
  ON debt_monthly_installments(customer_id, calendar_type, installment_year, installment_month, installment_day, status);

-- 7) Repair dữ liệu orders cũ:
-- total_amount phải là tổng cần thanh toán = bill hôm nay + góp nợ/ngày.
UPDATE orders
SET current_bill_amount = GREATEST(0, COALESCE(total_amount,0) - COALESCE(installment_amount,0))
WHERE COALESCE(installment_amount,0) > 0
  AND (COALESCE(current_bill_amount,0)=0 OR COALESCE(current_bill_amount,0)>=COALESCE(total_amount,0));

UPDATE orders
SET total_amount = COALESCE(current_bill_amount,0) + COALESCE(installment_amount,0),
    debt_amount = GREATEST(0, (COALESCE(current_bill_amount,0)+COALESCE(installment_amount,0))-COALESCE(paid_amount,0)),
    payment_status = CASE
      WHEN GREATEST(0, (COALESCE(current_bill_amount,0)+COALESCE(installment_amount,0))-COALESCE(paid_amount,0)) <= 0 THEN 'PAID'
      WHEN COALESCE(paid_amount,0) > 0 THEN 'PARTIAL'
      ELSE 'UNPAID'
    END
WHERE COALESCE(installment_amount,0) > 0
  AND COALESCE(current_bill_amount,0) > 0;

-- 8) Repair payments cũ: tính lại số tiền góp nợ/ngày đã thu thật.
-- Rule: tiền góp đã thu = phần payment vượt qua bill hàng hôm nay, capped bởi order.installment_amount.
UPDATE payments p
JOIN orders o ON o.id = p.order_id
SET p.installment_amount = LEAST(
      COALESCE(o.installment_amount,0),
      GREATEST(
        COALESCE(p.amount,0) - COALESCE(
          NULLIF(p.current_bill_amount,0),
          NULLIF(o.current_bill_amount,0),
          GREATEST(COALESCE(o.total_amount,0)-COALESCE(o.installment_amount,0),0),
          0
        ),
        0
      )
    ),
    p.monthly_installment_id = COALESCE(p.monthly_installment_id, o.monthly_installment_id),
    p.payment_calendar_type = COALESCE(NULLIF(p.payment_calendar_type,''), o.calendar_type, 'SOLAR'),
    p.payment_lunar_date_text = COALESCE(p.payment_lunar_date_text, o.lunar_date_text)
WHERE COALESCE(o.installment_amount,0) > 0
  AND COALESCE(p.amount,0) > COALESCE(
    NULLIF(p.current_bill_amount,0),
    NULLIF(o.current_bill_amount,0),
    GREATEST(COALESCE(o.total_amount,0)-COALESCE(o.installment_amount,0),0),
    0
  );

-- 9) Verify nhanh.
SELECT id, order_code, current_bill_amount, installment_amount, total_amount, paid_amount, debt_amount, payment_status, calendar_type, lunar_date_text
FROM orders
WHERE COALESCE(installment_amount,0)>0
ORDER BY id DESC
LIMIT 20;

SELECT p.id, p.payment_code, p.customer_id, p.order_id, p.payment_date, p.payment_calendar_type, p.payment_lunar_date_text,
       p.amount, p.current_bill_amount, p.installment_amount, p.monthly_installment_id
FROM payments p
WHERE COALESCE(p.installment_amount,0)>0
ORDER BY p.id DESC
LIMIT 20;
