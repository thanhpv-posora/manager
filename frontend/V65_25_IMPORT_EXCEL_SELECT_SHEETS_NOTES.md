# V65.25 - Import Excel chọn sheet

## POS import Excel
- Thêm ô `Sheet cần đọc`.
- Để trống = đọc tất cả sheet.
- Nhập nhiều sheet bằng dấu phẩy, ví dụ: `01-05-2026, 02-05-2026`.
- Chỉ xử lý các sheet được chỉ định.
- Mỗi sheet vẫn là một bill riêng.
- Nếu sheet không tồn tại, báo lỗi và không import sai.

## Bảng giá riêng import Excel
- Thêm ô `Sheet import`.
- Để trống = đọc tất cả sheet.
- Nhập nhiều sheet bằng dấu phẩy.
- Chỉ lấy dữ liệu giá từ các sheet được chỉ định.
- Vẫn strict mapping theo tên/mã mặt hàng database, không dùng alias/fuzzy.

## Build
- Frontend build OK.
