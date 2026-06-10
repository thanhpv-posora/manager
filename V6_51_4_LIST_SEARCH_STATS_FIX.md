# MeatBiz V6.51.4 - Bill/Payment pagination and installment stats fix

## Fixed

1. Bill bán hàng
- Phân trang 15 record/trang.
- Bỏ button K80 dư khỏi danh sách và chi tiết bill.
- Thêm tìm kiếm theo khoảng ngày.
- Thêm tìm kiếm theo tên khách hàng.

2. Thu tiền
- Lịch sử thu tiền phân trang 15 record/trang.
- Thêm tìm kiếm lịch sử thu tiền theo khoảng ngày.
- Thêm tìm kiếm lịch sử thu tiền theo tên khách hàng.
- Giữ logic tiền mặt/chuyển khoản nhập độc lập.

3. Thống kê góp nợ thực tế
- Thêm chọn khách hàng thống kê: tất cả khách hoặc 1 khách.
- Không tự ép thống kê theo khách đang cấu hình.
- Nút Thống kê và In phiếu dùng khoảng thời gian đã chọn.

## Backend API
- /api/orders now supports optional query: from_date, to_date, customer_name.
- /api/payments now supports optional query: from_date, to_date, customer_name.
- /api/installments/monthly/stats-range supports optional customer_id.

## SQL
Không cần thêm SQL mới cho phần này.
