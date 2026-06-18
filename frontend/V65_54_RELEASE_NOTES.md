# MeatBiz Frontend V65.54 – POS compact shipping date context

## Mục tiêu
Giảm chiều cao màn hình tạo bill POS sau khi đã có dialog chọn ngày xuất hàng theo khách hàng.

## Thay đổi
- Bỏ block header lớn `Tạo bill POS / Ngày xuất hàng / Chọn ngày xuất hàng` ở đầu trang POS.
- Chuyển thông tin ngày bill thành pill nhỏ trong khu vực khách hàng.
- Giữ nút `Đổi ngày` nhỏ để mở lại dialog chọn ngày xuất hàng.
- Rule lấy bảng giá không đổi: giá riêng vẫn lấy theo ngày xuất hàng của bill.

## Files changed
- src/pages/CreateOrder.jsx
- src/index.css
- package.json
