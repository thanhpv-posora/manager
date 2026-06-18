# MeatBiz V65.38 - Payment unused balance / customer credit forward fix

## Fix
- Khi thu tiền dư sau khi đã trả hết các bill còn nợ hiện tại, phần dư không bị mất quản lý nữa.
- Phần dư được lưu vào bảng `payment_unapplied_credits` theo khách hàng.
- Khi tạo bill mới sau đó, hệ thống tự phân bổ phần dư vào bill mới theo ngày xuất hàng cũ → mới.
- Khi in bill, chỉ hiển thị số tiền thật sự được phân bổ vào bill đó, không hiển thị nguyên phiếu thu.

## Affected
- Backend PaymentAgent
- Backend OrderAgent
- Print A4/K80 vẫn đọc payment_allocations theo từng bill
