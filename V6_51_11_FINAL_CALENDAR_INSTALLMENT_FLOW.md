# MeatBiz V6.51.11 Final Calendar + Installment Flow

Đã rà và vá đồng bộ theo flow:

Customer billing_calendar_type
→ POS CreateOrder
→ orders.current_bill_amount / orders.installment_amount / orders.total_amount
→ PaymentAgent payments.installment_amount
→ Print A4/K80
→ Installment Stats.

## Fix trọng tâm

1. Khách hàng có option tính bill theo SOLAR/LUNAR.
2. POS chọn khách sẽ tự dùng loại lịch của khách.
3. Order lưu:
   - current_bill_amount = bill hàng hôm nay
   - installment_amount = góp nợ/ngày cấu hình
   - total_amount = current_bill_amount + installment_amount
   - debt_amount = total_amount - paid_amount
4. PaymentAgent tự đọc order để xác định tiền góp nợ/ngày đã thu thật.
   - Nếu trả chỉ đủ bill hôm nay: payments.installment_amount = 0
   - Nếu trả vượt bill hôm nay vào phần góp nợ: payments.installment_amount = phần góp đã thu
   - Nếu thu sau bill còn nợ: vẫn tính đúng phần góp nợ đã thu
5. Payment lưu thêm calendar metadata nếu DB đã migrate:
   - payment_calendar_type
   - payment_lunar_date_text
6. Thống kê góp nợ lấy tiền thực thu từ payments.installment_amount, có fallback derive từ order cho dữ liệu cũ.
7. Update item trong bill không làm mất phần installment_amount.

## SQL cần chạy

backend/sql/v6_51_11_final_calendar_payment_installment_flow.sql

## Kiểm tra đã thực hiện

- Backend JS syntax: OK
- Frontend build: OK
