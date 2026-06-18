# MeatBiz V65.48 - POS Save Error Message

## Nền source
- Gộp từ V65.45/V65.47 hiện tại.
- Giữ các chức năng V65.47: bỏ tiền khỏi Bill, chốt Bill, sửa/hủy/chốt phiếu thu, re-allocation payment.

## Fix chính trong V65.48
- POS lưu bill nếu khách chưa có giá sẽ trả lỗi rõ ràng, không im lặng.
- Backend trả HTTP 400 với code `PRICE_NOT_FOUND`.
- Gom nhiều sản phẩm thiếu giá vào `details.items` để frontend hiển thị một lần.
- Error middleware trả JSON chuẩn gồm `success`, `code`, `message`, `details`.

## File backend liên quan
- `src/agents/OrderAgent.js`
- `src/middleware/errorHandler.js`
- `src/routes/orders.js`

## Test nhanh
1. Chọn khách chưa có giá cho một sản phẩm.
2. Tạo bill POS có sản phẩm đó.
3. Bấm lưu bill.
4. Kỳ vọng frontend hiện thông báo: Khách chưa có giá cho mặt hàng ...
