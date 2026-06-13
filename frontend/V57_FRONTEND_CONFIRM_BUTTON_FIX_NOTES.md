# V57 Frontend Confirm Button Fix

Fix AI Voice POS confirm button:

- `Xác nhận lưu` no longer calls `/api/ai/chat`.
- It now calls `/api/ai/orders/confirm-draft` directly.
- Separate states:
  - `sending` for `Gửi AI`
  - `confirmSaving` for `Xác nhận lưu`
  - `listening` for mic
- Buttons use `type="button"` to prevent accidental form submit.
- Confirm button will show its own loading text: `Đang lưu...`.

Main file changed:

- `src/components/ai/AIVoicePOSPanel.jsx`

Build was verified before removing `dist` and `node_modules`.
