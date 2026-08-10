#!/usr/bin/env bash
#
# MeatBiz — restore a database backup produced by scripts/backup.sh.
#
# DESTRUCTIVE. Restoring replaces the entire contents of the target database.
# Guarded accordingly: it refuses to touch the configured production database
# unless you both name the target explicitly and confirm.
#
#   ./scripts/restore.sh --list
#   ./scripts/restore.sh --verify backups/meatbiz-...-daily.sql.gz
#   ./scripts/restore.sh --into meatbiz_restore_test backups/meatbiz-...sql.gz
#   ./scripts/restore.sh --into meat_business_db --i-understand-this-is-destructive backups/...
#
# Exit codes: 0 ok · 1 config/precondition error · 2 restore failed · 3 refused
#
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${ENV_FILE:-${REPO_ROOT}/backend/.env}"

log()  { printf '[restore] %s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
fail() { printf '[restore] ERROR: %s\n' "$*" >&2; exit "${2:-1}"; }

read_env() {
  local key="$1"
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//p" "$ENV_FILE" \
    | head -n 1 | sed -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//'
}

DB_HOST="${DB_HOST:-$(read_env DB_HOST)}"
DB_PORT="${DB_PORT:-$(read_env DB_PORT)}"
DB_USER="${DB_USER:-$(read_env DB_USER)}"
DB_PASSWORD="${DB_PASSWORD:-$(read_env DB_PASSWORD)}"
PROD_DB="$(read_env DB_NAME)"
BACKUP_DIR="${BACKUP_DIR:-${REPO_ROOT}/backups}"

TARGET_DB=""
ARCHIVE=""
MODE="restore"
CONFIRMED=0

# GO-LIVE BLOCKER 3 fix: registered once, here, before either temp file can
# possibly exist — verify_archive() (below) can run twice in one invocation
# (once for --verify, again from the --into path before it restores), and
# DEFAULTS_FILE is created later still in the --into path. A single trap
# covering both by name (rm -f on an empty/unset var is a safe no-op) means
# neither call site needs its own `trap ... EXIT` that would otherwise
# silently replace this one, since bash traps don't stack.
DEFAULTS_FILE=""
DECOMP_TMP=""
trap 'rm -f "$DEFAULTS_FILE" "$DECOMP_TMP"' EXIT INT TERM

usage() {
  cat <<'USAGE'
Usage:
  restore.sh --list                          List available backups.
  restore.sh --verify <archive>              Integrity-check an archive. Never writes.
  restore.sh --into <db> <archive>           Restore into <db>.
      --i-understand-this-is-destructive     Required when <db> is the production database.

Environment: DB_HOST DB_PORT DB_USER DB_PASSWORD (default: backend/.env), BACKUP_DIR
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --list)   MODE="list"; shift ;;
    --verify) MODE="verify"; ARCHIVE="${2:-}"; shift 2 ;;
    --into)   TARGET_DB="${2:-}"; shift 2 ;;
    --i-understand-this-is-destructive) CONFIRMED=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) ARCHIVE="$1"; shift ;;
  esac
done

# ── list ─────────────────────────────────────────────────────────────────────
if [ "$MODE" = "list" ]; then
  [ -d "$BACKUP_DIR" ] || fail "no backup directory at ${BACKUP_DIR}"
  log "backups in ${BACKUP_DIR}:"
  find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.sql.gz' -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | cut -d' ' -f2- \
    | while IFS= read -r f; do printf '  %s  %s\n' "$(du -h "$f" | cut -f1)" "$f"; done
  exit 0
fi

[ -n "$ARCHIVE" ] || { usage; fail "no archive given"; }
[ -f "$ARCHIVE" ] || fail "archive not found: ${ARCHIVE}"

# ── verify ───────────────────────────────────────────────────────────────────
# Integrity check only: decompresses the stream and inspects it. Never connects
# to a database, never writes. Safe to run against a production backup at any
# time, and is what makes the retention policy meaningful.
verify_archive() {
  log "verifying ${ARCHIVE}"
  gzip -t "$ARCHIVE" 2>/dev/null || fail "gzip integrity test FAILED" 2
  log "  gzip integrity: OK"

  # GO-LIVE BLOCKER 3 fix: every check below used to pipe fresh from
  # `gzip -dc "$ARCHIVE"` per check, including into `grep -q` (which exits
  # the instant it finds a match). Under this script's own `set -o pipefail`
  # (line 16), that early exit sends SIGPIPE to the still-writing `gzip -dc`
  # process, which then exits 141 — pipefail reports the whole pipeline as
  # failed even though the check itself (grep finding the table) succeeded.
  # A real archive (thousands of lines) hits this reliably; the tiny
  # synthetic archives verify-backup-restore.sh's safety-logic tests use
  # never did, which is why this went unnoticed. Decompressing once into a
  # plain file and grepping THAT for every check sidesteps the whole
  # early-close-vs-still-writing race — nothing downstream of a file already
  # on disk can ever SIGPIPE anything. DECOMP_TMP is a script-scope var
  # (declared near the top, not `local`) cleaned up by the single trap
  # registered there, so this stays safe across both calls to this function.
  DECOMP_TMP="$(mktemp "${TMPDIR:-/tmp}/meatbiz-restore-verify.XXXXXX")"
  gzip -dc "$ARCHIVE" > "$DECOMP_TMP"

  local tables
  tables="$(grep -c '^CREATE TABLE' "$DECOMP_TMP" || true)"
  [ "$tables" -gt 0 ] || fail "archive contains no CREATE TABLE statements" 2
  log "  CREATE TABLE statements: ${tables}"

  # mysqldump writes this marker as its final line only on a clean run; its
  # absence means the dump was truncated (disk full, killed process).
  if tail -n 5 "$DECOMP_TMP" | grep -q 'Dump completed'; then
    log "  completion marker: OK"
  else
    fail "archive has no 'Dump completed' marker — dump was truncated" 2
  fi

  for t in orders order_items payments customers products stock_transactions; do
    grep -q "^CREATE TABLE \`${t}\`" "$DECOMP_TMP" \
      || fail "core table missing from archive: ${t}" 2
  done
  log "  core tables present: OK"
  rm -f "$DECOMP_TMP"
  log "VERIFY OK — ${ARCHIVE}"
}

