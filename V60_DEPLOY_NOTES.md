# V60 - QR/NCC Print/Layout/Dashboard Fix

Fixes:
- Phiếu in NCC có QR code để mở lại phiếu in công khai.
- QR bill / QR NCC không dùng localhost khi deploy production; nếu env trỏ localhost sẽ fallback `https://meatbiz.posora.vn`.
- Màn nhập lô: hàng đầu gồm Tên lô / Ngày nhập / Nhà cung cấp / Ngày âm lịch nằm cùng một line trên desktop.
- Dashboard AI Operating Center: sửa màu chữ “Điều hành hôm nay” để nhìn rõ trên nền tối.
- Lots print dùng api base runtime thay vì VITE_API_URL cứng localhost.

Build checks:
- Frontend `npm run build`: OK
- Backend `node -c src/**/*.js`: OK

Deploy:
- Copy backend + frontend vào server.
- Nếu dùng Docker: `docker compose up -d --build`.
- Nên set env production:
  PUBLIC_APP_URL=https://meatbiz.posora.vn
