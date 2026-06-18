# V65.22 - POS Excel Import: 1 sheet = 1 bill

## Fix
- Excel import không còn gom nhiều sheet vào 1 bill.
- Mỗi sheet đại diện cho 1 bill riêng.
- Sheet 1 load vào preview, bấm "Đưa dòng đã chọn vào bill", rồi bấm "Lưu bill".
- Sau khi lưu, hệ thống hỏi confirm xử lý sheet tiếp theo.
- OK: chuyển sang sheet tiếp theo, áp ngày trong sheet đó.
- Cancel: dừng import Excel, không làm sheet tiếp theo.

## Date rule
- Ngày trong Excel là ngày tính bill.
- Khách tính âm lịch: ngày Excel được hiểu là âm lịch.
- Khách tính dương lịch: ngày Excel được hiểu là dương lịch.

## Mapping rule
- Dòng trong từng sheet match riêng theo product_id.
- Không lấy đơn giá Excel.
- Giá vẫn lấy từ hệ thống theo khách.
- Dòng không mapping báo trong preview và bỏ qua khi đưa vào bill.
