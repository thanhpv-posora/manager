# MeatBiz Frontend V65.52 – POS Price Preview By Bill Date

## Mục tiêu
Đồng bộ UI POS với backend: import Excel hoặc nhập tay chọn ngày bill nào thì giá trên màn hình cũng refresh theo bảng giá hiệu lực của ngày đó.

## Fix chính
- Khi đổi ngày bill/loại lịch/ngày âm lịch, POS gọi API effective prices để refresh giá.
- Khi import Excel lấy được ngày xuất hàng, POS refresh lại giá theo ngày đó.
- Payload lưu bill gửi kèm `price_book_id`, nhưng backend vẫn là nguồn kiểm tra cuối cùng.

## File chính
- `src/pages/CreateOrder.jsx`

## SQL
Không cần migration DB mới.
