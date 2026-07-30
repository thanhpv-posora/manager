# Backup & Rollback Notes — Non-Master Data Reset

## Required backup, before anything else

Engine confirmed: **MySQL 8.0.35**. Use `mysqldump` for a full logical backup.

```
mysqldump \
  --host=<DB_HOST> \
  --port=<DB_PORT> \
  --user=<DB_USER> \
  --password \
  --single-transaction \
  --routines \
  --triggers \
  --events \
  <DB_NAME> > backup_before_reset_<YYYYMMDD_HHMM>.sql
```

Notes:
- `--password` with no value prompts interactively — do not put the password on the command line or in this file.
- `--single-transaction` takes a consistent InnoDB snapshot without locking tables (safe against the live application while the backup runs).
- `--routines --triggers --events` are included for completeness even though this audit found none exist (§2 of the audit report) — harmless if empty, and future-proofs the backup if any are added later.
- Replace `<DB_HOST>`, `<DB_PORT>`, `<DB_USER>`, `<DB_NAME>` with the real values from the environment being targeted (see `backend/.env` for the values already in use by the application — do not copy the password itself into this backup command or any file).
- Store the resulting `.sql` file somewhere outside the application server, with a clear retention policy — it contains full business data.

## Restore (rollback) from this backup, if ever needed

```
mysql \
  --host=<DB_HOST> \
  --port=<DB_PORT> \
  --user=<DB_USER> \
  --password \
  <DB_NAME> < backup_before_reset_<YYYYMMDD_HHMM>.sql
```

This restores the **entire** schema to its pre-reset state (Master Data and transactional data both) — it is a full point-in-time rollback, not a selective one.

## In-transaction rollback (during the reset itself)

`reset_non_master_data.sql` wraps its DELETE statements in a single `START TRANSACTION` / `COMMIT`. If any statement errors, or the Step 3 post-delete verification counts inside that script look wrong, run:

```sql
ROLLBACK;
```

instead of the script's `COMMIT` line. This undoes everything the script did in that run, with no need to restore from the `mysqldump` backup at all — the backup is the fallback for *after* a commit has already happened and a mistake is discovered later.

## After a reset: restoring demo data (optional, Phase 4)

If a testable dataset is needed after running `reset_non_master_data.sql`, the backup/rollback guarantees above still apply unchanged — `restore_demo_data.sql` only adds new, clearly-marked `DEMO_`/"DEMO - " rows, and does not touch or depend on anything deleted by the reset. See `audit_non_master_data_reset.md` §14 step 6 for the full sequence (`restore_demo_data.sql` → `../scripts/restore-demo-opening-stock.js` → `demo_smoke_test_checklist.md`). None of these have been executed.

## What the backup does NOT protect against

- Running the OPTIONAL inventory-balance section (`UPDATE products SET stock_quantity = 0 ...`) is also wrapped in its own transaction in the script, so the same in-transaction `ROLLBACK` applies to it directly if run in the same session before committing.
- The backup is only as current as the moment it was taken — any real business activity (a real order, a real payment) that happens on the live system *after* the backup but *before* the reset would not be restorable from it. This is why the dry-run review and reset execution should happen as close together as practical, ideally with the application taken offline or use restricted during the window.
