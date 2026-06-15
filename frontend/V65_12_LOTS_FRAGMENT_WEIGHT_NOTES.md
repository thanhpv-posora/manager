# V65.12 - Nhập lô bò thêm trường Vụn

## Frontend
- Thêm trường `Vụn kg` trong Nhập lô / NCC > Nhập lô bò > Khoản trừ chi tiết.
- `Vụn kg` hỗ trợ nhập biểu thức như các ô kg khác, ví dụ: `2 + 1`.
- Kg tính tiền trừ thêm phần vụn.
- Bảng cách tính hiển thị thêm vụn.
- Thống kê Nhập lô / NCC thêm tổng Kg vụn.

## Backend
- Thêm field `fragment_weight` vào `purchase_lots`.
- Tự bootstrap DB bằng `safeAddColumn` nếu DB cũ chưa có cột.
- API tạo lô nhận và lưu `fragment_weight`.
- Phiếu in NCC hiển thị dòng `Vụn`.
