# MeatBiz V65.26 - Bill Date Mapping Lunar/Solar Fix

## Mục tiêu
Tách đúng 2 loại ngày:
- Ngày lập phiếu: ngày user thao tác tạo trên hệ thống (`created_at`).
- Ngày tính bill/doanh thu: ngày nghiệp vụ user chọn (`order_date` / `purchase_date`) đã mapping đúng âm-dương.

## POS bán hàng
- Nếu khách dùng âm lịch và chọn `01/05/2026 AL`, frontend convert sang `2026-06-15 DL`.
- Backend cũng kiểm tra lại và convert server-side trước khi lưu `orders.order_date`.
- In bill POS hiển thị cả ngày lập phiếu và ngày tính bill.
- Dashboard/doanh thu/báo cáo dùng `orders.order_date`, không dùng ngày hiện tại.

## Nhập lô/NCC
- Nếu NCC dùng âm lịch, nhập ngày âm sẽ tự mapping sang ngày dương tương ứng để lưu `purchase_lots.purchase_date`.
- Backend cũng kiểm tra lại và convert server-side trước khi lưu.
- In phiếu NCC hiển thị ngày lập phiếu và ngày tính bill NCC.
- Thống kê NCC dùng ngày tính phiếu, ngày lập phiếu lấy `created_at`.

## Báo cáo / Dashboard
- Revenue và dashboard tiếp tục tính theo ngày nghiệp vụ (`order_date`) sau khi backend đã đảm bảo mapping đúng.