if [ "$MODE" = "verify" ]; then verify_archive; exit 0; fi

# ── restore ──────────────────────────────────────────────────────────────────
[ -n "$TARGET_DB" ] || { usage; fail "--into <db> is required"; }

# The refusal comes FIRST — before credential and tooling checks. "I will not
# do this" must short-circuit ahead of "can I do this", or on a host without a
# mysql client the operator gets a confusing missing-binary error instead of
# the guard, and learns nothing about the destructive action they just asked
# for.
if [ "$TARGET_DB" = "$PROD_DB" ] && [ "$CONFIRMED" -ne 1 ]; then
  printf '[restore] REFUSED: %s is the configured production database.\n' "$TARGET_DB" >&2
  printf '[restore] Restoring REPLACES ALL DATA in it. Re-run with --i-understand-this-is-destructive\n' >&2
  printf '[restore] if that is genuinely what you intend. Prefer restoring into a scratch database first.\n' >&2
  exit 3
fi

[ -n "${DB_HOST:-}" ] && [ -n "${DB_USER:-}" ] && [ -n "${DB_PASSWORD:-}" ] \
  || fail "DB_HOST/DB_USER/DB_PASSWORD not set (env or ${ENV_FILE})"
DB_PORT="${DB_PORT:-3306}"
command -v mysql >/dev/null 2>&1 || fail "mysql client not found in PATH"

# Always integrity-check before touching the target: a truncated archive that
# is already halfway applied is far worse than a refused restore.
verify_archive

DEFAULTS_FILE="$(mktemp "${TMPDIR:-/tmp}/meatbiz-restore.XXXXXX")"
chmod 600 "$DEFAULTS_FILE"
cat > "$DEFAULTS_FILE" <<EOF
[client]
host=${DB_HOST}
port=${DB_PORT}
user=${DB_USER}
password=${DB_PASSWORD}
EOF

mysql_do() { mysql --defaults-file="$DEFAULTS_FILE" "$@"; }

mysql_do -e "SELECT 1" >/dev/null 2>&1 || fail "cannot connect to ${DB_HOST}:${DB_PORT}" 2

EXISTS="$(mysql_do -N -B -e \
  "SELECT COUNT(*) FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME='${TARGET_DB}'")"
if [ "$EXISTS" = "0" ]; then
  log "target ${TARGET_DB} does not exist — creating"
  mysql_do -e "CREATE DATABASE \`${TARGET_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci" \
    || fail "could not create ${TARGET_DB} (needs CREATE privilege)" 2
else
  ROWS="$(mysql_do -N -B -e \
    "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='${TARGET_DB}'")"
  log "target ${TARGET_DB} exists with ${ROWS} table(s) — the dump will overwrite them"
fi

log "restoring ${ARCHIVE} -> ${TARGET_DB} on ${DB_HOST}:${DB_PORT}"
if ! gzip -dc "$ARCHIVE" | mysql_do --default-character-set=utf8mb4 "$TARGET_DB"; then
  fail "restore FAILED — ${TARGET_DB} may be in a partial state" 2
fi

TABLES="$(mysql_do -N -B -e \
  "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='${TARGET_DB}' AND TABLE_TYPE='BASE TABLE'")"
log "restored — ${TARGET_DB} now has ${TABLES} table(s)"
[ "$TABLES" -gt 0 ] || fail "restore produced zero tables" 2

for t in orders payments customers products; do
  C="$(mysql_do -N -B -e \
    "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='${TARGET_DB}' AND TABLE_NAME='${t}'")"
  [ "$C" = "1" ] || fail "core table ${t} missing after restore" 2
done
log "core tables verified"
log "RESTORE OK"
log "Next: point the app at ${TARGET_DB} and run 'npm run check', then GET /api/health."
