# V65.34 - Payment allocation per bill

## Fix
- Thu tiền cho khách có nhiều bill nợ sẽ phân bổ tiền theo từng bill, không ghi một cục vào bill đang thu.
- Các bill được chọn sẽ được sắp theo ngày bill cũ đến mới để phân bổ.
- Ví dụ: chọn BILL1 và chọn thêm BILL2, khách đưa 70 triệu:
  - BILL1 nhận đúng phần còn nợ trước.
  - Tiền còn lại mới phân bổ qua BILL2.
- Mỗi bill tự cập nhật paid_amount, debt_amount, payment_status riêng.

## Print
- In bill A4/K80 không còn hiển thị một dòng “Tiền mặt” theo toàn bộ phiếu thu.
- In theo lịch sử phân bổ của bill:
  - Tổng bill này
  - Các lần thanh toán bill này
  - Tổng đã trả bill này
  - Còn nợ bill này
- Bill cũ sau khi được trả bằng lần thu sau sẽ in đúng trạng thái PAID và còn nợ 0đ.

## UI
- Dialog Thu tiền đổi wording từ “trừ nợ cũ” sang “phân bổ tiền” để tránh hiểu nhầm.
