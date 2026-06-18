# V65.24 - Import bảng giá riêng từ Excel

- Thêm nút Import giá từ Excel trong chức năng Bảng giá riêng.
- Đọc mẫu Excel có cột `Mặt hàng` và `Đơn giá`.
- Chỉ mapping đúng tên hàng hoặc mã hàng trong database.
- Không dùng alias, không fuzzy để tránh sai giá.
- Dòng không mapping được hiển thị trong preview và bị bỏ qua.
- Dòng giá lỗi hoặc bằng 0 hiển thị riêng để kiểm tra.
- Sau khi preview OK, bấm đưa dòng đã mapping vào bảng giá rồi bấm Lưu tất cả an toàn để ghi DB.
- Build frontend OK.
