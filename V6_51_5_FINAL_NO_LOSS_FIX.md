# V6.51.5 Final No-Loss Fix

Bản này được repack từ bản mới nhất có đủ các fix trước đó và chỉ vá thêm lỗi thao tác ở màn Thống kê góp nợ:

- Không mất các fix đã làm trước đó.
- Installments.jsx: tất cả button thao tác chuyển sang `type="button"` để không submit/scroll về top trang.
- Giữ các chức năng: POS Âm/Dương, customer billing calendar, góp nợ theo ngày áp dụng, thống kê theo lịch khách hàng, layout bill actions, K80/A4, payment cash-bank độc lập.

Lưu ý build trong sandbox không chạy được vì project zip không có vite/node_modules. Khi deploy ở máy dev/server, chạy:

```bash
cd frontend
npm install
npm run build
```
