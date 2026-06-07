# MeatBiz V6.39 POS Agent Refactor

## Đúng cách Agent AI

Tách POS thành component:

- `POSHeaderAgent.jsx`
- `POSProductTableAgent.jsx`
- `POSPaymentPanelAgent.jsx`

## Fix
- Ngày in bill là header sticky thật.
- Thanh toán là panel sticky thật.
- Bảng mặt hàng scroll riêng.
- Không còn vá JSX dài.
- Bỏ cột Mã.
- Ẩn ĐVT.
- Giá nằm sau SL tính.
- Thêm nhanh mặt hàng không làm mất số lượng đang nhập.
