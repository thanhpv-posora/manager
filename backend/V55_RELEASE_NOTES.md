# V55 - Voice POS Parser Stable + Confirm Draft Fix

Built from V53 parser-stable backend, not from the broken V54 parser branch.

## Fixed

1. Keep V53 customer-first token parser:
   - `Chiến xương ống 20 kg nạm 10 kg đùi 15 kg`
   - resolves customer first from DB
   - parses all items after customer
   - exact alias first, no random fuzzy pick.

2. Fix confirm/save draft:
   - `/api/ai/chat` with `message: "xong"` confirms latest DRAFT for the same session_id.
   - `/api/ai/orders/confirm-draft` can now accept:
     - `{ "session_id": "POS_NO_CUSTOMER" }`
     - `{ "draft_session_id": 123 }`
     - or the full draft object for backward compatibility.

3. Create draft response now returns `draft_session_id`.

## Test

Create draft:

```bash
curl -X POST http://localhost:4000/api/ai/chat \
  -H "Content-Type: application/json" \
  --data-binary '{"session_id":"POS_NO_CUSTOMER","message":"Chiến xương ống 20 kg nạm 10 kg đùi 15 kg"}'
```

Confirm by chat:

```bash
curl -X POST http://localhost:4000/api/ai/chat \
  -H "Content-Type: application/json" \
  --data-binary '{"session_id":"POS_NO_CUSTOMER","message":"xong"}'
```

Confirm by endpoint:

```bash
curl -X POST http://localhost:4000/api/ai/orders/confirm-draft \
  -H "Content-Type: application/json" \
  --data-binary '{"session_id":"POS_NO_CUSTOMER"}'
```
