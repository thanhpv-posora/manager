# V52 Voice POS Done + Multi Item Fix

Fix chính:

- Nói `xong`, `kết thúc`, `hoàn thành` sẽ được hiểu là xác nhận/lưu nháp hiện tại.
- Parser không còn dừng ở item đầu tiên.
- Câu `Chiến xương ống 10 kg đùi 20 kg` phải parse thành 2 item:
  - Xương ống 10 kg
  - Đùi 20 kg
- Khi có nhiều số lượng trong cùng câu, parser bỏ single-item mode và chạy multi-item mode.
- `hasOrderItems()` nhận cả dạng product-first: `xương ống 10 kg`.

File chính đã sửa:

- `src/services/chat.service.js`

Test đề xuất:

```bash
curl -X POST "http://localhost:4000/api/ai/chat" \
  -H "Content-Type: application/json; charset=utf-8" \
  --data-binary '{"session_id":"VOICE_TEST_01","message":"Chiến xương ống 10 kg đùi 20 kg"}'

curl -X POST "http://localhost:4000/api/ai/chat" \
  -H "Content-Type: application/json; charset=utf-8" \
  --data-binary '{"session_id":"VOICE_TEST_01","message":"xong"}'
```
