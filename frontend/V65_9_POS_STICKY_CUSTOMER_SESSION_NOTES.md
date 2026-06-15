# V65.9 - POS Sticky Customer Session

## Mục tiêu
Sau khi lưu bill POS, giữ nguyên khách hàng hiện tại để người dùng tạo bill tiếp theo nhanh hơn, không cần chọn khách khác rồi chọn lại.

## Thay đổi frontend
- Sau khi Lưu bill thành công:
  - Giữ nguyên khách hàng hiện tại.
  - Giữ lịch âm/dương theo khách.
  - Xóa số lượng các mặt hàng trong bill vừa nhập.
  - Reset tiền mặt/chuyển khoản/import text.
  - Hiện thông báo: đã lưu bill và sẵn sàng nhập bill tiếp theo cho cùng khách.
  - Tự focus lại ô nhập số lượng để thao tác tiếp.
- Thêm banner trạng thái khách đang tạo bill:
  - Tên khách đang được giữ.
  - Ngày âm/dương hiện tại.
  - Nút "Nhập bill tiếp".
  - Nút "Đổi khách".
- Khi đổi khách mà bill đang nhập có số lượng, hỏi xác nhận để tránh mất dữ liệu.

## Backend
- Không thay đổi so với V65.8.
