-- MeatBiz V6.51.9
-- Fix thống kê góp nợ thực tế khi dữ liệu cũ có payments.installment_amount = 0
-- nhưng payment đã thu đủ phần góp nợ nằm trong order.installment_amount.
-- Chạy sau khi đã có các cột:
-- orders.current_bill_amount, orders.installment_amount, payments.current_bill_amount, payments.installment_amount.

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
)
WHERE COALESCE(p.installment_amount,0)=0
  AND COALESCE(o.installment_amount,0)>0
  AND COALESCE(p.amount,0) > COALESCE(
    NULLIF(p.current_bill_amount,0),
    NULLIF(o.current_bill_amount,0),
    GREATEST(COALESCE(o.total_amount,0)-COALESCE(o.installment_amount,0),0),
    0
  );
