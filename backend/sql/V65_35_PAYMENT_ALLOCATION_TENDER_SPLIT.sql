-- V65.35 Payment allocation per bill + cash/bank tender split
-- Safe migration: run once. Existing rows default to 0 and print falls back to payment method.
ALTER TABLE payment_allocations
  ADD COLUMN cash_amount DECIMAL(15,2) NOT NULL DEFAULT 0;

ALTER TABLE payment_allocations
  ADD COLUMN bank_amount DECIMAL(15,2) NOT NULL DEFAULT 0;
