-- MeatBiz V6.51.10
-- Fix paid installment statistics when old POS payments were saved with payments.installment_amount = 0.
-- It derives actual paid installment from: payment amount - today's bill amount, capped by order.installment_amount.

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
p.monthly_installment_id = COALESCE(p.monthly_installment_id, o.monthly_installment_id)
WHERE COALESCE(p.installment_amount,0)=0
  AND COALESCE(o.installment_amount,0)>0
  AND COALESCE(p.amount,0) > COALESCE(
    NULLIF(p.current_bill_amount,0),
    NULLIF(o.current_bill_amount,0),
    GREATEST(COALESCE(o.total_amount,0)-COALESCE(o.installment_amount,0),0),
    0
  );

-- Verify
SELECT p.id,p.payment_code,p.customer_id,p.order_id,p.payment_date,p.amount,p.current_bill_amount,p.installment_amount,p.monthly_installment_id
FROM payments p
WHERE COALESCE(p.installment_amount,0)>0
ORDER BY p.payment_date DESC,p.id DESC;
