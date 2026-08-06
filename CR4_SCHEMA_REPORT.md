# CR-4 — Schema Reproducibility Report

**Status:** Implemented, **Phase 4 fresh-database rehearsal NOT EXECUTED (blocked)**
**Commits:** `7677531` (schema reconciliation), `b6b1cd6` (verification + fixtures)
**Audited against:** `8583521`
**Date:** 2026-08-06

---

## 1. Root cause

A fresh installation did not reproduce the schema the current code expects.

Only `ensureSchema()` runs at boot (`backend/src/server.js:106`):

```
validateStartupConfig() -> ensureSchema() -> refreshQuantityDecimalPlaces() -> app.listen()
```

`SchemaMigrationAgent.migrate()` and `AutoMigrationAgent.run()` are **ADMIN-triggered HTTP
endpoints** (`POST /api/schema/migrate`, `POST /api/migrations/run`), not part of boot. Schema
ownership was split across four places:

| Source | Tables created | Runs when |
|---|---|---|
| `config/bootstrap.js` | 58 | every boot |
| `SchemaMigrationAgent.migrate()` | 1 (+ many columns/indexes) | ADMIN presses "Chạy migration" |
| `AutoMigrationAgent.run()` | 5 | ADMIN triggers `/api/migrations/run` |
| Inline DDL in business agents | 3 | first time a business method is called |
| **No code path at all** | **10** | never — only a hand-run `.sql` file |

The supported fresh-install path is therefore `ensureSchema()` → `migrate()` → `check()`, and
anything outside it was absent on a clean database.

---

## 2. Schema inventory

Live snapshot of `meat_business_db` (read-only, `INFORMATION_SCHEMA`):

| Object | Count |
|---|---|
| Tables | 69 |
| Columns | 850 |
| Indexes | 230 |
| Foreign keys | 37 |
| Generated columns | 4 |

---

## 3. Drift classification

Per the CR-4 rule, only **class A (REQUIRED — current code reads/writes it)** was implemented.

### A — REQUIRED (implemented)

| Object | Evidence | Consequence before the fix |
|---|---|---|
| `payment_allocations` | `PaymentAgent.insertPaymentAllocationSafe()`, `OrderAgent.cancel()`, `loadPaymentHistory()` | Every access `ER_NO_SUCH_TABLE`-guarded → no crash, but allocations silently unrecorded **and** the "bill already paid" cancel guard collapsed to zero, allowing **a paid bill to be cancelled** |
| `payment_transaction_requests` | `PaymentAgent.getIdempotentResult()/beginIdempotentRequest()/finishIdempotentRequest()` | Existed in **no environment, live included**. Payment idempotency was a silent no-op everywhere — a duplicate "thu tiền" submit was never deduplicated |
| `payment_unapplied_credits` | `PaymentAgent.insertUnappliedCredit()`, `allocateExistingCreditsToOpenBills()` | Created lazily by `CREATE TABLE` **on the transaction connection**; MySQL DDL forces an implicit COMMIT, committing the enclosing payment mid-flight |
| `customer_account_registrations` | `RegistrationAgent` (9 methods) | Created per request; a fresh install's definition diverged from live |
| `auth_event_logs` | `RegistrationAgent.logEvent()` | Same |
| `ai_action_logs` | `aiErrorLog.service.js` | `tableExists()`-guarded → AI action logging silently dead |
| `ai_error_logs` | `aiErrorLog.service.js`, `aiBugInvestigator.service.js` | Same — the first diagnostic trail an operator reaches for |
| `sales_returns.status`, `.return_reason_code`, `sales_return_items.disposition_type`, `sales_return_inspections.quality_result` | `ReturnAgent.inspect()` | **ENUM live, VARCHAR in bootstrap.** The live ENUM lacks `RESTOCK`, which `inspect()` writes → `WARN_DATA_TRUNCATED`. The fresh install was correct; the **live** schema was broken |
| 5 price-book/price-category indexes | created by `migrate()` | Created but never in `check()` — a partially-migrated install reported a clean bill of health |

### B — LEGACY (excluded: live, but no current caller)

`customer_groups`, `electronic_invoices`, `payment_methods`, `product_purchase_options`,
`purchase_order_templates`, `purchase_order_template_items`, `system_settings`.

### C — SUPERSEDED (excluded)

`migration_history` — created by `AutoMigrationAgent`, absent live because `run()` was never
triggered. No current code reads it.

### D — REQUIRES CTO DECISION (excluded, not implemented)

**The 37 live foreign keys — none is defined by any code path.**

- **34 are `NO ACTION`** — pure integrity constraints. No code behavior depends on them, and the
  CR-4 rule "do not add objects only because they exist in the live DB" applies. A fresh install
  will not have them.
