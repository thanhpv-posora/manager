# AI Inventory Chat

Now `/api/ai/chat` supports inventory questions:

```text
còn bao nhiêu gà
còn gà bao nhiêu
kiểm tra tồn kho vịt
tồn kho gà
sản phẩm nào sắp hết
hết hàng chưa
```

It routes to InventorySkill and uses:

- `inventoryService.getInventorySummary`
- `inventoryService.getLowStockProducts`

## Test

```bash
curl -X POST "http://localhost:4000/api/ai/chat" \
  -H "Content-Type: application/json" \
  -d '{"message":"còn bao nhiêu gà"}'
```

```bash
curl -X POST "http://localhost:4000/api/ai/chat" \
  -H "Content-Type: application/json" \
  -d '{"message":"sản phẩm nào sắp hết"}'
```
