# Technical Debt Register

## TD-0001 target_debt_amount unused
Appears in many tables but lacks clear business implementation. Decide whether to remove, document, or implement.

## TD-0002 payment_transaction_requests table uncertainty
PaymentAgent expects idempotency table. Ensure canonical migration creates it.

## TD-0003 frontend contains backend mirror
Frontend source tree appears to contain backend-like files. Confirm if intentional; otherwise remove to reduce maintenance risk.

## TD-0004 mixed schema management
bootstrap.js, AutoMigrationAgent, and inline DDL overlap. Need V70 migration governance.

## TD-0005 supplier records can be created from two paths
Suppliers can be created via SupplierAgent's direct CRUD (Suppliers.jsx, P2-01) or via
CustomerAgent._syncPartnerToSupplier(), which auto-creates a `suppliers` row whenever a
customer is saved with partner_type=1 (Customers.jsx) and no existing row matches by
phone/name. The two paths use different rules (the auto-sync path never sets
male_price/female_price/fragment_price). CTO decision (P2-01 final review): accepted as
known technical debt, not blocking; not fixed in this story.
