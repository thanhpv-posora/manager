-- MeatBiz V6.51.5 - Critical fix for daily installment debt disappearing
-- Problem fixed: when a POS bill has today's bill + góp nợ/ngày, paying only today's bill must leave the installment amount as bill debt.
-- Run after backup. Ignore duplicate-column errors if these columns already exist.

ALTER TABLE orders
  ADD COLUMN current_bill_amount DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER debt_amount;

ALTER TABLE orders
  ADD COLUMN installment_amount DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER current_bill_amount;

ALTER TABLE orders
  ADD COLUMN monthly_installment_id BIGINT NULL AFTER installment_amount;

-- Ensure mixed payments remain supported.
ALTER TABLE payments
  MODIFY payment_method ENUM('CASH','BANK_TRANSFER','MIXED','OTHER') NOT NULL DEFAULT 'CASH';

-- Optional backfill for older orders where current_bill_amount is missing.
UPDATE orders
SET current_bill_amount = total_amount
WHERE COALESCE(current_bill_amount,0) = 0;
