/**
 * CR-2 verification — backend/.env.example must never carry a real credential.
 *
 * This file is committed to git in a PUBLIC repository. A real value placed
 * here is disclosed permanently: scrubbing it later does not remove it from
 * history. This script is the regression guard that keeps it scrubbed.
 *
 * Checks:
 *   1. .env.example contains none of the specific values that were previously
 *      committed (the known-leaked set).
 *   2. Secret-bearing keys hold an obvious placeholder, not a real-looking value.
 *   3. The real backend/.env is git-ignored and not tracked.
 *   4. .env.example still defines exactly the same key set it did before the
 *      scrub — the template stays usable (backward compatibility).
 *   5. If a real backend/.env exists locally, none of its secret values leaked
 *      into the template. Compared by value only; nothing secret is printed.
 *
 * Run: node scripts/verify-p0-cr2-env-example-scrubbed.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXAMPLE = path.join(ROOT, '.env.example');
const REAL = path.join(ROOT, '.env');

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log('  [PASS] ' + msg); }
  else { fail++; console.log('  [FAIL] ' + msg); }
};

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in out)) out[m[1]] = m[2]; // dotenv keeps the FIRST occurrence
  }
  return out;
}

// Values known to have been committed to .env.example at some point. These are
// burned permanently and must never reappear in a tracked file.
const KNOWN_LEAKED = [
  'meatbiz_v66_secret',
  'Meat@123',
  '192.168.10.204',
  'meatfood-496515',
  '2ccf7f8094874a2',
  'mail90168.maychuemail.com',
  'posor59ee6dd@posora.vn',
];

// Keys that must never hold a real value in the committed template.
const SECRET_KEYS = [
  'DB_PASSWORD', 'JWT_SECRET', 'MAIL_PASSWORD', 'SMTP_PASS', 'SMS_PROVIDER_API_KEY',
];

// A value is an acceptable placeholder if it is empty or obviously fake.
const isPlaceholder = (v) =>
  v === '' ||
  /^CHANGE_ME/i.test(v) ||
  /^your[-_]/i.test(v) ||
  /example\.com$/i.test(v) ||
  /^(changeme|placeholder|xxx+|todo)$/i.test(v);

function main() {
  console.log('=== CR-2: backend/.env.example must contain no real credentials ===\n');

  const exampleText = fs.readFileSync(EXAMPLE, 'utf8');
  const example = parseEnv(exampleText);

  console.log('-- 1. no known-leaked value present --');
  for (const leaked of KNOWN_LEAKED) {
    ok(!exampleText.includes(leaked),
      `.env.example does not contain the previously-committed value (${leaked.slice(0, 4)}…)`);
  }

  console.log('\n-- 2. secret-bearing keys hold placeholders --');
  for (const key of SECRET_KEYS) {
    if (!(key in example)) { console.log(`  [SKIP] ${key} not defined in template`); continue; }
    ok(isPlaceholder(example[key]), `${key} is an obvious placeholder, not a real value`);
  }

  console.log('\n-- 3. the real .env is git-ignored and untracked --');
  let tracked = '';
  try {
    tracked = execSync('git ls-files backend/.env', { cwd: path.resolve(ROOT, '..') }).toString().trim();
  } catch { /* git absent — treated as untracked below */ }
  ok(tracked === '', 'backend/.env is NOT tracked by git');

  let ignored = false;
  try {
    execSync('git check-ignore -q backend/.env', { cwd: path.resolve(ROOT, '..') });
    ignored = true;
  } catch { ignored = false; }
  ok(ignored, 'backend/.env is matched by .gitignore');

  console.log('\n-- 4. template still defines the full key set --');
  // 44 keys at the time of the CR-2 scrub, +2 for LOG_RETENTION_DAYS and
  // HEALTH_DB_TIMEOUT_MS added by the go-live sprint. The point of the count is
  // that the template must never silently LOSE keys — bump it deliberately
  // when a documented setting is genuinely added.
  const EXPECTED_KEY_LINES = 46;
  const keyLines = exampleText.split(/\r?\n/)
    .filter(l => !/^\s*#/.test(l))
    .map(l => (l.match(/^\s*([A-Z0-9_]+)\s*=/) || [])[1])
    .filter(Boolean);
  ok(keyLines.length === EXPECTED_KEY_LINES,
    `template defines ${EXPECTED_KEY_LINES} key lines (found ${keyLines.length})`);
  for (const required of ['PORT', 'DB_HOST', 'DB_USER', 'DB_NAME', 'JWT_SECRET', 'ALLOWED_ORIGINS']) {
    ok(required in example, `${required} is still defined in the template`);
  }

  console.log('\n-- 5. no live .env value leaked into the template --');
  if (!fs.existsSync(REAL)) {
    console.log('  [SKIP] no local backend/.env to compare against');
  } else {
    const real = parseEnv(fs.readFileSync(REAL, 'utf8'));
    for (const key of SECRET_KEYS) {
      if (!(key in real) || !(key in example)) continue;
      if (real[key] === '') continue;
      ok(real[key] !== example[key],
        `${key}: template value differs from the local .env value`);
    }
    // JWT_SECRET specifically: the template value must never match the live one.
    if (real.JWT_SECRET && example.JWT_SECRET) {
      ok(real.JWT_SECRET !== example.JWT_SECRET,
        'JWT_SECRET: live signing key is not the template value');
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
