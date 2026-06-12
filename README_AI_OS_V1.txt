MeatBiz AI Operating Center V1
=============================

Bản này gộp backend + frontend để chạy thực tế, giao diện đơn giản.

Có gì mới:
- Dashboard có AI Operating Center gọn, dễ dùng.
- AI tự tóm tắt điều hành hôm nay.
- AI cảnh báo hàng dưới ngưỡng.
- Nút "Lập nháp nhập hàng" tạo draft phiếu mua hàng thật.
- Nút "Xác nhận tạo phiếu" mới ghi purchase_orders / purchase_order_items.
- Vẫn giữ nguyên rule: AI không ghi DB trực tiếp, chỉ gọi Business Service.

SQL cần chạy:
backend/sql/V6_61_AI_INVENTORY_PREDICTION_SUPPLIER_ORDER.sql
backend/sql/V6_62_AI_SUPPLIER_ORDERING_V2_REAL.sql
backend/sql/V6_62_TEST_SUPPLIER_MAPPING_SEED.sql
backend/sql/V6_63_AI_SUPPLIER_ORDERING_SCHEMA_COMPAT.sql

Nếu MySQL cũ không hiểu ADD COLUMN IF NOT EXISTS, dùng file tương thích bạn đã có:
V6_63_AI_SUPPLIER_ORDERING_SCHEMA_COMPAT_FIXED.sql

Backend:
cd backend
npm install
npm start

Frontend:
cd frontend
npm install --legacy-peer-deps
npm run dev

Build frontend đã kiểm tra OK bằng npm run build.

Test API:
curl -X POST "http://localhost:4000/api/ai/chat" \
  -H "Content-Type: application/json; charset=utf-8" \
  --data-binary '{"session_id":"A001","message":"tom tat dieu hanh hom nay"}'

