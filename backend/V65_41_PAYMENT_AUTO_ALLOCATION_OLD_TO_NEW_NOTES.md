# V65.41 - Payment Auto Allocation Old To New

- Thu tiền khách có bill còn nợ không cần tick chọn từng bill nữa.
- Backend tự phân bổ tiền theo ngày xuất hàng cũ -> mới.
- Bill cũ được trả trước; tiền dư tự chạy sang bill kế tiếp.
- Mỗi bill nhận tiền sẽ có payment_allocations riêng để in bill thấy đúng số tiền đã phân bổ cho bill đó.
- Nếu thanh toán dư sau khi hết bill nợ thì lưu vào payment_unapplied_credits.
