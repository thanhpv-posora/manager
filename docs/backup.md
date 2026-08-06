# MeatBiz — Backup & Restore

Production database backup, retention and restore procedure.

Deployment style: plain Node + MySQL on a host (no containers). Backups are
logical `mysqldump` archives driven by cron.

---

## 1. Scripts

| Script | Purpose |
|---|---|
| `scripts/backup.sh` | Consistent compressed dump + retention pruning. Safe to run while the POS is serving. |
| `scripts/restore.sh` | List / verify / restore an archive. Refuses to overwrite production without an explicit flag. |

Both read `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` from
`backend/.env` (or the environment, which takes precedence).

**Credentials are never passed on the command line.** Both scripts write a
`chmod 600` temporary `--defaults-file` and delete it on exit, because a password
in `mysqldump -p…` is visible in `ps` to every user on the host.

---

## 2. Taking a backup

```bash
./scripts/backup.sh                      # -> ./backups/
BACKUP_DIR=/srv/meatbiz/backups ./scripts/backup.sh
```

Archive name:

```
meatbiz-<db>-<YYYYMMDD-HHMMSS>-<daily|weekly|monthly>.sql.gz
```

The tag is assigned automatically: `monthly` on the 1st, `weekly` on Sunday,
otherwise `daily`. This is what lets the retention policy keep long-horizon
copies without keeping every daily forever.

`mysqldump` runs with `--single-transaction`, so InnoDB tables are **not locked**
and the shop keeps trading during the backup. `--routines --triggers --events`
are included; `--set-gtid-purged=OFF` keeps the dump restorable onto a different
server.

### Backup is verified before it is published

A backup you cannot restore is not a backup. Before the file is given its final
name, `backup.sh` checks:

1. `mysqldump` exited 0
2. `gzip -t` passes
3. the dump actually contains `CREATE TABLE`

If any check fails the partial file is **deleted** and the script exits non-zero,
so a failed run can never masquerade as a good backup.

---

## 3. Retention policy

| Tier | Kept for | Override |
|---|---|---|
| Daily | **14 days** | `RETAIN_DAILY` |
| Weekly (Sunday) | **8 weeks** | `RETAIN_WEEKLY` |
| Monthly (1st) | **12 months** | `RETAIN_MONTHLY` |

Steady state ≈ 14 + 8 + 12 = **34 archives**. Pruning is per-tag, so a weekly or
monthly copy is never removed by the daily window.

Rationale: 14 days covers "someone noticed a bad edit last week"; 8 weeks covers
a quarter-end dispute; 12 months covers the Vietnamese tax year and the lunar
billing cycle the business runs on.

Retention is enforced on every run — no separate cleanup job to forget.

---

## 4. Scheduling (cron)

```cron
# Nightly at 01:30 — quiet hours for a meat business.
30 1 * * *  cd /srv/meatbiz && BACKUP_DIR=/srv/meatbiz/backups ./scripts/backup.sh >> /var/log/meatbiz-backup.log 2>&1

# Weekly restore rehearsal (see §6) — Monday 03:00.
0 3 * * 1   cd /srv/meatbiz && ./scripts/restore.sh --verify "$(ls -t /srv/meatbiz/backups/*.sql.gz | head -1)" >> /var/log/meatbiz-backup.log 2>&1
```

`backup.sh` exits non-zero on failure, so cron will email the failure. Do not
suppress that.

### Off-host copy — required

Backups on the same disk as the database do not survive the failure that
matters. After the nightly job, copy `BACKUP_DIR` off the host:

```bash
rclone sync /srv/meatbiz/backups remote:meatbiz-backups --max-age 30d
# or: rsync -az /srv/meatbiz/backups/ backup-host:/srv/meatbiz-backups/
```

---

## 5. Restoring

**Restoring replaces the entire contents of the target database.**

