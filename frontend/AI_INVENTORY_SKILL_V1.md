# MeatBiz AI InventorySkill v1

## What changed

Integrated InventorySkill into AI order confirmation.

When AI confirms an order:

1. Validate inventory by `products.inventory_mode`
2. Insert order + order_items
3. Apply inventory movement
4. Insert stock_transactions
5. Return `inventory_results`

## Rules

- `NON_STOCK`
  - no stock check
  - no stock deduct

- `TRACK_STOCK`
  - check stock
  - if `allow_negative_stock = 0`, block oversell
  - deduct `products.stock_quantity`
  - insert `stock_transactions` OUT / SALE

- `CARCASS_PART`
  - no blocking stock check
  - deduct and log OUT / SALE for future carcass/yield analysis

## New endpoints

```text
GET /api/ai/inventory/summary
GET /api/ai/inventory/summary?q=ga
GET /api/ai/inventory/low-stock
```

## Test

```bash
curl "http://localhost:4000/api/ai/inventory/summary"
curl "http://localhost:4000/api/ai/inventory/low-stock"
```
