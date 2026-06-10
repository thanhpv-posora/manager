ALTER TABLE debt_monthly_installments
  ADD COLUMN installment_day INT NOT NULL DEFAULT 1 AFTER customer_id,
  ADD COLUMN calendar_type VARCHAR(20) NOT NULL DEFAULT 'SOLAR' AFTER installment_year,
  ADD COLUMN config_date DATE NULL AFTER calendar_type,
  ADD COLUMN lunar_date_text VARCHAR(50) NULL AFTER config_date,
  ADD COLUMN updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP AFTER created_at;

ALTER TABLE debt_monthly_installments DROP INDEX uq_customer_month_year;
ALTER TABLE debt_monthly_installments DROP INDEX uq_customer_period_day;
ALTER TABLE debt_monthly_installments
  ADD UNIQUE KEY uq_customer_period_day(customer_id,installment_day,installment_month,installment_year,calendar_type),
  ADD INDEX idx_debt_monthly_lookup(customer_id,installment_month,installment_year,calendar_type,status),
  ADD INDEX idx_debt_monthly_day(customer_id,installment_day,installment_month,installment_year,calendar_type,status);

ALTER TABLE payments ADD COLUMN monthly_installment_id BIGINT NULL AFTER installment_amount;
