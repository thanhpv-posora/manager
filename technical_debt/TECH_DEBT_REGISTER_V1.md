# MeatBiz Technical Debt Register V1

## TD-001 - target_debt_amount unused

Observed on multiple tables but no clear logic reads/writes it.

Action: decide meaning or deprecate with migration plan.

## TD-002 - Mixed migration mechanisms

bootstrap.js, AutoMigrationAgent, SchemaMigrationAgent, and inline DDL overlap.

Action: create canonical migration history.

## TD-003 - Backend mirror inside frontend/src

Backend-like source exists under frontend tree.

Action: verify if stale. Remove if not required.

## TD-004 - Payment update revert/reapply

Risky for money movement.

Action: move to cancel + replacement model.

## TD-005 - AI session TTL missing

Draft sessions may accumulate and stale confirmations may occur.

Action: add expiry/cleanup.

## TD-006 - Direct stock update

`products.stock_quantity` directly updated.

Action: ledger/snapshot model.
