# V65.23 - POS Excel strict DB mapping

- Excel import không dùng alias/fuzzy matching nữa.
- Chỉ map khi tên trong Excel khớp đúng tên hàng hoặc mã hàng trong database.
- Mặt hàng không khớp đúng sẽ báo không mapping và không đưa vào bill.
- Tránh lỗi Nầm/Nạm/Lòng bị cộng nhầm số lượng sang mặt hàng khác.
- Giữ flow V65.22: 1 sheet = 1 bill, lưu xong hỏi xử lý sheet tiếp theo.
