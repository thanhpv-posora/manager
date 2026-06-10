-- MeatBiz V6.51.2 - payment calendar + installment statistics fix
-- Run this after backup. Some ALTER statements may fail if the column/index already exists; ignore duplicate-column/index errors if your DB already has them.

-- Customer default billing calendar: POS uses this when selecting customer.
ALTER TABLE customers
  ADD COLUMN billing_calendar_type ENUM('SOLAR','LUNAR') NOT NULL DEFAULT 'SOLAR';

-- Mixed payment support: cash + bank transfer in one receipt.
ALTER TABLE payments
  MODIFY payment_method ENUM('CASH','BANK_TRANSFER','MIXED','OTHER') NOT NULL DEFAULT 'CASH';

-- Daily effective installment config by customer and solar/lunar period.
ALTER TABLE debt_monthly_installments
  ADD COLUMN calendar_type ENUM('SOLAR','LUNAR') NOT NULL DEFAULT 'SOLAR';

ALTER TABLE debt_monthly_installments
  ADD COLUMN installment_day INT NOT NULL DEFAULT 1;

ALTER TABLE debt_monthly_installments
  ADD COLUMN config_date DATE NULL;

ALTER TABLE debt_monthly_installments
  ADD COLUMN lunar_date_text VARCHAR(30) NULL;

ALTER TABLE debt_monthly_installments
  ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- If old unique key exists only on customer/month/year, replace it so each apply day can create a separate record.
ALTER TABLE debt_monthly_installments DROP INDEX uq_customer_month_year;
ALTER TABLE debt_monthly_installments
  ADD UNIQUE KEY uq_customer_period_day_calendar (customer_id, installment_day, installment_month, installment_year, calendar_type);

CREATE INDEX idx_debt_monthly_effective_lookup
  ON debt_monthly_installments(customer_id, calendar_type, installment_year, installment_month, installment_day, status);

-- Orders keep bill calendar so payment/print/report uses the same solar/lunar choice.
ALTER TABLE orders
  ADD COLUMN calendar_type ENUM('SOLAR','LUNAR') NOT NULL DEFAULT 'SOLAR';

ALTER TABLE orders
  ADD COLUMN lunar_date_text VARCHAR(30) NULL;

-- Payments keep the installment config ID used by POS, so used config cannot be deleted.
ALTER TABLE payments
  ADD COLUMN monthly_installment_id BIGINT NULL;

ALTER TABLE payments
  ADD COLUMN current_bill_amount DECIMAL(15,2) NOT NULL DEFAULT 0;

ALTER TABLE payments
  ADD COLUMN installment_amount DECIMAL(15,2) NOT NULL DEFAULT 0;

ALTER TABLE payments
  ADD COLUMN cash_amount DECIMAL(15,2) NOT NULL DEFAULT 0;

ALTER TABLE payments
  ADD COLUMN bank_amount DECIMAL(15,2) NOT NULL DEFAULT 0;
