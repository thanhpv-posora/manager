# V65.39 - Payment Forward To Next Bill Fix

## Fix
- Khi khách trả tiền cho bill cũ và số tiền dư còn lại, backend sẽ phân bổ trực tiếp phần dư sang bill kế tiếp theo ngày xuất hàng trong cùng payment_id.
- Không còn tình trạng bill 1 đủ tiền nhưng bill 2 không thấy khoản thanh toán.
- Chỉ khi không còn bill nợ nào mới lưu thành tiền dư chưa phân bổ của khách.

## Files
- src/agents/PaymentAgent.js

## Validation
- node -c src/agents/PaymentAgent.js OK.
