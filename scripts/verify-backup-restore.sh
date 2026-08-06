#!/usr/bin/env bash
#
# Verifies the SAFETY LOGIC of backup.sh / restore.sh without needing a
# database. It builds synthetic archives covering the ways a backup actually
# goes wrong in production and asserts restore.sh --verify accepts the good one
# and rejects every bad one.
#
# The point: "the backup file exists" is not the same as "the backup is
# restorable". These are the checks that tell the difference.
#
#   ./scripts/verify-backup-restore.sh
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESTORE="${SCRIPT_DIR}/restore.sh"
BACKUP="${SCRIPT_DIR}/backup.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/meatbiz-bkptest.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM

pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  [PASS] %s\n' "$1"; }
bad()  { fail=$((fail+1)); printf '  [FAIL] %s\n' "$1"; }
check(){ if [ "$1" = "0" ]; then ok "$2"; else bad "$2 (got exit $3)"; fi; }

CORE_TABLES="orders order_items payments customers products stock_transactions"

# A structurally faithful mysqldump archive.
make_good() {
  local out="$1"
  {
    echo "-- MySQL dump 10.13  Distrib 8.0.35"
    echo "-- Host: db    Database: meat_business_db"
    echo "SET NAMES utf8mb4;"
    for t in $CORE_TABLES; do
      echo "DROP TABLE IF EXISTS \`${t}\`;"
      echo "CREATE TABLE \`${t}\` ("
      echo "  \`id\` bigint NOT NULL AUTO_INCREMENT,"
      echo "  PRIMARY KEY (\`id\`)"
      echo ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;"
    done
    echo "-- Dump completed on $(date '+%Y-%m-%d %H:%M:%S')"
  } | gzip -9 > "$out"
}

echo "=== backup/restore safety logic ==="
echo
echo "-- 1. a sound archive is accepted --"
GOOD="${WORK}/good.sql.gz"
make_good "$GOOD"
"$RESTORE" --verify "$GOOD" >/dev/null 2>&1
check "$?" "sound archive passes --verify" "$?"

echo
echo "-- 2. corrupted archives are rejected --"

# (a) Not a valid gzip stream — truncated transfer / bad disk.
CORRUPT="${WORK}/corrupt.sql.gz"
printf 'this is not gzip data at all' > "$CORRUPT"
"$RESTORE" --verify "$CORRUPT" >/dev/null 2>&1; rc=$?
[ "$rc" -ne 0 ] && ok "corrupt gzip stream rejected" || bad "corrupt gzip stream was ACCEPTED"

# (b) Valid gzip, but no schema — e.g. mysqldump wrote only an error.
EMPTY="${WORK}/empty.sql.gz"
printf -- '-- MySQL dump\nERROR 1045: Access denied\n' | gzip -9 > "$EMPTY"
"$RESTORE" --verify "$EMPTY" >/dev/null 2>&1; rc=$?
[ "$rc" -ne 0 ] && ok "archive with no CREATE TABLE rejected" || bad "no-schema archive was ACCEPTED"

# (c) Truncated mid-dump: disk filled or the process was killed. This is the
#     dangerous one — it looks like a real backup and restores partial data.
TRUNC="${WORK}/truncated.sql.gz"
{
  echo "-- MySQL dump 10.13  Distrib 8.0.35"
  for t in $CORE_TABLES; do
    echo "CREATE TABLE \`${t}\` (\`id\` bigint NOT NULL) ENGINE=InnoDB;"
  done
  echo "INSERT INTO \`orders\` VALUES (1),(2),(3"
} | gzip -9 > "$TRUNC"
"$RESTORE" --verify "$TRUNC" >/dev/null 2>&1; rc=$?
[ "$rc" -ne 0 ] && ok "truncated dump (no completion marker) rejected" || bad "truncated dump was ACCEPTED"

# (d) Complete dump that is missing a core table — wrong --databases filter.
PARTIAL="${WORK}/partial.sql.gz"
{
  echo "-- MySQL dump 10.13"
  echo "CREATE TABLE \`orders\` (\`id\` bigint NOT NULL) ENGINE=InnoDB;"
  echo "-- Dump completed on $(date '+%Y-%m-%d %H:%M:%S')"
} | gzip -9 > "$PARTIAL"
"$RESTORE" --verify "$PARTIAL" >/dev/null 2>&1; rc=$?
[ "$rc" -ne 0 ] && ok "dump missing core tables rejected" || bad "incomplete dump was ACCEPTED"

echo
echo "-- 3. destructive-restore guard --"
# Restoring into the configured production DB must be refused without the
# explicit flag. Exit 3 = refused.
PROD_DB="$(sed -n 's/^[[:space:]]*DB_NAME[[:space:]]*=[[:space:]]*//p' \
           "${SCRIPT_DIR}/../backend/.env" 2>/dev/null | head -n1 | tr -d '\r')"
if [ -n "$PROD_DB" ]; then
  "$RESTORE" --into "$PROD_DB" "$GOOD" >/dev/null 2>&1; rc=$?
  [ "$rc" -eq 3 ] && ok "restore into production DB refused (exit 3)" \
                  || bad "production restore NOT refused (exit ${rc})"
else
  echo "  [SKIP] no DB_NAME in backend/.env to test the production guard"
fi

# A missing archive must fail before anything else happens.
"$RESTORE" --into scratch_db "${WORK}/does-not-exist.sql.gz" >/dev/null 2>&1; rc=$?
[ "$rc" -ne 0 ] && ok "missing archive rejected" || bad "missing archive was ACCEPTED"

# --verify must never require or touch a database.
"$RESTORE" --verify "$GOOD" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 0 ] && ok "--verify works with no DB connection" || bad "--verify needed a DB"

echo
echo "-- 4. no credential is ever exposed on a command line --"
for f in "$BACKUP" "$RESTORE"; do
  if grep -qE -- '-p\$\{?DB_PASSWORD|--password=\$' "$f"; then
    bad "$(basename "$f") passes the password on the command line"
  else
    ok "$(basename "$f") uses a defaults-file, not a CLI password"
  fi
done

echo
echo "-- 5. scripts are syntactically valid --"
bash -n "$BACKUP"  && ok "backup.sh parses"  || bad "backup.sh has a syntax error"
bash -n "$RESTORE" && ok "restore.sh parses" || bad "restore.sh has a syntax error"

echo
echo "${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ] || exit 1
