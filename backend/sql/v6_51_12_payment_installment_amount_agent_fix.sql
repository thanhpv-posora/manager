-- MeatBiz V6.51.12
-- Fix: payments.installment_amount không lưu khi thu tiền từ bill còn nợ.
-- Backend mới sẽ tự đọc orders.current_bill_amount / orders.installment_amount.
-- Script này bổ sung/repair dữ liệu cũ.

-- Repair payments cũ: nếu order có góp nợ/ngày nhưng payment.installment_amount = 0,
-- tính lại phần tiền góp đã thu thật = tiền thu vượt qua phần bill hàng còn lại.
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
    p.monthly_installment_id = COALESCE(p.monthly_installment_id, o.monthly_installment_id),
    p.payment_calendar_type = CASE
      WHEN p.payment_calendar_type IS NULL OR p.payment_calendar_type = '' THEN COALESCE(o.calendar_type, 'SOLAR')
      ELSE p.payment_calendar_type
    END,
    p.payment_lunar_date_text = COALESCE(p.payment_lunar_date_text, o.lunar_date_text)
WHERE COALESCE(o.installment_amount,0) > 0
  AND COALESCE(p.installment_amount,0) = 0
  AND COALESCE(p.amount,0) > COALESCE(
    NULLIF(p.current_bill_amount,0),
    NULLIF(o.current_bill_amount,0),
    GREATEST(COALESCE(o.total_amount,0)-COALESCE(o.installment_amount,0),0),
    0
  );

SELECT p.id,p.payment_code,p.order_id,p.amount,p.current_bill_amount,p.installment_amount,
       p.payment_calendar_type,p.payment_lunar_date_text,o.order_code,o.current_bill_amount order_current_bill,o.installment_amount order_installment
FROM payments p
LEFT JOIN orders o ON o.id=p.order_id
WHERE COALESCE(o.installment_amount,0)>0
ORDER BY p.id DESC
LIMIT 30;
