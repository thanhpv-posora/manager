# MeatBiz V6.51.3 Fix

Các điểm đã sửa:

1. Tạo bill POS
- Chọn ngày dương lịch sẽ tự cập nhật ngày âm lịch tương ứng.
- Chọn/nhập ngày âm lịch sẽ tự quy đổi lại ngày dương lịch tương ứng.
- Khi chọn khách hàng, POS tự chọn loại lịch mặc định theo `customers.billing_calendar_type`.
- Gửi `calendar_type` và `lunar_date_text` khi lưu bill để in phiếu và mapping góp nợ đúng loại lịch.

2. Bỏ chức năng giá riêng dư trong POS
- Bỏ field `Giá riêng cho khách này` ở phần thêm nhanh mặt hàng.
- POS vẫn dùng Bảng giá riêng/Price Matrix hiện có.

3. Dashboard
- Sửa frontend đọc đúng response `/reports/dashboard` theo `summary`.

4. Thống kê góp nợ
- Bọc lỗi khi bấm Thống kê để hiển thị rõ message thay vì im lặng.
- Giữ chức năng chọn khoảng thời gian + in phiếu.
