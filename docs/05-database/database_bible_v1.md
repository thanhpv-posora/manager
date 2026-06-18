# MeatBiz Database Bible V1

## Principles

1. Financial tables must be auditable.
2. Historical bill data is immutable.
3. Price history must be versioned.
4. Inventory must move toward append-only ledger.
5. Migrations must be ordered and traceable.

## Strategic Tables

- customers: hierarchy and billing calendar
- products: global catalog
- customer_price_books: versioned price header
- customer_price_book_items: versioned price lines
- orders: bill header
- order_items: immutable bill detail after confirmation
- payments: receipt header
- payment_allocations: payment-to-bill allocations
- debt_transactions: debt ledger
- stock_transactions: inventory ledger

## Technical Debt

- `target_debt_amount` exists in multiple places but business meaning is unclear.
- legacy `customer_product_prices` must be migrated to PriceBook.
- scattered migration logic must be consolidated.
