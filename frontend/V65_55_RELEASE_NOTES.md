# MeatBiz Frontend V65.55

## POS no future bill date

- Không cho chọn ngày xuất hàng dương lịch lớn hơn hôm nay.
- Không cho chọn ngày âm lịch nếu ngày quy đổi dương lịch lớn hơn hôm nay.
- Import Excel bill cũng bị chặn nếu ngày xuất hàng trong file là ngày tương lai.
- Khi lưu bill, frontend kiểm tra lại một lần trước khi gửi backend.
- Không cần SQL migration mới.
