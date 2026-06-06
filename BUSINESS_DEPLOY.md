# MeatBiz V6.14 Business Deployment Notes

## Vì sao voice có thể không chạy ở máy khách?
Browser Web Speech cần:
- Chrome hoặc Edge mới
- chạy trên `localhost` hoặc HTTPS
- được cấp quyền microphone

Nếu triển khai trong LAN bằng `http://192.168.x.x`, microphone có thể bị chặn.

## Cách triển khai chuyên nghiệp
### Option 1: chạy tại máy bán hàng
- backend + frontend chạy local
- truy cập `http://localhost:5173`
- voice nhận tốt nhất

### Option 2: triển khai LAN có HTTPS
Dùng reverse proxy Caddy/Nginx + SSL local/domain.

### Option 3: bản SaaS
Deploy cloud có HTTPS thật:
- Cloudflare domain
- VPS/GCP
- MySQL managed/self-hosted
- HTTPS bắt buộc

## Khuyến nghị đem bán
Gói Basic:
- bán hàng
- bảng giá riêng
- in bill
- công nợ

Gói Pro:
- voice bill
- báo cáo nâng cao
- phân quyền nhân viên
- backup tự động

Gói Enterprise:
- hóa đơn điện tử
- multi-branch
- dashboard cloud
