# MeatBiz V65.27 – Supplier report mapped solar date fix

- Thống kê chi tiết NCC hiển thị thêm cột `Ngày dương mapping`.
- Thống kê tổng hợp NCC hiển thị khoảng ngày dương mapping theo từng NCC.
- Bộ lọc báo cáo NCC dùng `purchase_date` là ngày tính phiếu đã mapping sang dương lịch, không dùng ngày lập phiếu.
- In chi tiết NCC thêm cột ngày dương mapping.
- In tổng hợp NCC thêm khoảng ngày dương mapping.
- In phiếu NCC hiển thị riêng:
  - Ngày lập phiếu
  - Ngày tính bill NCC
  - Ngày dương mapping
- Backend bootstrap đảm bảo có `purchase_lots.calendar_type` và `purchase_lots.lunar_date_text`.
