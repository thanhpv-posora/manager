# V56 - Voice POS Confirm Save Diagnostic Fix

Fixed the remaining `Xác nhận lưu` issue where draft creation worked but saving appeared to load forever or return no visible result.

Changes:
- Confirm can now use `draft_session_id` when frontend sends it.
- Confirm can still use `session_id` for backward compatibility.
- Added safe fallback: if frontend confirms with mismatched session_id and there is exactly one recent DRAFT, backend confirms that draft.
- Added logs:
  - `[AI_CONFIRM_DRAFT]` when saving starts
  - `[AI_CONFIRM_DRAFT_AMBIGUOUS]` if multiple DRAFTs exist and backend refuses to choose randomly
  - `[AI_CHAT_CONFIRM_DRAFT_AMBIGUOUS]` for `/api/ai/chat` confirm path
- Response now includes `message: Đã lưu bill thành công.` and `draft_session_id`.
- Kept V53 parser behavior; no parser rollback from V54.

Recommended test:
1. Create draft:
```bash
curl -X POST http://localhost:4000/api/ai/chat \
  -H "Content-Type: application/json" \
  --data-binary '{"session_id":"POS_NO_CUSTOMER","message":"Chiến xương ống 20 kg nạm 10 kg đùi 15 kg"}'
```

2. Confirm via chat:
```bash
curl -X POST http://localhost:4000/api/ai/chat \
  -H "Content-Type: application/json" \
  --data-binary '{"session_id":"POS_NO_CUSTOMER","message":"xong"}'
```

3. Or confirm via endpoint:
```bash
curl -X POST http://localhost:4000/api/ai/orders/confirm-draft \
  -H "Content-Type: application/json" \
  --data-binary '{"session_id":"POS_NO_CUSTOMER"}'
```

If still not saving, check:
```bash
docker logs meatbiz-api --tail 300 2>&1 | grep -i -E "AI_CONFIRM|confirmOrderDraft|AI chat error|Unknown column|Data truncated|Khách|giá|inventory"
```
