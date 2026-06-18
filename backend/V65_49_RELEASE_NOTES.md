# MeatBiz V65.49 - Price Book Management

## Mục tiêu
Quản lý nhiều bảng giá riêng theo khách hàng: xem, sửa, xóa mềm, copy.

## Quy tắc production
- Bảng giá chưa phát sinh thu tiền: được sửa. Nếu đã dùng cho bill chưa thu tiền, hệ thống tự cập nhật lại giá bill chưa thu.
- Bảng giá đã có bill phát sinh thu tiền/payment allocation: không cho sửa/xóa.
- Xóa là xóa mềm `status='DELETED'`, không xóa cứng.
- Copy bảng giá tạo version mới với ngày hiệu lực mới.

## File chính
- src/agents/PriceMatrixAgent.js
- src/routes/priceMatrix.js
- sql/V65_49_PRICE_BOOK_MANAGEMENT.sql
