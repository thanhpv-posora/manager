/**
 * CR-3 verification — production must fail closed on missing DB configuration.
 *
 * Production scenarios run in CHILD PROCESSES with a synthetic environment, so
 * they exercise the real module-load + validateStartupConfig() path without
 * touching this machine's .env or its database. The parent process never sets
 * NODE_ENV=production on itself.
 *
 * Nothing here writes to the database. Nothing prints a credential.
 *
 * Run: node scripts/verify-p0-cr3-db-config-fail-closed.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BACKEND = path.resolve(__dirname, '..');
const VALIDATOR = path.join(BACKEND, 'src', 'config', 'startupValidator.js');

// db.js calls require('dotenv').config(), which loads `.env` relative to the
// process CWD. A plain .config() call ignores DOTENV_CONFIG_PATH (that is only
// honoured by the `-r dotenv/config` preload), so running a child from
// backend/ would silently reload the real .env and refill the very variable
// the scenario is trying to omit. Every synthetic child therefore runs from an
// empty temp directory instead. Absolute require() paths still resolve, and
// bare requires resolve from each module's own location, so this only removes
// the ambient .env.
const NO_ENV_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cr3-noenv-'));

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log('  [PASS] ' + msg); }
  else { fail++; console.log('  [FAIL] ' + msg); }
};

// A password value that must never appear in any output.
const CANARY_PASSWORD = 'S3cret-Canary-Do-Not-Print-9137';

/**
 * Run validateStartupConfig() in a child process under a controlled env,
 * from a directory containing no .env (see NO_ENV_DIR above). The real
 * backend/.env is never read or modified.
 *
 * @returns {{status:number, output:string}}
 */
function runValidator(env) {
  const script = `
    const { validateStartupConfig } = require(${JSON.stringify(VALIDATOR)});
    validateStartupConfig().then(
      () => { console.log('VALIDATION_PASSED'); process.exit(0); },
      (e) => { console.log('VALIDATION_THREW ' + (e && e.message)); process.exit(3); }
    );
  `;
  // Start from a clean slate so the parent's own DB_* never leaks in.
  const base = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    windir: process.env.windir,
    NODE_PATH: path.join(BACKEND, 'node_modules'),
    JWT_SECRET: 'test-only-not-a-real-secret-0000000000',
    ALLOWED_ORIGINS: 'https://example.com',
  };
  try {
    const out = execFileSync(process.execPath, ['-e', script], {
      env: { ...base, ...env },
      cwd: NO_ENV_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
    });
    return { status: 0, output: out };
  } catch (e) {
    return {
      status: e.status === undefined ? -1 : e.status,
      output: `${e.stdout || ''}${e.stderr || ''}`,
    };
  }
}

const FULL_PROD_ENV = {
  NODE_ENV: 'production',
  DB_HOST: 'db.invalid.example',
  DB_PORT: '3306',
  DB_USER: 'appuser',
  DB_PASSWORD: CANARY_PASSWORD,
  DB_NAME: 'meat_business_db',
};

const omit = (key) => {
  const e = { ...FULL_PROD_ENV };
  delete e[key];
  return e;
};

