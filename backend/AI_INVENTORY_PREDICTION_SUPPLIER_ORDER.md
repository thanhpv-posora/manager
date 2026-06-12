# MeatBiz AI Inventory Prediction + Supplier Ordering

## New endpoints

### 1. Inventory prediction

```bash
curl "http://localhost:4000/api/ai/inventory/prediction?lookback_days=14&forecast_days=7"
```

Purpose:
- Read recent sales from `orders + order_items`.
- Calculate average daily sale by product.
- Forecast stock after N days.
- Mark risk: `OK`, `LOW_SOON`, `OUT_SOON`.

### 2. Supplier order suggestion

```bash
curl "http://localhost:4000/api/ai/suppliers/suggest-orders?lookback_days=14&forecast_days=7&safety_days=3"
```

Purpose:
- Suggest order quantities for `TRACK_STOCK` products only.
- Does not write purchase lots.
- Business user still confirms supplier purchase manually.

## Chat examples

```bash
curl -X POST "http://localhost:4000/api/ai/chat" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d '{"session_id":"A001","message":"dự báo tồn kho 7 ngày tới"}'

curl -X POST "http://localhost:4000/api/ai/chat" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d '{"session_id":"A001","message":"nên nhập hàng gì tuần tới"}'
```

## Important fix

Older MeatBiz builds used `inventory_mode = STOCK`.
Production business rule uses `TRACK_STOCK`.

This build treats `STOCK` as `TRACK_STOCK` in code and adds migration:

`sql/V6_61_AI_INVENTORY_PREDICTION_SUPPLIER_ORDER.sql`
