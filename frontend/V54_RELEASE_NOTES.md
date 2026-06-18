# V54 - Confirm Create Order Draft Robust Fix

Fix trọng tâm:

- Nút xác nhận lưu `create-order-draft` có thể gửi nhiều dạng body khác nhau vẫn lưu được:
  - draft trực tiếp
  - `{ draft }`
  - `{ data: { draft } }`
  - `{ data: draft }`
  - `{ session_id }` để backend tự lấy nháp mới nhất trong `ai_chat_sessions`
- Nếu draft chưa đủ điều kiện lưu, backend trả lỗi rõ thay vì im lặng.
- Nếu chỉ gửi `session_id`, backend sẽ xác nhận pending draft mới nhất và mark `CONFIRMED`.
- Giữ nguyên parser customer-first/multi-item của V53.

Test nhanh:

```bash
curl -X POST http://localhost:4000/api/ai/chat \
  -H "Content-Type: application/json" \
  --data-binary '{"session_id":"POS_NO_CUSTOMER","message":"chiến xuong ống 10 kg đùi 20 kg"}'
```

Sau đó xác nhận bằng chat:

```bash
curl -X POST http://localhost:4000/api/ai/chat \
  -H "Content-Type: application/json" \
  --data-binary '{"session_id":"POS_NO_CUSTOMER","message":"xong"}'
```

Hoặc xác nhận qua API confirm-draft:

```bash
curl -X POST http://localhost:4000/api/ai/orders/confirm-draft \
  -H "Content-Type: application/json" \
  --data-binary '{"session_id":"POS_NO_CUSTOMER"}'
```
