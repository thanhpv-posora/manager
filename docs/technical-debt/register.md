# Technical Debt Register

## TD-0001 target_debt_amount unused
Appears in many tables but lacks clear business implementation. Decide whether to remove, document, or implement.

## TD-0002 payment_transaction_requests table uncertainty
PaymentAgent expects idempotency table. Ensure canonical migration creates it.

## TD-0003 frontend contains backend mirror
Frontend source tree appears to contain backend-like files. Confirm if intentional; otherwise remove to reduce maintenance risk.

## TD-0004 mixed schema management
bootstrap.js, AutoMigrationAgent, and inline DDL overlap. Need V70 migration governance.
