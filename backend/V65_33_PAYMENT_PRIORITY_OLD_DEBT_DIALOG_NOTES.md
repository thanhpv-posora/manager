# V65.33 - Payment priority old debt dialog

## Changed
- Thu tiền: nếu khách có bill còn nợ cũ và có nhập tiền thu, luôn hiện dialog chọn bill muốn ưu tiên thanh toán.
- Không còn giới hạn chỉ hiện dialog khi tiền khách đưa lớn hơn bill đang thu.
- Tiền sẽ trừ các bill nợ cũ đã chọn trước, còn dư mới trừ bill đang thu.
- Nếu không muốn trừ nợ cũ, bấm "Không trừ nợ cũ, thu bill hiện tại".

## Safety
- Không tự trừ âm thầm bill cũ.
- User phải chọn bill cũ muốn thanh toán.
- Backend cũng đổi thứ tự phân bổ khi có allocate_order_ids: old debt first, current bill second.
