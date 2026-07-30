-- ============================================================================
-- CLEANUP — TRANSACTION DATA ONLY (Stage A, standalone) — OPTIONAL CONVENIENCE
-- ============================================================================
-- !!! DO NOT RUN. NOT EXECUTED. !!!
--
-- This is Stage A of cleanup_all_test_data.sql, extracted as a standalone
-- file for cases where only the transactional-data cleanup is wanted and NO
-- demo Master Data removal is needed this cycle (e.g. a schema still has no
-- demo rows, per CLEANUP_ALL_TEST_DATA_AUDIT.md section 3). Scope and order
-- are byte-identical to Stage A of cleanup_all_test_data.sql and to the
-- previously-audited reset_non_master_data.sql — this file does not
-- introduce any new deletion logic, only a standalone entry point.
--
-- Uses the same verified fail-safe gating mechanism as cleanup_all_test_data.sql
-- (see that file's header for why the mechanism is designed this way).
-- ============================================================================

SET @EXPECTED_SCHEMA    = 'REPLACE_WITH_EXACT_TARGET_SCHEMA_NAME';
SET @BACKUP_CONFIRMED    = 0;
SET @EXECUTION_CONFIRMED = 0;

SET @SCHEMA_OK = (SELECT CASE WHEN DATABASE() = @EXPECTED_SCHEMA THEN 1 ELSE 0 END);
SET @SAFE_TO_DELETE = (SELECT CASE WHEN @SCHEMA_OK = 1 AND @BACKUP_CONFIRMED = 1 AND @EXECUTION_CONFIRMED = 1 THEN 1 ELSE 0 END);
SELECT CONCAT('Target schema: ', DATABASE(), ' | Expected: ', @EXPECTED_SCHEMA, ' | SAFE_TO_DELETE=', @SAFE_TO_DELETE) AS gate_check;

SELECT 'orders' t, COUNT(*) c FROM orders
UNION ALL SELECT 'payments', COUNT(*) FROM payments
UNION ALL SELECT 'stock_transactions', COUNT(*) FROM stock_transactions
UNION ALL SELECT 'purchase_orders', COUNT(*) FROM purchase_orders;

START TRANSACTION;

DELETE FROM debt_installment_payments WHERE @SAFE_TO_DELETE = 1;
DELETE FROM debt_transactions         WHERE @SAFE_TO_DELETE = 1;
DELETE FROM payment_allocations       WHERE @SAFE_TO_DELETE = 1;
DELETE FROM payment_unapplied_credits WHERE @SAFE_TO_DELETE = 1;
DELETE FROM payments                  WHERE @SAFE_TO_DELETE = 1;
DELETE FROM order_items               WHERE @SAFE_TO_DELETE = 1;
DELETE FROM orders                    WHERE @SAFE_TO_DELETE = 1;
DELETE FROM debt_installment_plans    WHERE @SAFE_TO_DELETE = 1;
DELETE FROM debt_monthly_installments WHERE @SAFE_TO_DELETE = 1;

DELETE FROM stock_transactions            WHERE @SAFE_TO_DELETE = 1;
DELETE FROM inventory_adjustments         WHERE @SAFE_TO_DELETE = 1;
DELETE FROM inventory_receive_items       WHERE @SAFE_TO_DELETE = 1;
DELETE FROM inventory_receives            WHERE @SAFE_TO_DELETE = 1;
DELETE FROM purchase_order_items          WHERE @SAFE_TO_DELETE = 1;
DELETE FROM supplier_payable_transactions WHERE @SAFE_TO_DELETE = 1;
DELETE FROM supplier_purchase_payments    WHERE @SAFE_TO_DELETE = 1;
DELETE FROM purchase_lot_items WHERE @SAFE_TO_DELETE = 1; -- live FK: purchase_order_id -> purchase_orders.id, see audit .md section 4
DELETE FROM purchase_lots      WHERE @SAFE_TO_DELETE = 1;
DELETE FROM supplier_payments  WHERE @SAFE_TO_DELETE = 1;
DELETE FROM purchase_orders    WHERE @SAFE_TO_DELETE = 1;

DELETE FROM price_change_logs WHERE @SAFE_TO_DELETE = 1;
DELETE FROM import_audit_logs WHERE @SAFE_TO_DELETE = 1;
DELETE FROM ai_action_logs    WHERE @SAFE_TO_DELETE = 1;
DELETE FROM ai_error_logs     WHERE @SAFE_TO_DELETE = 1;
DELETE FROM ai_learning_logs  WHERE @SAFE_TO_DELETE = 1;
DELETE FROM ai_chat_sessions  WHERE @SAFE_TO_DELETE = 1;
DELETE FROM retail_daily_summary WHERE @SAFE_TO_DELETE = 1;
DELETE FROM delete_logs       WHERE @SAFE_TO_DELETE = 1;

SELECT 'orders' t, COUNT(*) remaining FROM orders
UNION ALL SELECT 'payments', COUNT(*) FROM payments
UNION ALL SELECT 'stock_transactions', COUNT(*) FROM stock_transactions
UNION ALL SELECT 'purchase_orders', COUNT(*) FROM purchase_orders;
-- Expect 0 for every row if SAFE_TO_DELETE was 1; unchanged vs the pre-delete
-- counts above if it was 0.

COMMIT;
-- ROLLBACK;   -- <-- use instead of COMMIT if anything above looked wrong
