# MeatBiz V65.52 – POS Price Book Lookup By Bill Date

## Mục tiêu
Sửa lỗi tạo bill POS/import Excel lấy sai bảng giá riêng khi bill có ngày xuất hàng cũ hơn bảng giá mới nhất.

## Fix chính
- Backend không tin `sale_price` frontend gửi lên cho sản phẩm đã có trong DB.
- Khi lưu bill, backend luôn resolve lại giá theo:
  - `customer_id`
  - `calendar_type` của bill/khách
  - `order_date` là ngày xuất hàng dương quy đổi
  - `lunar_date_text` nếu khách tính âm lịch
- Âm lịch dùng `effective_lunar_sort <= bill_lunar_sort ORDER BY effective_lunar_sort DESC LIMIT 1`.
- Dương lịch dùng `effective_from <= order_date ORDER BY effective_from DESC LIMIT 1`.
- Thêm API preview giá hiệu lực cho frontend: `POST /api/price-matrix/:customerId/effective-prices`.

## File chính
- `src/services/PriceBookService.js`
- `src/agents/OrderAgent.js`
- `src/routes/priceMatrix.js`

## SQL
Không cần migration DB mới.
