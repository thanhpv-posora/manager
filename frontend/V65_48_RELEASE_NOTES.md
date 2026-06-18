# MeatBiz Frontend V65.48 - POS Save Error Message

## Nền source
- Gộp từ V65.45/V65.47 hiện tại.
- Không chứa source backend trong gói frontend.

## Fix chính trong V65.48
- Màn POS bắt lỗi `PRICE_NOT_FOUND` từ backend.
- Hiển thị danh sách sản phẩm thiếu giá rõ ràng cho người dùng.
- Nút lưu có trạng thái `Đang lưu...` để tránh bấm nhiều lần.

## File frontend liên quan
- `src/pages/CreateOrder.jsx`

## Test nhanh
1. Chọn khách chưa có giá cho sản phẩm.
2. Bấm lưu bill.
3. Kỳ vọng hiện alert/message, không đứng im.
