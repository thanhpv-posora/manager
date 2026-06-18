# MeatBiz Backend V53 - Voice POS Customer-first Multi-item Parser

## Fixed

- Voice POS now resolves the customer name from the beginning of the sentence using the real `customers` table.
- Supports real customer names such as `Hồng Hiền`, `Chiến`, `Tú Hương A`, `Thúy`, etc. without hard-coding.
- After resolving the customer, only the remaining text is parsed as products.
- Supports multiple items in one sentence:
  - `Chiến xương ống 10 kg nạm 20 kg đùi 10 kg`
  - Expected result:
    - Customer: `Chiến`
    - Items: `Xg ống 10kg`, `Nạm 20kg`, `Đùi 10kg`
- Runs deterministic parser before OpenAI NLU so a new bill is not misclassified as `ADD_ITEM`.
- New order speech replaces old draft state instead of appending old items.
- Stops auto-creating product aliases from AI voice input to avoid alias pollution.
- Adds server log line `[VOICE_POS_PARSE]` with raw message, customer, and parsed items.

## Deploy

1. Replace backend source.
2. Run:
   ```bash
   npm install
   node --check src/services/chat.service.js
   node --check src/services/order.service.js
   ```
3. Run SQL:
   ```text
   sql/V53_VOICE_POS_CUSTOMER_FIRST_MULTI_ITEM.sql
   ```
4. Restart backend container.

## Test

```bash
curl -X POST "http://localhost:4000/api/ai/chat" \
  -H "Content-Type: application/json; charset=utf-8" \
  --data-binary '{"session_id":"TEST_V53","message":"Chiến xương ống 10 kg nạm 20 kg đùi 10 kg"}'
```