- **3 are `ON DELETE CASCADE`** and are a genuine open question:
  `order_items → orders`, `purchase_order_items → purchase_orders`,
  `purchase_order_template_items → purchase_order_templates`.
  Application code deletes children explicitly today, so no *current* caller relies on the
  cascade — but a fresh install silently loses the DB-level backstop.

**Decision needed:** adopt the 37 FKs into `bootstrap.js` for true live-parity, or accept and
document that a fresh install has no FK constraints. Not implemented, to avoid guessing.

---

## 4. Changes made

### `backend/src/config/bootstrap.js` (+203)
Seven required tables now created by `ensureSchema()`, matching live DDL exactly so fresh and
upgraded installs converge. Idempotent `safeAddColumn()` upgrade paths for the
`payment_allocations` cash/bank split and the 17 additive registration columns.

### `backend/src/agents/SchemaMigrationAgent.js` (+98)
- ENUM → VARCHAR reconciliation for the four sales-return columns, guarded on the live
  `COLUMN_TYPE` so it is a no-op once converted. Widening only — every existing ENUM value stays
  valid, no row can lose data. Same `MODIFY COLUMN` precedent as `customers.price_mode`.
- New `columnType()` helper backing **type-level** checks: existence alone reports OK on a
  drifted ENUM column, which is exactly the failure being closed.
- `check()` grew **38 → 67 entries**, all OK.

### `backend/src/agents/PaymentAgent.js` (−52/+18)
Removed `ensurePaymentUnappliedCreditsTable()` and `ensurePaymentAllocationSplitColumns()` and
their four call sites. No DDL on the request path.

### `backend/src/agents/RegistrationAgent.js` (−79/+6)
Removed `ensureSchema()`/`ensureColumn()` and their nine call sites — previously 2 `CREATE TABLE`s
plus 17 `INFORMATION_SCHEMA` probes on **every** registration, login, verification and approval
request.

**No business agent or service contains DDL any more**, enforced by a static scan in the
verification script.

---

## 5. Verification

### Executed — green

| Gate | Result |
|---|---|
| `verify-p0-cr4-schema-reproducibility.js` | **25/25** |
| Phase 5 — `migrate()` twice on existing schema | 10 statements, **0 errors** both runs; column+index snapshot byte-identical; business rows unchanged (orders 5, payments 3, customers 58, products 76, stock_tx 113) |
| `ensureSchema()` idempotency | second run changed no table/column/index |
| `SchemaMigrationAgent.check()` | **67/67 OK** |
| `GET /api/schema/check` | 200, 67 entries, 0 missing |
| `GET /api/audit-logs` | 200 ADMIN / 403 CUSTOMER |
| Startup check, frontend build, `git diff --check` | pass |

### NOT executed — Phase 4 fresh-database rehearsal

**Blocker.** No disposable MySQL is reachable from this machine:

- `docker: command not found`
- No local MySQL — no binaries, no service, nothing listening on `127.0.0.1:3306`
- `meat@%` holds `ALL PRIVILEGES ON meat_business_db.*` only →
  `CREATE DATABASE` returns `ER_DBACCESS_DENIED_ERROR`
- Visible schemas: `information_schema`, `meat_business_db`, `performance_schema`

Phase 4 explicitly forbids destructive reset testing against the shared
`192.168.10.204` database, and no alternative exists.

**The rehearsal script is written, committed and its safety guards are execution-verified.**
It refuses without an explicit target (exit 2), refuses when the target equals `DB_NAME`
(exit 2), refuses a non-empty target, re-checks `SELECT DATABASE()` after pointing the pool,
and never issues `CREATE DATABASE` or `DROP DATABASE`.

To unblock, provide any one of:

```sql
-- Option A: let the existing account create a throwaway schema
CREATE DATABASE meatbiz_cr4_rehearsal
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON meatbiz_cr4_rehearsal.* TO 'meat'@'%';
FLUSH PRIVILEGES;
```

- **Option B:** credentials to any throwaway MySQL 8 instance
- **Option C:** Docker Desktop or a local MySQL on this machine

Then run:

```bash
cd backend
CR4_FRESH_DB=meatbiz_cr4_rehearsal node scripts/verify-p0-cr4-fresh-db-rehearsal.js
```

Expected: `ensureSchema()` → `migrate()` (0 errors) → `check()` 67/67 → required
tables/columns present → second `migrate()` a no-op.

---

## 6. Behavior change to sign off

Creating `payment_transaction_requests` **activates payment idempotency for the first time** on
the next boot. This is existing code working as designed — no new logic — but duplicate payment
submissions will now be deduplicated where previously they silently were not.

---

## 7. Verdict

CR-4's code is complete and every gate that does not require an empty database is green.
**CR-4 cannot be signed off until the Phase 4 rehearsal runs**, because "a fresh install
reproduces the schema" is precisely the claim that has not been executed — and shipping schema
code that has never run against an empty database is the exact failure mode CR-4 exists to fix.
