# MeatBiz Frontend V65.47

Nền: frontend V65.45 user upload.

## Thay đổi
- `src/pages/CreateOrder.jsx`: Bill không nhập/ghi tiền nữa. Tiền xử lý ở menu Thu tiền.
- `src/pages/Payments.jsx`: thêm sửa/hủy/chốt phiếu thu.
- `src/pages/Orders.jsx`: thêm chốt bill.

## Lưu ý build
Chưa chạy `npm run build` trong sandbox vì thiếu `node_modules/vite`. Sau khi copy vào máy local, chạy:

```bash
npm install
npm run build
```
