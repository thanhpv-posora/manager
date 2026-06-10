# V6.51.5 - Installment Stats Customer Calendar Fix

- Thống kê tổng hợp tiền góp nợ chạy theo `customers.billing_calendar_type` khi chọn khách hàng.
- Nếu khách tính bill âm lịch, bộ lọc thống kê hiển thị ngày âm và gửi `calendar_type=LUNAR` kèm ngày âm lên API.
- API `/installments/monthly/stats-range` hỗ trợ tổng hợp theo khoảng ngày âm lịch bằng `orders.lunar_date_text`.
- Nếu không chọn khách hàng, thống kê mặc định theo ngày dương lịch cho toàn bộ khách.
- Nút In phiếu thống kê hiển thị đúng loại lịch và khoảng ngày đang chọn.
