# MeatBiz V65.50 - Price Book Lunar/Solar Effective Date

## Nội dung

- Bảng giá riêng dùng loại lịch theo khách hàng:
  - `customers.billing_calendar_type = LUNAR` -> bảng giá hiệu lực theo âm lịch.
  - `customers.billing_calendar_type = SOLAR` -> bảng giá hiệu lực theo dương lịch.
- Không dùng `effective_to` để quyết định giá.
- POS lấy bảng giá theo ngày xuất hàng của bill:
  - Dương lịch: `effective_from <= order_date`, lấy bản gần nhất.
  - Âm lịch: `effective_lunar_sort <= lunar_date_text`, lấy bản gần nhất.
- Quản lý bảng giá vẫn giữ rule V65.49:
  - Có bill chưa thu tiền vẫn được sửa, bill chưa thu tiền sẽ recalculate.
  - Có bill đã thu tiền/phân bổ thì khóa bảng giá.

## SQL cần chạy

`sql/V65_50_PRICE_BOOK_LUNAR_SOLAR_EFFECTIVE_DATE.sql`

## File chính thay đổi

- `src/services/PriceBookService.js`
- `src/agents/PriceMatrixAgent.js`
- `src/routes/priceMatrix.js`
- `src/agents/OrderAgent.js`
