-- V63 test cleanup script
-- WARNING: Use only on test/dev database.
-- This cleans transactional data so you can test payment flow from a clean state.

SET FOREIGN_KEY_CHECKS = 0;

TRUNCATE TABLE payment_allocations;
TRUNCATE TABLE payment_transaction_requests;
TRUNCATE TABLE payments;
TRUNCATE TABLE debt_transactions;
TRUNCATE TABLE order_items;
TRUNCATE TABLE orders;
TRUNCATE TABLE ai_action_logs;
TRUNCATE TABLE ai_error_logs;
TRUNCATE TABLE ai_chat_sessions;

-- Optional supplier/lot test data cleanup. Uncomment if you also want to reset lot module.
-- TRUNCATE TABLE supplier_payments;
-- TRUNCATE TABLE purchase_lot_items;
-- TRUNCATE TABLE purchase_lots;
-- TRUNCATE TABLE stock_transactions;

SET FOREIGN_KEY_CHECKS = 1;
