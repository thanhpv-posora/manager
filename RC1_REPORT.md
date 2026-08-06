# MeatBiz — RC1 Readiness Report

**Date:** 2026-08-06
**Branch:** `main`
**Verdict:** 🔴 **NOT READY FOR RC1 (v1.0.0)** — 3 blockers, none of them code
**Commits pushed this sprint:** none (see §6)

---

## 1. Verdict

All six sprint tasks are implemented and every verification that can be executed
in this environment is green — **604 automated assertions, 0 failures**. RC1 is
nonetheless **not** signable today, because three things cannot be verified or
completed from this machine, and each is a genuine Go-Live risk rather than
paperwork.

| # | Blocker | Owner | Effort |
|---|---|---|---|
| **B1** | `JWT_SECRET` is still the value published in the **public** GitHub repo | Ops | ~5 min + forced re-login |
| **B2** | CR-4 fresh-database rehearsal never executed — no disposable MySQL | Ops/DBA | ~15 min once a DB exists |
| **B3** | Backup/restore round trip never executed — no `mysqldump`/`mysql` on this host | Ops | ~20 min on the deploy host |

Per the sprint rule *"Push only after every verification is green"* and
*"stop before pushing and clearly report the blocker"*, **nothing was pushed**.
Seven commits are staged locally on `main`.

---

## 2. What shipped this sprint

| Task | Commit | Status |
|---|---|---|
| 1. CR-4 completion + report | `7c59dc8` | Code complete; Phase 4 **unverified** (B2) |
| 2. Backup / restore + docs + retention | `5095e8d` | Complete; round trip **unverified** (B3) |
| 3. `/api/health` — status, DB, version, uptime, 503 | `c826271` | ✅ Verified |
| 4. Log rotation / retention | `393dde6` | ✅ Verified |
| 5. Full regression | — | ✅ Green |
| 6. This report | *(this commit)* | ✅ |

Carried in from earlier in the day and also unpushed: `7677531`, `b6b1cd6`
(CR-4 schema reconciliation and its verification).

### Unpushed commit stack

```
RC1_REPORT.md                                    <- this commit
393dde6 feat(logging): add log retention to bound disk growth
c826271 feat(health): report db, version and uptime; 503 when db is down
5095e8d feat(ops): add production backup and restore tooling
7c59dc8 docs(p0-cr4): add schema reproducibility report
b6b1cd6 test(p0-cr4): add fresh database schema verification
7677531 fix(p0-cr4): reconcile base schema and migrations
--------------------------------------------------------- origin/main = 8583521
```

---

## 3. Blockers in detail

### B1 — Live `JWT_SECRET` is published in a public repository 🔴

`github.com/thanhpv-posora/manager` is **public** (anonymous GitHub API returns
`visibility: public`). The `JWT_SECRET` committed in `backend/.env.example` is
**byte-identical** to the live value, and remains so as of this report — the
startup warning fired on every boot during this sprint:

```
[STARTUP WARNING] JWT_SECRET is set to a value that is published in this repository...
```

Anyone on the internet can forge a valid token for any user or role. This is not
theoretical: this sprint's own authorization tests mint ADMIN tokens with
exactly that secret.

Scrubbing the file (`36cddb8`) does **not** undo the disclosure — the value is in
3 commits of public history (earliest `72e9b2d`, 2026-06-06).

