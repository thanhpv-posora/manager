# MeatBiz Backend V65.55

## POS no future bill date

- Chặn backend tạo bill có ngày xuất hàng lớn hơn ngày hiện tại.
- Áp dụng cả bill dương lịch và bill âm lịch đã quy đổi sang dương lịch.
- Trả lỗi chuẩn `FUTURE_BILL_DATE` để frontend hiển thị rõ.
- Không cần SQL migration mới.
