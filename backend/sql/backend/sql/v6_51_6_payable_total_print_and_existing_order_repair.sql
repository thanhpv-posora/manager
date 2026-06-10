-- MeatBiz V6.51.6
-- Fix: total payable must include today's bill + góp nợ/ngày.
-- Repairs old orders where installment_amount exists but total_amount was stored as today's bill only.

UPDATE orders
SET
  total_amount = current_bill_amount + installment_amount,
  debt_amount = GREATEST(0, (current_bill_amount + installment_amount) - COALESCE(paid_amount,0)),
  payment_status = CASE
    WHEN GREATEST(0, (current_bill_amount + installment_amount) - COALESCE(paid_amount,0)) <= 0 THEN 'PAID'
    WHEN COALESCE(paid_amount,0) > 0 THEN 'PARTIAL'
    ELSE 'UNPAID'
  END
WHERE COALESCE(installment_amount,0) > 0
  AND COALESCE(current_bill_amount,0) > 0
  AND COALESCE(total_amount,0) < (current_bill_amount + installment_amount);
