/**
 * CR-4 Phase 4 — fresh-database rehearsal.
 *
 * Proves that a COMPLETELY EMPTY database reaches the schema current code
 * expects, using only the supported mechanisms:
 *
 *     ensureSchema()  ->  SchemaMigrationAgent.migrate()  ->  check()
 *
 * ── REQUIRES A DISPOSABLE DATABASE ──────────────────────────────────────────
 * This script refuses to run against the configured application database. Give
 * it a dedicated empty schema:
 *
 *     CR4_FRESH_DB=meatbiz_cr4_rehearsal node scripts/verify-p0-cr4-fresh-db-rehearsal.js
 *
 * Optional overrides (default to the DB_* values in .env):
 *     CR4_FRESH_DB_HOST / CR4_FRESH_DB_PORT / CR4_FRESH_DB_USER / CR4_FRESH_DB_PASSWORD
 *
 * The target schema must already exist and must be empty — this script does
 * not CREATE DATABASE and never DROPs anything. Create it yourself:
 *     CREATE DATABASE meatbiz_cr4_rehearsal
 *       CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
 *
 * Safety: it hard-refuses if the target equals DB_NAME, and refuses if the
 * target already contains tables, so it can never touch a real database.
 */
require('dotenv').config();
const mysql = require('mysql2/promise');

const TARGET = process.env.CR4_FRESH_DB;
const APP_DB = process.env.DB_NAME;

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log('  [PASS] ' + msg); }
  else { fail++; console.log('  [FAIL] ' + msg); }
};

// Objects a fresh install must end up with. Kept in sync with
// verify-p0-cr4-schema-reproducibility.js.
const REQUIRED_TABLES = [
  'orders', 'order_items', 'payments', 'customers', 'products', 'stock_transactions',
  'payment_allocations', 'payment_transaction_requests', 'payment_unapplied_credits',
  'customer_account_registrations', 'auth_event_logs', 'ai_action_logs', 'ai_error_logs',
  'audit_logs', 'sales_returns', 'sales_return_items', 'sales_return_inspections',
  'debt_installment_payments', 'supplier_partner_map', 'inventory_receives',
  'supplier_purchase_payments', 'supplier_payable_transactions',
];

// Columns that only ever existed because a standalone .sql file was run by
// hand — the exact drift class CR-4 exists to close.
const REQUIRED_COLUMNS = [
  ['orders', 'is_locked'], ['orders', 'locked_at'], ['orders', 'locked_by'], ['orders', 'lock_note'],
  ['payments', 'status'], ['payments', 'is_locked'], ['payments', 'payment_calendar_type'],
  ['payments', 'original_amount'], ['payments', 'cancelled_at'],
  ['inventory_receives', 'cancelled_at'], ['stock_transactions', 'reversal_dedup_key'],
  ['supplier_purchase_payments', 'status'], ['supplier_purchase_payments', 'cancelled_at'],
];

