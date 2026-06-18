# MeatBiz V65.40 – Payment selected bills allocation fix

## Fixed
- Thu tiền: khi user chọn nhiều bill trong dialog, backend dùng đúng `allocate_order_ids`.
- Tự đưa `order_id` hiện tại vào danh sách phân bổ.
- Sắp xếp bill theo `order_date ASC, id ASC` để bill cũ được thanh toán trước.
- Tiền dư sau khi thanh toán bill cũ sẽ phân bổ sang bill tiếp theo nếu bill đó đã được chọn trên dialog.
- Không tự phân bổ sang bill không được chọn; nếu còn dư sau các bill đã chọn thì lưu vào `payment_unapplied_credits`.
- Query bill mở dùng `COALESCE(status,'CONFIRMED') <> 'CANCELLED'` để không bỏ sót bill có `status` NULL.
- Sửa fallback update order trong `ensureOrderPayableTotal`.

## Expected example
- BILL1 còn nợ 11,161,500đ
- BILL2 còn nợ 72,497,500đ
- User thu 75,000,000đ và chọn BILL1 + BILL2
- Backend phân bổ:
  - BILL1: 11,161,500đ
  - BILL2: 63,838,500đ
