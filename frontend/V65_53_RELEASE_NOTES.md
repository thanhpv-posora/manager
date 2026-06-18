# MeatBiz V65.53 – POS chọn ngày xuất hàng sau khi chọn khách

## Mục tiêu

Khi tạo bill POS nhập tay, chọn khách xong phải chọn ngay ngày xuất hàng theo đúng loại lịch của khách.

## Đã sửa frontend

- Khách tính bill âm lịch: sau khi chọn khách hiện dialog chọn ngày âm lịch.
- Khách tính bill dương lịch: sau khi chọn khách hiện dialog chọn ngày dương lịch.
- Hiển thị rõ rule: bảng giá riêng lấy theo ngày xuất hàng của bill.
- Có nút chọn lại ngày xuất hàng trong POS.
- Sau khi áp dụng ngày, POS refresh lại giá theo ngày bill.

## Backend

Không cần SQL mới. Backend V65.52 đã kiểm tra lại bảng giá theo ngày xuất hàng khi lưu bill.

## File thay đổi

- src/pages/CreateOrder.jsx
- package.json

## Test chính

1. Khách âm lịch, bảng giá 01/01 và 01/02 âm lịch. Chọn ngày bill 08/01 âm lịch, giá phải lấy bảng 01/01.
2. Khách dương lịch, bảng giá 01/06 và 15/06 dương lịch. Chọn ngày bill 14/06, giá phải lấy bảng 01/06.
3. Chọn lại ngày xuất hàng, giá trong POS phải refresh theo ngày mới.
