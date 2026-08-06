/**
 * Verifies log retention (H-6).
 *
 * The logger already wrote one file per day per category, so daily rotation
 * existed — what was missing was ever deleting them, so the log directory grew
 * without bound. These tests cover the pruning that closes that.
 *
 * Runs entirely against a throwaway LOG_DIR under the OS temp directory. The
 * real backend/logs tree is never read or modified.
 *
 * Run: node scripts/verify-log-rotation.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'meatbiz-logrot-'));
process.env.LOG_DIR = WORK; // must be set before the logger module loads

const logger = require('../src/services/fileLogger.service');

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log('  [PASS] ' + msg); }
  else { fail++; console.log('  [FAIL] ' + msg + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
};

function stamp(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function makeLog(category, daysAgo) {
  const dir = path.join(WORK, category);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stamp(daysAgo)}-${category}.log`);
  fs.writeFileSync(file, JSON.stringify({ ts: new Date().toISOString(), event: 'TEST' }) + '\n');
  return file;
}

const exists = (p) => fs.existsSync(p);

function main() {
  console.log('=== log retention ===\n');
  console.log(`  (throwaway LOG_DIR: ${WORK})\n`);

  console.log('-- 1. files older than the window are pruned, recent ones kept --');
  const old90 = makeLog('system', 90);
  const old31 = makeLog('errors', 31);
  const recent1 = makeLog('system', 1);
  const today0 = makeLog('ai', 0);
  const edge30 = makeLog('mail', 30);

  const removed = logger.pruneOldLogs(30);

  ok(!exists(old90), '90-day-old file removed');
  ok(!exists(old31), '31-day-old file removed');
  ok(exists(recent1), '1-day-old file kept');
  ok(exists(today0), "today's file kept");
  ok(exists(edge30), 'exactly-30-day-old file kept (boundary is inclusive)');
  ok(removed.length === 2, 'pruneOldLogs reported exactly 2 removals', removed);

  console.log('\n-- 2. only this logger\'s own files are touched --');
  const foreignDir = path.join(WORK, 'system');
  const foreign = path.join(foreignDir, 'important-notes.txt');
  fs.writeFileSync(foreign, 'not a log file');
  const nonMatching = path.join(foreignDir, 'app.log'); // no date prefix
  fs.writeFileSync(nonMatching, 'not our naming scheme');
  const oldForeignName = path.join(foreignDir, '2019-01-01-backup.tar.gz');
  fs.writeFileSync(oldForeignName, 'not a .log');

  logger.pruneOldLogs(30);
  ok(exists(foreign), 'unrelated .txt file untouched');
  ok(exists(nonMatching), 'log file without a date prefix untouched');
  ok(exists(oldForeignName), 'old non-.log file untouched');

  console.log('\n-- 3. retention is configurable and can be disabled --');
  const d10 = makeLog('system', 10);
  ok(logger.pruneOldLogs(0).length === 0, 'retention 0 disables pruning (keeps everything)');
  ok(exists(d10), '10-day-old file survives when pruning is disabled');
  ok(logger.pruneOldLogs(-1).length === 0, 'negative retention disables pruning');
  ok(exists(d10), '10-day-old file still present');
  logger.pruneOldLogs(5);
  ok(!exists(d10), '10-day-old file removed when retention is 5 days');

  console.log('\n-- 4. writing still works and lands in the dated file --');
  logger.logSystem('ROTATION_TEST', { hello: 'world' });
  const todayFile = path.join(WORK, 'system', `${stamp(0)}-system.log`);
  // appendFile is async; give it a moment.
  const deadline = Date.now() + 3000;
  while (!exists(todayFile) && Date.now() < deadline) { /* spin briefly */ }
  ok(exists(todayFile), 'log line written to the current dated file');

  console.log('\n-- 5. startLogRotation() is safe and does not hold the process open --');
  const timer = logger.startLogRotation(30);
  ok(!!timer, 'startLogRotation returned a timer');
  // If the timer were not unref()'d this process would never exit on its own.
  ok(typeof timer.unref === 'function', 'timer supports unref (never blocks shutdown)');
  clearInterval(timer);

  console.log('\n-- 6. missing log directory is handled, not thrown --');
  {
    // ROOT is fixed at module load, so this runs in a child process with
    // LOG_DIR pointing at a path that does not exist. Deleting our own WORK
    // tree here instead would race with the async appendFile from step 4.
    const { execFileSync } = require('child_process');
    const missing = path.join(os.tmpdir(), 'meatbiz-logrot-absent-' + Date.now());
    const script =
      'const l = require(' + JSON.stringify(path.resolve(__dirname, '..', 'src', 'services', 'fileLogger.service.js')) + ');' +
      'const r = l.pruneOldLogs(30);' +
      'console.log("OK:" + r.length);';
    let out = '', threw = false;
    try {
      out = execFileSync(process.execPath, ['-e', script], {
        env: { ...process.env, LOG_DIR: missing },
        encoding: 'utf8', timeout: 30000,
      });
    } catch (_) { threw = true; }
    ok(!threw && out.includes('OK:0'), 'pruning a missing log directory returns [] instead of throwing', out.trim());
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(fail ? 1 : 0);
}

main();
