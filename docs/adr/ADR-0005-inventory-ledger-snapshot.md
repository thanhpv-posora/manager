# ADR-0005: Inventory Ledger + Snapshot

## Decision
Strategic inventory design is append-only ledger plus snapshot.

## Reason
Direct stock update risks race conditions and weak auditability.

## Consequence
Products.stock_quantity becomes snapshot/cache, not source of truth.
