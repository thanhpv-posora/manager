# V65.45 - Price Matrix Frontend/Backend Sync

## Fix

- Frontend PriceMatrix now has `Ngày hiệu lực` date input.
- Import Excel price preview uses the same `effective_from` date before save.
- `PUT /price-matrix/:customerId` sends and receives `effective_from`.
- Backend saves new version into `customer_price_books` + `customer_price_book_items.sale_price`.
- Copy price matrix now copies from active price book version and creates a new price book for the target customer.
- Legacy `customer_product_prices` is kept only as fallback, not overwritten by copy/import save flow.

## Production rule

Changing price on any date closes the currently active price book at `effective_from - 1 day` and creates a new active version. Old orders keep `order_items.sale_price` unchanged.