```bash
# 1. What do we have?
./scripts/restore.sh --list

# 2. Is the archive sound? (never connects to a DB, never writes)
./scripts/restore.sh --verify backups/meatbiz-meat_business_db-20260806-013000-daily.sql.gz

# 3. Restore into a scratch database first — always prefer this.
./scripts/restore.sh --into meatbiz_restore_test backups/meatbiz-...sql.gz

# 4. Only if you genuinely mean to overwrite production:
./scripts/restore.sh --into meat_business_db \
    --i-understand-this-is-destructive backups/meatbiz-...sql.gz
```

Safety behavior:

- Restoring into the database named in `backend/.env` is **refused (exit 3)**
  unless `--i-understand-this-is-destructive` is given.
- The archive is integrity-checked **before** the target is touched — a
  truncated archive half-applied is worse than a refused restore.
- After loading, the script re-counts tables and asserts `orders`, `payments`,
  `customers`, `products` all exist.

### Verification checks explained

`--verify` asserts four things:

1. **gzip integrity** — the stream decompresses.
2. **`CREATE TABLE` present** — it is a schema dump, not an error page.
3. **`Dump completed` marker** — `mysqldump` writes this as its last line only
   on a clean run. Its absence means the dump was truncated (disk full, killed
   process). This is the check that catches the backup that looks fine and is not.
4. **Core tables present** — `orders`, `order_items`, `payments`, `customers`,
   `products`, `stock_transactions`.

---

## 6. Restore rehearsal procedure

Run this monthly. An untested backup is a guess.

```bash
# 1. Restore the newest archive into a scratch database.
LATEST="$(ls -t backups/*.sql.gz | head -1)"
./scripts/restore.sh --into meatbiz_restore_test "$LATEST"

# 2. Point the app at the restored copy and confirm it boots and is healthy.
cd backend
DB_NAME=meatbiz_restore_test npm run check
DB_NAME=meatbiz_restore_test node src/server.js &
curl -fsS http://127.0.0.1:4000/api/health | tee /dev/stderr | grep -q '"ok":true'

# 3. Confirm the schema is complete against the restored copy.
#    Requires an ADMIN token.
curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" \
     http://127.0.0.1:4000/api/schema/check | grep -c '"status":"OK"'

# 4. Spot-check business data.
mysql -e "SELECT COUNT(*) orders, (SELECT COUNT(*) FROM payments) payments \
          FROM orders" meatbiz_restore_test

# 5. Tear down.
mysql -e "DROP DATABASE meatbiz_restore_test"
```

A rehearsal passes only if `/api/health` returns `ok:true` **and**
`/api/schema/check` reports zero `MISSING` entries.

---

## 7. Required privileges

The backup account needs `SELECT`, `LOCK TABLES`, `SHOW VIEW`, `EVENT`, `TRIGGER`
on the application database. `--no-tablespaces` is used so `PROCESS` (a global
privilege) is not required.

The restore account additionally needs `CREATE`, `DROP`, `INSERT`, `ALTER`, `INDEX`
and `REFERENCES` on the target, plus the global `CREATE` privilege if the script
must create the target database.

> **Current limitation.** The `meat@%` account used today holds
> `ALL PRIVILEGES ON meat_business_db.*` only. It **cannot create a new schema**
> (`CREATE DATABASE` → `ER_DBACCESS_DENIED_ERROR`), so the §6 rehearsal cannot be
> run with it as-is. Grant the rehearsal target explicitly before relying on this
> procedure:
>
> ```sql
> CREATE DATABASE meatbiz_restore_test
>   CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
> GRANT ALL PRIVILEGES ON meatbiz_restore_test.* TO 'meat'@'%';
> FLUSH PRIVILEGES;
> ```

---

## 8. Storage and handling

Archives contain **all customer data** — names, phones, addresses, debt and
pricing. Treat them as production data:

- `backup.sh` sets `chmod 600` on every archive.
- Keep `BACKUP_DIR` outside the web root and outside the git working tree.
  `backups/` is git-ignored.
- Encrypt before sending off-host if the destination is not already trusted
  (`age`, `gpg`, or the storage provider's server-side encryption).
- Deleting a customer from the app does not remove them from existing archives;
  retention expiry is what does.