async function main() {
  if (!TARGET) {
    console.error('CR4_FRESH_DB is not set — refusing to run.\n' +
      'This rehearsal needs a dedicated EMPTY database. See the header of this file.');
    process.exit(2);
  }
  if (TARGET === APP_DB) {
    console.error(`CR4_FRESH_DB (${TARGET}) is the application database — refusing.`);
    process.exit(2);
  }

  const cfg = {
    host: process.env.CR4_FRESH_DB_HOST || process.env.DB_HOST,
    port: Number(process.env.CR4_FRESH_DB_PORT || process.env.DB_PORT),
    user: process.env.CR4_FRESH_DB_USER || process.env.DB_USER,
    password: process.env.CR4_FRESH_DB_PASSWORD || process.env.DB_PASSWORD,
    database: TARGET,
  };

  console.log(`=== CR-4 Phase 4: fresh-database rehearsal (${TARGET}) ===\n`);

  // Guard: the target must be empty.
  {
    const probe = await mysql.createConnection(cfg);
    const [rows] = await probe.query(
      `SELECT COUNT(*) cnt FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=?`, [TARGET]);
    await probe.end();
    if (Number(rows[0].cnt) !== 0) {
      console.error(`${TARGET} already contains ${rows[0].cnt} tables — refusing. ` +
        'This rehearsal requires a genuinely empty schema.');
      process.exit(2);
    }
    console.log('  [PASS] target schema confirmed empty'); pass++;
  }

  // Point the app's pool at the disposable schema BEFORE anything imports it.
  process.env.DB_HOST = cfg.host;
  process.env.DB_PORT = String(cfg.port);
  process.env.DB_USER = cfg.user;
  process.env.DB_PASSWORD = cfg.password;
  process.env.DB_NAME = TARGET;

  const pool = require('../src/config/db');
  const { ensureSchema } = require('../src/config/bootstrap');
  const SchemaMigrationAgent = require('../src/agents/SchemaMigrationAgent');

  const [[who]] = await pool.query('SELECT DATABASE() db');
  ok(who.db === TARGET, `pool is connected to ${TARGET} (not the app database)`);
  if (who.db !== TARGET) { process.exit(2); }

  console.log('\n-- step 1: base initialization (ensureSchema) --');
  await ensureSchema();
  const [t1] = await pool.query(
    `SELECT COUNT(*) cnt FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=?`, [TARGET]);
  ok(Number(t1[0].cnt) > 0, `ensureSchema() created ${t1[0].cnt} tables from empty`);

  console.log('\n-- step 2: SchemaMigrationAgent.migrate() --');
  const r1 = await SchemaMigrationAgent.migrate();
  const errs1 = (r1.logs || []).filter(l => l.status === 'ERROR');
  for (const e of errs1) console.log(`      ERROR: ${e.message} :: ${String(e.sql).slice(0, 90)}`);
  ok(errs1.length === 0, `migrate() completed with no errors (${(r1.logs || []).length} statements)`);

  console.log('\n-- step 3: check() must be 100% OK --');
  const checks = await SchemaMigrationAgent.check();
  const missing = checks.filter(c => c.status !== 'OK');
  for (const c of missing) console.log(`      MISSING: ${c.table}.${c.column}`);
  ok(missing.length === 0, `check(): ${checks.length - missing.length}/${checks.length} OK`);

  console.log('\n-- step 4: required tables present --');
  for (const t of REQUIRED_TABLES) {
    const [r] = await pool.query(
      `SELECT COUNT(*) cnt FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?`,
      [TARGET, t]);
    ok(Number(r[0].cnt) > 0, `table ${t}`);
  }

  console.log('\n-- step 5: required columns present --');
  for (const [t, c] of REQUIRED_COLUMNS) {
    const [r] = await pool.query(
      `SELECT COUNT(*) cnt FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=?`, [TARGET, t, c]);
    ok(Number(r[0].cnt) > 0, `column ${t}.${c}`);
  }

  console.log('\n-- step 6: migrate() is idempotent (Phase 5) --');
  const before = await snapshot(pool, TARGET);
  const r2 = await SchemaMigrationAgent.migrate();
  const errs2 = (r2.logs || []).filter(l => l.status === 'ERROR');
  for (const e of errs2) console.log(`      ERROR: ${e.message} :: ${String(e.sql).slice(0, 90)}`);
  ok(errs2.length === 0, 'second migrate() run completed with no errors');
  const after = await snapshot(pool, TARGET);
  ok(before === after, 'second migrate() run created no duplicate table/column/index');
  const checks2 = await SchemaMigrationAgent.check();
  ok(checks2.filter(c => c.status !== 'OK').length === 0, 'check() still 100% OK after the second run');

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(`\nNOTE: ${TARGET} is left in place for inspection. Drop it yourself when done.`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

async function snapshot(pool, db) {
  const [c] = await pool.query(
    `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
       FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=?
      ORDER BY TABLE_NAME, COLUMN_NAME`, [db]);
  const [i] = await pool.query(
    `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
       FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=?
      ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`, [db]);
  return JSON.stringify({ c, i });
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
