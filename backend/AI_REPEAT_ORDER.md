# MeatBiz AI Repeat Order

New supported chat commands:

```text
HongHien lấy như hôm qua
HongHien như bữa trước
HongHien lặp lại bill gần nhất
```

Flow:

1. AI finds the latest non-deleted order of the customer within the last 30 days.
2. AI copies its order_items into a new draft.
3. User can edit draft: `thêm 1 Gau`, `bỏ Bon`, `đổi Nam 3`.
4. User confirms: `ok lưu`.

The old order is not modified.

Also supports accented Vietnamese: `HongHien lấy như hôm qua`.
