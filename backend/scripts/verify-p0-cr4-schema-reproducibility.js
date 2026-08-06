/**
 * CR-4 verification — schema reproducibility guards.
 *
 * Runs against the CURRENT database. Additive and read-mostly: it calls
 * ensureSchema() (idempotent CREATE TABLE IF NOT EXISTS / safeAddColumn, the
 * same thing every server boot runs) and SchemaMigrationAgent.check() (pure
 * read). It never drops, truncates or mutates a business row.
 *
 * What it proves:
 *   1. Every table current code depends on exists and is created by a code
 *      path — not by a standalone .sql file run by hand.
 *   2. No business agent/service contains DDL any more: a required table must
 *      never be created lazily inside a business method or transaction.
 *   3. Every object SchemaMigrationAgent.migrate() creates has a matching
 *      check() entry (the self-review rule), verified by parsing migrate()'s
 *      own source rather than trusting a hand-maintained list.
 *   4. check() reports 100% OK against this database.
 *   5. ensureSchema() is idempotent — running it twice adds nothing.
 *
 * For the empty-database rehearsal see verify-p0-cr4-fresh-db-rehearsal.js.
 *
 * Run: node scripts/verify-p0-cr4-schema-reproducibility.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../src/config/db');
const { ensureSchema } = require('../src/config/bootstrap');
const SchemaMigrationAgent = require('../src/agents/SchemaMigrationAgent');

const SRC = path.resolve(__dirname, '..', 'src');

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log('  [PASS] ' + msg); }
  else { fail++; console.log('  [FAIL] ' + msg); }
};

// Tables current application code reads or writes and that must therefore be
// reproducible from a clean database. Each was verified to have a real caller.
const REQUIRED_TABLES = [
  'payment_allocations',
  'payment_transaction_requests',
  'payment_unapplied_credits',
  'customer_account_registrations',
  'auth_event_logs',
  'ai_action_logs',
  'ai_error_logs',
];

// Load-bearing constraints: application logic depends on the DB enforcing them.
const REQUIRED_UNIQUE_INDEXES = [
  ['payment_transaction_requests', 'uq_ptr_idempotency_key'],
];

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full, acc); }
    else if (e.name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

// Strip block and line comments so a comment mentioning "CREATE TABLE" does not
// count as DDL.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

async function tableExists(name) {
  const [r] = await pool.query(
    `SELECT COUNT(*) cnt FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?`, [name]);
  return Number(r[0].cnt) > 0;
}

async function indexExists(table, index) {
  const [r] = await pool.query(
    `SELECT COUNT(*) cnt, MIN(NON_UNIQUE) non_unique FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=?`, [table, index]);
  return { exists: Number(r[0].cnt) > 0, unique: Number(r[0].non_unique) === 0 };
}

async function main() {
  console.log('=== CR-4: schema reproducibility ===\n');

  console.log('-- 1. ensureSchema() creates every required table --');
  await ensureSchema();
  for (const t of REQUIRED_TABLES) {
    ok(await tableExists(t), `${t} exists after ensureSchema()`);
  }

  console.log('\n-- 2. load-bearing unique constraints present --');
  for (const [t, idx] of REQUIRED_UNIQUE_INDEXES) {
    const r = await indexExists(t, idx);
    ok(r.exists && r.unique, `${t}.${idx} exists and is UNIQUE`);
  }

  console.log('\n-- 3. no DDL left in business agents/services --');
  {
    const ddlRe = /\b(CREATE\s+TABLE|ALTER\s+TABLE|CREATE\s+INDEX|DROP\s+TABLE)\b/i;
    // config/bootstrap.js and the two migration agents are the sanctioned
    // schema owners; everything else must be DDL-free.
    const allowed = ['config/bootstrap.js', 'agents/SchemaMigrationAgent.js', 'agents/AutoMigrationAgent.js'];
    const offenders = [];
    for (const f of walk(SRC)) {
      const rel = path.relative(SRC, f).replace(/\\/g, '/');
      if (allowed.some(a => rel.endsWith(a.replace(/^.*\//, '')) && rel.includes(a.split('/')[0]))) continue;
      if (allowed.some(a => rel === a)) continue;
      if (ddlRe.test(stripComments(fs.readFileSync(f, 'utf8')))) offenders.push(rel);
    }
    ok(offenders.length === 0,
      offenders.length ? `business files still containing DDL: ${offenders.join(', ')}` : 'no business agent/service contains DDL');
  }

  console.log('\n-- 4. every index migrate() creates has a check() entry --');
  {
    const agentSrc = fs.readFileSync(path.join(SRC, 'agents', 'SchemaMigrationAgent.js'), 'utf8');
    const migrateBody = agentSrc.slice(agentSrc.indexOf('async migrate()'), agentSrc.indexOf('async check()'));
    const checkBody = agentSrc.slice(agentSrc.indexOf('async check()'));
    // Index names migrate() creates, from its own DDL.
    const created = new Set();
    const re = /(?:ADD\s+(?:UNIQUE\s+)?(?:KEY|INDEX)|CREATE\s+INDEX)\s+`?(\w+)`?/gi;
    let m; while ((m = re.exec(migrateBody))) created.add(m[1]);
    for (const idx of [...created].sort()) {
      ok(checkBody.includes(`'${idx}'`), `check() verifies index ${idx}`);
    }
    ok(created.size > 0, `parsed ${created.size} index names out of migrate()`);
  }

  console.log('\n-- 5. SchemaMigrationAgent.check() is 100% OK --');
  {
    const checks = await SchemaMigrationAgent.check();
    const missing = checks.filter(c => c.status !== 'OK');
    for (const c of missing) console.log(`      MISSING: ${c.table}.${c.column}`);
    ok(missing.length === 0, `check(): ${checks.length - missing.length}/${checks.length} OK`);
  }

  console.log('\n-- 6. ensureSchema() is idempotent --');
  {
    const before = await snapshot();
    await ensureSchema();
    const after = await snapshot();
    ok(before === after, 'second ensureSchema() run changed no table/column/index');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

async function snapshot() {
  const [t] = await pool.query(
    `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME, COLUMN_NAME`);
  const [i] = await pool.query(
    `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
       FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`);
  return JSON.stringify({ t, i });
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
