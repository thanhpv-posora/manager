# V6.51.5 Critical Fix - Góp nợ/ngày không bị mất

## Lỗi đã sửa
Ví dụ bill hôm nay 2.380.000đ + góp nợ/ngày 2.000.000đ = tổng cần thanh toán 4.380.000đ.
Nếu khách chỉ trả 2.380.000đ, hệ thống cũ set bill PAID vì orders.total_amount chỉ là bill hôm nay.
Kết quả: 2.000.000đ góp nợ/ngày bị mất khỏi bill còn nợ.

## Logic mới
- orders.total_amount = bill hôm nay + góp nợ/ngày
- orders.current_bill_amount = bill hôm nay
- orders.installment_amount = góp nợ/ngày cấu hình áp dụng cho bill
- orders.debt_amount = tổng cần thanh toán - đã trả
- payments.installment_amount = tiền góp nợ/ngày thực tế đã thu, dùng cho thống kê

## Ví dụ
Bill hôm nay: 2.380.000đ
Góp nợ/ngày: 2.000.000đ
Khách trả: 2.380.000đ

Kết quả:
- total_amount = 4.380.000
- paid_amount = 2.380.000
- debt_amount = 2.000.000
- payment_status = PARTIAL
- payments.installment_amount = 0

Nếu khách trả đủ 4.380.000đ:
- debt_amount = 0
- payment_status = PAID
- payments.installment_amount = 2.000.000
