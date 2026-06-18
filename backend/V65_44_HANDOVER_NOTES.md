# MeatBiz V65.44 - Production-safe fixes

## 1. Payment allocation / Print repair

Changed:
- `src/agents/OrderAgent.js`
  - `loadOrderPaymentAllocations()` now reads `payment_allocations` first.
  - If the allocation table exists but a historical bill has no allocation rows, it falls back to direct `payments.order_id` rows so A4/K80 does not show an empty payment section for old bills.
- `sql/V65_44_PRICE_BOOK_VERSIONING_AND_ALLOCATION_PRINT_FIX.sql`
  - Ensures `payment_allocations.cash_amount` and `payment_allocations.bank_amount` exist.

Production rule:
- New allocation rows remain source of truth.
- Legacy direct payment fallback is only for older data without allocation rows.

## 2. Customer price book versioning

Added:
- `customer_price_books`
- `customer_price_book_items`
- `src/services/PriceBookService.js`

Changed:
- `OrderAgent.create()` resolves missing item prices through `PriceBookService` using the bill shipping date (`order_date` after lunar/solar mapping), then freezes the price in `order_items.sale_price`.
- `OrderAgent.addItem()` uses price book price for added existing products.
- `ProductAgent.customerProducts()` and `PriceMatrixAgent` display effective price book price first, then legacy customer price, then default price.
- `ProductAgent.updateCustomerPrice()` creates a new price book version instead of updating the old active row.
- `PriceMatrixAgent.saveMatrix()` creates a new customer price book version instead of rewriting active prices.

Fallback order:
1. `customer_price_books` / `customer_price_book_items` by effective date
2. `customer_product_prices`
3. `products.default_sale_price`

## 3. Migration order

Run this SQL once before deploying backend:

```sql
SOURCE sql/V65_44_PRICE_BOOK_VERSIONING_AND_ALLOCATION_PRINT_FIX.sql;
```

Then deploy backend and restart Docker service.

## 4. Verification checklist

1. Create two unpaid bills for the same customer with older/newer shipping dates.
2. Collect one payment less than total debt.
3. Confirm `payment_allocations` has one row per receiving bill.
4. Print A4/K80 for both bills and confirm each bill shows only the amount allocated to that bill.
5. Change one customer/product price effective today.
6. Create a new bill and confirm `order_items.sale_price` stores the new price.
7. Print an older bill and confirm its historical `order_items.sale_price` did not change.


## V65.44.1 fixes

- Fixed `Data truncated for column price_type` when new price book returns `PRICE_BOOK`.
- Migration now expands `order_items.price_type` enum to include `PRICE_BOOK`.
- Migration adds nullable `order_items.price_book_id` for traceability of the price version used by a bill item.
- Order creation has a backward-compatible fallback: if production DB has not migrated yet, it stores `PRIVATE_PRICE` instead of crashing.
- Price matrix save now accepts arbitrary effective date: `effective_from`, `effectiveFrom`, or `apply_date`. This supports multiple price changes inside the same month due to market fluctuation.
