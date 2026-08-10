#!/usr/bin/env bash
#
# MeatBiz — production database backup.
#
# Takes a consistent, compressed logical backup of the MySQL database and
# prunes old backups according to the retention policy. Designed to be run
# unattended from cron. See docs/backup.md.
#
#   ./scripts/backup.sh                 # uses backend/.env
#   BACKUP_DIR=/srv/backups ./scripts/backup.sh
#
# Exit codes: 0 ok · 1 config/precondition error · 2 backup failed
#
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${ENV_FILE:-${REPO_ROOT}/backend/.env}"

log()  { printf '[backup] %s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
fail() { printf '[backup] ERROR: %s\n' "$*" >&2; exit "${2:-1}"; }

# ── Configuration ────────────────────────────────────────────────────────────
# Read DB_* from backend/.env without sourcing it (the file may contain values
# that are not shell-safe). Only the keys we need are extracted.
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
DB_NAME="${DB_NAME:-$(read_env DB_NAME)}"

BACKUP_DIR="${BACKUP_DIR:-${REPO_ROOT}/backups}"

# Retention policy — see docs/backup.md. Override via environment.
RETAIN_DAILY="${RETAIN_DAILY:-14}"     # keep every daily backup for N days
RETAIN_WEEKLY="${RETAIN_WEEKLY:-8}"    # keep Sunday backups for N weeks
RETAIN_MONTHLY="${RETAIN_MONTHLY:-12}" # keep 1st-of-month backups for N months

[ -n "${DB_HOST:-}" ]     || fail "DB_HOST is not set (env or ${ENV_FILE})"
[ -n "${DB_USER:-}" ]     || fail "DB_USER is not set (env or ${ENV_FILE})"
[ -n "${DB_NAME:-}" ]     || fail "DB_NAME is not set (env or ${ENV_FILE})"
[ -n "${DB_PASSWORD:-}" ] || fail "DB_PASSWORD is not set (env or ${ENV_FILE})"
DB_PORT="${DB_PORT:-3306}"

command -v mysqldump >/dev/null 2>&1 || fail "mysqldump not found in PATH"
command -v gzip      >/dev/null 2>&1 || fail "gzip not found in PATH"

# ── Credential handling ──────────────────────────────────────────────────────
# Never pass the password on the command line: it is visible in `ps` to every
# user on the host. Use a private defaults-file instead, removed on exit.
DEFAULTS_FILE="$(mktemp "${TMPDIR:-/tmp}/meatbiz-backup.XXXXXX")"
chmod 600 "$DEFAULTS_FILE"
DECOMP_TMP=""
cleanup() { rm -f "$DEFAULTS_FILE" "$DECOMP_TMP"; }
trap cleanup EXIT INT TERM

cat > "$DEFAULTS_FILE" <<EOF
[client]
host=${DB_HOST}
port=${DB_PORT}
user=${DB_USER}
password=${DB_PASSWORD}
EOF

# ── Backup ───────────────────────────────────────────────────────────────────
mkdir -p "$BACKUP_DIR"
STAMP="$(date '+%Y%m%d-%H%M%S')"
DOW="$(date '+%u')"   # 1..7, 7 = Sunday
DOM="$(date '+%d')"

TAG="daily"
[ "$DOW" = "7" ]  && TAG="weekly"
[ "$DOM" = "01" ] && TAG="monthly"

OUT="${BACKUP_DIR}/meatbiz-${DB_NAME}-${STAMP}-${TAG}.sql.gz"
TMP_OUT="${OUT}.partial"

log "database=${DB_NAME} host=${DB_HOST}:${DB_PORT} tag=${TAG}"
log "writing ${OUT}"

# --single-transaction  : consistent snapshot without locking InnoDB tables,
#                         so the POS keeps serving while the backup runs.
# --routines --triggers --events : schema objects the app relies on.
# --set-gtid-purged=OFF : keeps the dump restorable into a different server.
# --no-tablespaces      : avoids needing the PROCESS privilege.
if ! mysqldump --defaults-file="$DEFAULTS_FILE" \
      --single-transaction \
      --quick \
      --routines --triggers --events \
      --default-character-set=utf8mb4 \
      --set-gtid-purged=OFF \
      --no-tablespaces \
      "$DB_NAME" 2>"${TMP_OUT}.err" | gzip -9 > "$TMP_OUT"; then
  log "mysqldump failed:"
  sed 's/^/[backup]   /' "${TMP_OUT}.err" >&2 || true
  rm -f "$TMP_OUT" "${TMP_OUT}.err"
  fail "backup failed — no file written" 2
fi
rm -f "${TMP_OUT}.err"

# A gzip stream that does not decompress is worthless; verify before publishing.
if ! gzip -t "$TMP_OUT" 2>/dev/null; then
  rm -f "$TMP_OUT"
  fail "backup archive failed gzip integrity test — discarded" 2
fi

# GO-LIVE BLOCKER 3 fix: the content checks below used to pipe straight from
# `gzip -dc "$TMP_OUT" | head -n 200 | grep -qi ...`. Under this script's own
# `set -o pipefail` (line 14), the instant `head`/`grep -q` is satisfied and
# closes its end of the pipe, the still-writing `gzip -dc` process gets
# SIGPIPE and exits 141 — pipefail then reports the WHOLE pipeline as failed
# even though the check itself succeeded. A real, multi-thousand-line dump
# hits this every time; a tiny hand-crafted test archive never does (gzip
# finishes writing before head/grep are satisfied), which is why this went
# unnoticed until an actual backup was taken. Decompressing once into a plain
# file and checking THAT sidesteps the whole early-close-vs-still-writing
# race — nothing downstream of a file already on disk can ever SIGPIPE
# anything.
DECOMP_TMP="$(mktemp "${TMPDIR:-/tmp}/meatbiz-backup-check.XXXXXX")"
gzip -dc "$TMP_OUT" > "$DECOMP_TMP"

# The dump must actually contain the schema, not just a header.
if ! grep -qi 'CREATE TABLE' "$DECOMP_TMP"; then
  rm -f "$TMP_OUT"
  fail "backup contains no CREATE TABLE statement — discarded" 2
fi

# mysqldump writes this marker as its final line only on a clean run; its
# absence means the dump was truncated (disk full, killed process) — same
# check restore.sh --verify already made on the read side; made here too now
# so a truncated backup is never even written to disk in the first place.
if ! tail -n 5 "$DECOMP_TMP" | grep -q 'Dump completed'; then
  rm -f "$TMP_OUT"
  fail "backup has no 'Dump completed' marker — dump was truncated, discarded" 2
fi

TABLES="$(grep -c '^CREATE TABLE' "$DECOMP_TMP" || true)"

mv "$TMP_OUT" "$OUT"
chmod 600 "$OUT"

SIZE="$(du -h "$OUT" | cut -f1)"
log "OK — ${SIZE}, ${TABLES} tables"

# ── Retention ────────────────────────────────────────────────────────────────
# Prune by tag so weekly/monthly copies outlive the daily window.
prune() {
  local tag="$1" days="$2" removed=0
  while IFS= read -r -d '' f; do
    rm -f "$f" && removed=$((removed + 1))
  done < <(find "$BACKUP_DIR" -maxdepth 1 -type f \
             -name "meatbiz-${DB_NAME}-*-${tag}.sql.gz" \
             -mtime "+${days}" -print0 2>/dev/null)
  [ "$removed" -gt 0 ] && log "retention: removed ${removed} ${tag} backup(s) older than ${days}d"
  return 0
}

prune daily   "$RETAIN_DAILY"
prune weekly  "$((RETAIN_WEEKLY * 7))"
prune monthly "$((RETAIN_MONTHLY * 31))"

REMAINING="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name "meatbiz-${DB_NAME}-*.sql.gz" | wc -l | tr -d ' ')"
log "done — ${REMAINING} backup(s) retained in ${BACKUP_DIR}"
