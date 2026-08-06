/**
 * Guards bootstrap.js's safeAddColumn() call convention.
 *
 * safeAddColumn(conn, table, column, ddl) executes:
 *     ALTER TABLE <table> ADD COLUMN <ddl>
 *
 * so `ddl` must itself begin with the column name. Passing only the type
 * produces `ALTER TABLE t ADD COLUMN VARCHAR(100) NULL` -> ER_PARSE_ERROR, and
 * because ensureSchema() runs during boot the server then exits 1 instead of
 * starting. It fails ONLY when the column is genuinely absent, so on a machine
 * where every column already exists the bug is invisible — which is exactly how
 * it reached main.
 *
 * Two layers:
 *   1. static — every safeAddColumn call site passes a ddl starting with its
 *      own column name.
 *   2. runtime — actually add a column to a throwaway table via the real helper,
 *      proving the generated SQL parses.
 *
 * Run: node scripts/verify-bootstrap-add-column-ddl.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../src/config/db');

const BOOTSTRAP = path.resolve(__dirname, '..', 'src', 'config', 'bootstrap.js');

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log('  [PASS] ' + msg); }
  else { fail++; console.log('  [FAIL] ' + msg + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
};

function main1_static() {
  console.log('-- 1. every safeAddColumn ddl starts with its column name --');
  const src = fs.readFileSync(BOOTSTRAP, 'utf8');

  // Single-line literal call sites: safeAddColumn(conn, 'tbl', 'col', <quoted ddl>)
  // Quotes may be ' " or ` — all three are used in this file.
  const re = /safeAddColumn\(\s*conn\s*,\s*[^,]+,\s*(['"`])([A-Za-z0-9_]+)\1\s*,\s*(['"`])([\s\S]*?)\3\s*\)/g;
  let m, checked = 0;
  const offenders = [];
  while ((m = re.exec(src))) {
    const column = m[2];
    const ddl = m[4].trim();
    checked++;
    // ddl may be a template with ${col} — that is the dynamic form, handled below.
    if (ddl.startsWith('${')) continue;
    if (!new RegExp('^' + column + '\\b').test(ddl)) {
      offenders.push({ column, ddl: ddl.slice(0, 60) });
    }
  }
  ok(checked > 0, `parsed ${checked} literal safeAddColumn call sites`);
  ok(offenders.length === 0,
    offenders.length ? `call sites whose ddl omits the column name: ${JSON.stringify(offenders)}`
                     : 'no call site omits the column name');

  // Dynamic form inside a loop must interpolate the column name too.
  const dynamic = src.match(/safeAddColumn\([^)]*,\s*col\s*,\s*`([^`]*)`\s*\)/g) || [];
  for (const d of dynamic) {
    ok(/`\$\{col\}\s/.test(d), 'dynamic safeAddColumn interpolates ${col} into the ddl', d.slice(0, 90));
  }
}

async function main2_runtime() {
  console.log('\n-- 2. the generated SQL actually parses (real ALTER on a throwaway table) --');
  const TABLE = 'zz_cr_addcolumn_probe';
  const conn = await pool.getConnection();
  try {
    await conn.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await conn.query(`CREATE TABLE ${TABLE} (id BIGINT AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB`);

    // Re-implement safeAddColumn's exact statement shape rather than importing
    // bootstrap.js (requiring it would run the whole schema build).
    const addColumn = async (column, ddl) => {
      const [rows] = await conn.query(
        `SELECT COUNT(*) cnt FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?`, [TABLE, column]);
      if (Number(rows[0].cnt) === 0) await conn.query(`ALTER TABLE ${TABLE} ADD COLUMN ${ddl}`);
    };

    // The corrected convention.
    await addColumn('good_col', 'good_col VARCHAR(100) NULL');
    const [c1] = await conn.query(
      `SELECT COUNT(*) cnt FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME='good_col'`, [TABLE]);
    ok(Number(c1[0].cnt) === 1, 'ddl including the column name adds the column');

    // Idempotent: a second call is a no-op, not an error.
    let threw = false;
    try { await addColumn('good_col', 'good_col VARCHAR(100) NULL'); } catch { threw = true; }
    ok(!threw, 'adding an existing column is a no-op');

    // The broken convention must fail loudly — this is the bug being guarded.
    let parseErr = null;
    try { await addColumn('bad_col', 'VARCHAR(100) NULL'); } catch (e) { parseErr = e; }
    ok(parseErr && (parseErr.code === 'ER_PARSE_ERROR' || parseErr.errno === 1064),
      'ddl WITHOUT the column name raises ER_PARSE_ERROR (the boot-breaking failure)',
      parseErr && parseErr.code);
  } finally {
    try { await conn.query(`DROP TABLE IF EXISTS ${TABLE}`); } catch { /* best effort */ }
    conn.release();
  }
}

(async () => {
  console.log('=== bootstrap safeAddColumn convention ===\n');
  main1_static();
  await main2_runtime();
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e); try { await pool.end(); } catch {} process.exit(1); });
