# MeatBiz V65.26 - Backend Lunar/Solar Bill Date Guard

- Added `src/utils/lunarDate.js` for server-side lunar to solar conversion.
- `OrderAgent.create()` now derives `orders.order_date` from `calendar_type + lunar_date_text` when calendar is LUNAR.
- `SupplierAgent.createLot()` now derives `purchase_lots.purchase_date` from `calendar_type + lunar_date_text` when calendar is LUNAR.
- PrintService now shows created date and business bill date separately for POS and NCC printouts.