**Action:**
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
# put the result in backend/.env on every environment, then restart
```
Rotating invalidates all sessions — every user must log in again. Also rotate the
GCP Document AI credentials and confirm whether the mail password was ever the
committed one.

**Do not go live before this is done.**

### B2 — CR-4 fresh-database rehearsal not executed 🔴

CR-4's whole claim is *"a clean database reproduces the schema the code
expects."* That claim has **never been executed**. This machine has no Docker, no
local MySQL (nothing on `127.0.0.1:3306`), and `meat@%` holds
`ALL PRIVILEGES ON meat_business_db.*` only, so `CREATE DATABASE` returns
`ER_DBACCESS_DENIED_ERROR`.

Shipping schema code that has never run against an empty database is precisely
the failure mode CR-4 exists to fix.

**Action:**
```sql
CREATE DATABASE meatbiz_cr4_rehearsal CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON meatbiz_cr4_rehearsal.* TO 'meat'@'%';
FLUSH PRIVILEGES;
```
```bash
cd backend && CR4_FRESH_DB=meatbiz_cr4_rehearsal node scripts/verify-p0-cr4-fresh-db-rehearsal.js
```
Expected: `ensureSchema()` → `migrate()` (0 errors) → `check()` 67/67 → required
tables/columns present → second `migrate()` a no-op. See `CR4_SCHEMA_REPORT.md`.

### B3 — Backup/restore round trip not executed 🟠

`mysqldump` and `mysql` are not installed on this machine, so a real dump-and-
restore cycle has not run. The **safety logic** is fully tested (12/12), but
"the script refuses bad archives" is not the same as "we can restore the
business."

**Action:** run `docs/backup.md` §6 on the deployment host. A rehearsal passes
only if the restored copy returns `/api/health` `ok:true` **and**
`/api/schema/check` with zero `MISSING`. Note §7: the current DB account cannot
create the rehearsal schema either.

---

## 4. Verification results

### Executed — all green

| Suite | Result |
|---|---|
| Backend startup check | OK |
| Frontend production build | clean (2559 modules) |
| `git diff --check` | clean |
| Clean boot of final code + `/api/health` | 200 `healthy`, db connected, 3 ms |
| `GET /api/schema/check` | 200 — **67 entries, 0 missing** |
| `GET /api/audit-logs` | 200 ADMIN / 403 CUSTOMER |
| Product/category authorization (live HTTP) | 39/39 |
| `verify-health-endpoint` | 21/21 |
| `verify-log-rotation` | 18/18 |
| `verify-backup-restore` | 12/12 |
| `verify-p0-cr2-env-example-scrubbed` | 25/25 |
| `verify-p0-cr3-db-config-fail-closed` | 31/31 |
| `verify-p0-cr4-schema-reproducibility` | 25/25 |
| `verify-p0-001-order-qty-edit-stock-guard` | 25/25 |
| `verify-p0-002-sales-flow-no-price-book` | 8/8 |
| `verify-p0-004-report-customer-scope` | 19/19 |
| `verify-order-cancel-reversal` | 65/65 |
| `verify-golive-payment-cancel` | 46/46 |
| `verify-p2-02-receive-reversal` | 40/40 |
| `verify-inventory-adjustment` | 31/31 |
| `verify-inventory-reconciliation` | 41/41 |
| `verify-inventory-policy-extraction` | 44/44 |
| `verify-sales-return-foundation` | 62/62 |
| `verify-p1-01a-return-guards` | 20/20 |
| `verify-partner-supplier-sync` | 22/22 |
| `verify-price-matrix-category-sales-flow-ui` | 23/23 |
| `verify-price-matrix-sales-flow-filter` | 19/19 |
| `verify-customer-inherited-sales-flow` | 16/16 |
| `verify-order-item-quantity-and-ai-confirm-inventory` | 25/25 |
| Migration idempotency (`migrate()` ×2) | 0 errors, schema identical, business rows unchanged |

**Total: 604 assertions, 0 failures.**

### Not executed

| Gate | Why |
|---|---|
| CR-4 fresh-DB rehearsal | B2 — no disposable MySQL |
| Backup/restore round trip | B3 — no `mysqldump`/`mysql` client |
| CR-7 sales-return warehouse smoke test | Manual UI test, never performed |

### Known red, pre-existing, out of scope

`verify-mixed-sales-dual-price-category.js` and
`verify-product-sales-flow-separation.js` abort in
`PriceMatrixAgent.createCustomerPriceCategory` with
`CUSTOMER_DEFAULT_SALES_FLOW_REQUIRED`. Both fail **identically on the pre-P0
baseline `db45c88`**, confirmed in a clean worktree — not a regression. They need
per-scenario sales-flow assignment (a P0-002 fixture redesign), not a one-line
fix: setting a single customer default just moves the failure to
`PRICE_CATEGORY_SALES_FLOW_MISMATCH`. Flagged for a dedicated follow-up.

---

## 5. Go-Live posture

### Critical findings from the audit

| ID | Finding | Status |
|---|---|---|
| CR-1 | `/api/ai/*` unauthenticated | ✅ Fixed (`487e343`) |
| CR-2 | Secrets committed to git | ⚠️ File scrubbed (`36cddb8`) — **rotation outstanding (B1)** |
| CR-3 | DB pool fell back to `root`@localhost | ✅ Fixed (`8583521`) |
| CR-4 | Schema drift / not reproducible | ⚠️ Code complete — **rehearsal outstanding (B2)** |
| CR-5 | Negative stock on order-qty edit | ✅ Fixed (`a05cc96`) |
| CR-6 | Sales-flow bypass without price book | ✅ Fixed (`1fde3bf`) |
| CR-7 | Sales-return warehouse UI | ✅ Shipped — smoke test outstanding |
| CR-8 | `audit_logs` unreadable | ✅ Shipped (verified 200/403) |

### High findings addressed this sprint

- **H-5** backup/restore — ✅ delivered (B3 to rehearse)
- **H-6** log rotation — ✅ delivered and verified
- **M-11** DB-aware health check — ✅ delivered and verified

### Still open (not Go-Live blocking, schedule post-launch)

- **H-2** `ALLOW_PLAIN_PASSWORD=true` still the default in `.env.example`
- **H-4** no Docker/compose packaging
- **CR-4/D** the 37 live foreign keys are defined by **no code path**; a fresh
  install gets none. 34 are `NO ACTION`; 3 are `ON DELETE CASCADE`. Needs a
  decision — see `CR4_SCHEMA_REPORT.md` §3.
- `ALLOWED_ORIGINS` is unset in the current environment; it is **fatal in
  production** by design (CR-3), so it must be set before the production boot.

### Behavior change requiring sign-off

Creating `payment_transaction_requests` (CR-4) **activates payment idempotency
for the first time**. Existing code working as designed — no new logic — but
duplicate payment submissions will now be deduplicated where previously they
silently were not. Expect this to change behavior on the first double-submit.

---

## 6. Recommendation

**Do not tag v1.0.0 today.**

Sequence to RC1, roughly 40 minutes of ops work:

1. **Rotate `JWT_SECRET`** on every environment; restart; confirm the startup
   warning is gone. *(B1 — the only one that is a live security exposure.)*
2. **Grant a rehearsal schema** and run the CR-4 fresh-DB rehearsal. *(B2)*
3. **Run the backup/restore rehearsal** on the deployment host. *(B3)*
4. Set `ALLOWED_ORIGINS` for production.
5. Re-run the full regression, then **push the 7 commits**.
6. Perform the CR-7 manual smoke test.
7. Tag `v1.0.0`.

Steps 1–3 are ops actions I cannot perform from this environment and deliberately
did not fake. Everything else is done, verified and waiting.
