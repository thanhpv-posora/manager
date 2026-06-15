# MeatBiz V62 - Thu tiền phân bổ tiền dư qua bill nợ cũ

## Nội dung chính

Khi thu tiền cho một bill hiện tại, nếu số tiền khách đưa lớn hơn số tiền còn nợ của bill đó, hệ thống sẽ mở dialog danh sách bill nợ cũ của khách để người dùng chọn bill cần trừ.

Ví dụ:
- Bill cũ 27/04 ÂL: 12,000,000đ
- Bill cũ 28/04 ÂL: 5,000,000đ
- Bill mới 29/04 ÂL: 3,000,000đ
- Khách đưa tiền mặt: 20,000,000đ

Xử lý:
1. Thu đủ bill mới 3,000,000đ.
2. Tiền dư 17,000,000đ.
3. Hiện dialog bill nợ cũ.
4. Người dùng chọn bill 12,000,000đ và 5,000,000đ.
5. Backend phân bổ đúng tổng 20,000,000đ.

## Backend

Sửa `backend/src/agents/PaymentAgent.js`:
- Thêm `allocateSelected()`.
- `create()` giờ hỗ trợ `allocate_order_ids`.
- Tiền trả luôn áp dụng bill đang chọn trước.
- Phần dư chỉ trừ bill nợ cũ nếu người dùng chọn.
- Có trả về `old_debt_allocations` và `unused_amount`.

## Frontend

Sửa `frontend/src/pages/Payments.jsx`:
- Nếu tiền thu vượt bill hiện tại thì mở dialog chọn bill nợ cũ.
- Có lựa chọn:
  - Chỉ thu bill hiện tại.
  - Xác nhận trừ nợ cũ.
- Có hiển thị tiền dư, tổng nợ cũ đã chọn, tiền còn chưa phân bổ.

## Ghi chú triển khai

Không cần SQL mới cho V62.
Chỉ deploy backend + frontend.
