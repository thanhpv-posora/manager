-- V6.51.8 Print split/total repair
-- total_amount is payable total. current_bill_amount must be today's product bill only.
-- If current_bill_amount was accidentally saved equal to total_amount, split it back.

UPDATE orders
SET current_bill_amount = GREATEST(0, COALESCE(total_amount,0) - COALESCE(installment_amount,0))
WHERE COALESCE(installment_amount,0) > 0
  AND (current_bill_amount IS NULL OR current_bill_amount = 0 OR current_bill_amount >= total_amount);

UPDATE orders
SET debt_amount = GREATEST(0, COALESCE(total_amount,0) - COALESCE(paid_amount,0)),
    payment_status = CASE
      WHEN COALESCE(paid_amount,0) <= 0 THEN 'UNPAID'
      WHEN COALESCE(paid_amount,0) >= COALESCE(total_amount,0) THEN 'PAID'
      ELSE 'PARTIAL'
    END
WHERE COALESCE(installment_amount,0) > 0;
