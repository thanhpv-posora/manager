# V65.16 Supplier report bill-date column

- Giữ nguyên cột Ngày lập phiếu theo `purchase_date`.
- Thêm cột Ngày tính phiếu trong thống kê chi tiết NCC.
- Nếu lô/NCC dùng âm lịch: hiển thị `lunar_date_text` + `ÂL`.
- Nếu lô/NCC dùng dương lịch: hiển thị `purchase_date` + `DL`.
- In chi tiết NCC cũng có đủ 2 cột: Ngày lập phiếu và Ngày tính phiếu.
- Bộ lọc từ ngày/đến ngày vẫn lọc theo Ngày lập phiếu.
