# MeatBiz Domain Model V1

## Core Business Flow

Supplier → Purchase Lot → Inventory → PriceBook → POS Bill → Debt → Payment → Report

## Core Entities

### Customer
A customer may also be a distributor who has their own customers. Therefore customer hierarchy is a first-class domain model.

Hierarchy example:

Root Company
→ Customer A
→ Customer A child shop
→ Customer A sub-customer

### Product
Product represents sellable item. Future design separates global catalog and scoped customer catalog.

### PriceBook
PriceBook is a versioned pricing agreement between company and customer. It has effective date and calendar type.

### Bill / Order
Bill is the commercial transaction record. Historical bill lines are immutable after confirmation.

### Payment
Payment is money received. It allocates to bills and may create unapplied credit. Payment must not rewrite bill history.

### Debt
Debt is derived from sales, payments, adjustments, and installments.

### Inventory
Inventory is stock movement history. Strategic model is ledger + snapshot.

### AI Session
AI sessions represent draft or assistant work. AI drafts are not business records until confirmed.
