# V17 - AI Voice POS Save Production Fix

## Mục tiêu
- AI Voice POS không chỉ tạo draft, mà nút "Xác nhận lưu" gọi backend confirm và lưu bill vào DB.
- Sau khi lưu thành công, UI hiển thị mã bill, tổng tiền, đã thu, công nợ.
- Không xoá/sửa POS thủ công cũ.

## Flow
1. AI tạo `CREATE_ORDER_DRAFT` và backend lưu nháp trong `ai_chat_sessions` theo `session_id`.
2. Frontend bấm "Xác nhận lưu".
3. Frontend gọi `/api/ai/chat` với `message: "ok"`, `confirm: true`, cùng `session_id`.
4. Backend lấy nháp mới nhất và gọi `orderService.confirmOrderDraft()`.
5. Backend ghi:
   - `orders`
   - `order_items`
   - `stock_transactions` qua inventory service
   - `debt_transactions`
   - `payments` nếu là khách vãng lai có thu tiền
6. UI báo "ĐÃ LƯU BILL".

## Test nhanh
```bash
curl -X POST "http://localhost:4000/api/ai/chat" \
  -H "Content-Type: application/json; charset=utf-8" \
  --data-binary '{"session_id":"POS_VOICE_001","message":"Hong Hien xg suon 5 ky bup 3 ky gau 2 ky","customer_type":"REGULAR"}'
```

Sau đó:
```bash
curl -X POST "http://localhost:4000/api/ai/chat" \
  -H "Content-Type: application/json; charset=utf-8" \
  --data-binary '{"session_id":"POS_VOICE_001","message":"ok","confirm":true}'
```

## Lưu ý
- Khách thường: lưu bill công nợ, không ép thu tiền.
- Khách vãng lai: phải thu đủ tiền mới lưu.
