-- MeatBiz V6.51.7 Critical repair: daily installment must remain as receivable debt until paid.

-- 1) Repair orders where total_amount missed the daily installment.
UPDATE orders
SET
  total_amount = COALESCE(current_bill_amount,0) + COALESCE(installment_amount,0),
  debt_amount = GREATEST(0, (COALESCE(current_bill_amount,0) + COALESCE(installment_amount,0)) - COALESCE(paid_amount,0)),
  payment_status = CASE
    WHEN GREATEST(0, (COALESCE(current_bill_amount,0) + COALESCE(installment_amount,0)) - COALESCE(paid_amount,0)) <= 0 THEN 'PAID'
    WHEN COALESCE(paid_amount,0) > 0 THEN 'PARTIAL'
    ELSE 'UNPAID'
  END
WHERE COALESCE(installment_amount,0) > 0
  AND COALESCE(current_bill_amount,0) > 0
  AND (COALESCE(total_amount,0) <> (COALESCE(current_bill_amount,0) + COALESCE(installment_amount,0))
       OR COALESCE(debt_amount,0) <> GREATEST(0, (COALESCE(current_bill_amount,0) + COALESCE(installment_amount,0)) - COALESCE(paid_amount,0)));

-- 2) Diagnostic: rows that still look wrong after repair.
SELECT id, order_code, current_bill_amount, installment_amount, total_amount, paid_amount, debt_amount, payment_status
FROM orders
WHERE COALESCE(installment_amount,0) > 0
  AND COALESCE(total_amount,0) <> (COALESCE(current_bill_amount,0) + COALESCE(installment_amount,0));
