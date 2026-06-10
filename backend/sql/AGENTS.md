# MeatBiz V6.7 Professional Agents

## Khác biệt so với code thường
Trước đây:
Route -> SQL trực tiếp -> dễ sửa module này hỏng module khác.

V6.7:
Route -> Agent -> Service -> DB

Mỗi Agent có trách nhiệm rõ:
- CustomerAgent: khách hàng CRUD + công nợ
- ProductAgent: mặt hàng CRUD + nhóm hàng + giá riêng
- OrderAgent: bill + QR + in A4 + in nhiệt K80
- PaymentAgent: thu tiền + phân bổ công nợ
- SupplierAgent: nhà cung cấp + nhập lô + trả/ứng NCC
- ReportAgent: dashboard + doanh thu

## UI chứng minh Agent
Menu `Agent AI` hiển thị danh sách Agent đang active, trách nhiệm và version.