function main() {
  console.log('=== CR-3: production fails closed on missing DB configuration ===\n');
  const allOutput = [];

  console.log('-- 1-5. production + missing/invalid variable -> startup rejected --');
  for (const key of ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'DB_PORT']) {
    const r = runValidator(omit(key));
    allOutput.push(r.output);
    ok(r.status === 1, `production without ${key}: exits non-zero (status ${r.status})`);
    ok(r.output.includes(`${key} must be set in production`),
      `production without ${key}: error names ${key}`);
    ok(!r.output.includes('VALIDATION_PASSED'),
      `production without ${key}: validation did not pass`);
  }

  // Blank (present but empty) must be treated the same as missing.
  for (const key of ['DB_HOST', 'DB_PASSWORD']) {
    const r = runValidator({ ...FULL_PROD_ENV, [key]: '   ' });
    allOutput.push(r.output);
    ok(r.status === 1 && r.output.includes(`${key} must be set in production`),
      `production with blank ${key}: rejected, names ${key}`);
  }

  console.log('\n-- 5b. production + invalid DB_PORT -> startup rejected --');
  for (const badPort of ['not-a-number', '0', '70000', '3306.5']) {
    const r = runValidator({ ...FULL_PROD_ENV, DB_PORT: badPort });
    allOutput.push(r.output);
    ok(r.status === 1 && r.output.includes('DB_PORT must be an integer'),
      `production with DB_PORT="${badPort}": rejected as invalid`);
  }

  console.log('\n-- 6. production + all DB variables valid -> passes env validation --');
  {
    // Host is deliberately unresolvable: this proves the env gate is satisfied
    // and the code proceeded to the real connection attempt, without needing a
    // production database to exist.
    const r = runValidator(FULL_PROD_ENV);
    allOutput.push(r.output);
    const namedMissing = /DB_(HOST|PORT|USER|PASSWORD|NAME) must be set in production/.test(r.output);
    ok(!namedMissing, 'no "must be set in production" error when all DB vars are provided');
    ok(r.output.includes('Cannot connect to database'),
      'proceeds past env validation to the actual connection attempt');
  }

  console.log('\n-- 7. development behavior remains compatible --');
  {
    // No DB_* at all, non-production: legacy local defaults still apply, so the
    // env gate must stay silent (it may still fail to CONNECT, which is fine).
    const r = runValidator({ NODE_ENV: 'development' });
    allOutput.push(r.output);
    ok(!/must be set in production/.test(r.output),
      'development with no DB_* vars: no fail-closed error raised');
  }
  {
    const { validateDbEnv } = require(path.join(BACKEND, 'src', 'config', 'dbConfig'));
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    ok(validateDbEnv().length === 0, 'validateDbEnv() returns no errors outside production');
    process.env.NODE_ENV = saved;
  }
  {
    // The dev config must still resolve to the historical defaults.
    const script = `
      const { resolveDbConfig } = require(${JSON.stringify(path.join(BACKEND, 'src', 'config', 'dbConfig'))});
      const c = resolveDbConfig();
      console.log(JSON.stringify({ host: c.host, port: c.port, user: c.user, database: c.database, pwEmpty: c.password === '' }));
    `;
    const r = (() => {
      try {
        return execFileSync(process.execPath, ['-e', script], {
          env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, windir: process.env.windir, NODE_ENV: 'development' },
          cwd: NO_ENV_DIR, encoding: 'utf8', timeout: 60000,
        });
      } catch (e) { return `${e.stdout || ''}${e.stderr || ''}`; }
    })();
    let cfg = null;
    try { cfg = JSON.parse(r.trim().split(/\r?\n/).pop()); } catch { /* handled below */ }
    ok(cfg && cfg.host === '127.0.0.1' && cfg.port === 3306 && cfg.user === 'root'
       && cfg.database === 'meat_business_db' && cfg.pwEmpty === true,
      'development defaults unchanged (127.0.0.1 / 3306 / root / meat_business_db / empty password)');
  }

  console.log('\n-- 8. no password value appears anywhere in output --');
  {
    const combined = allOutput.join('\n');
    ok(!combined.includes(CANARY_PASSWORD), 'the DB password value never appears in startup output');
    ok(!/mysql:\/\//i.test(combined), 'no full connection URI printed');
  }
  {
    // A production connection failure must not echo the driver's raw message,
    // which embeds user@host.
    const r = runValidator(FULL_PROD_ENV);
    ok(!r.output.includes('appuser'), 'production connection error does not echo the DB user');
    ok(!r.output.includes(CANARY_PASSWORD), 'production connection error does not echo the password');
  }

  console.log('\n-- 9. the real local .env still validates normally --');
  {
    // Runs with this machine's actual .env, exactly as `npm run dev` would.
    // Read-only: it pings the DB and releases. NODE_ENV is left unset/dev.
    const script = `
      const { validateStartupConfig } = require(${JSON.stringify(VALIDATOR)});
      validateStartupConfig().then(() => { console.log('VALIDATION_PASSED'); process.exit(0); });
    `;
    let out = '', status = 0;
    try {
      out = execFileSync(process.execPath, ['-e', script], {
        env: { ...process.env, NODE_ENV: '' }, cwd: BACKEND, encoding: 'utf8', timeout: 60000,
      });
    } catch (e) { status = e.status; out = `${e.stdout || ''}${e.stderr || ''}`; }
    ok(status === 0 && out.includes('VALIDATION_PASSED'),
      'real dev .env passes validateStartupConfig() unchanged');
  }

  try { fs.rmSync(NO_ENV_DIR, { recursive: true, force: true }); } catch { /* best effort */ }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
