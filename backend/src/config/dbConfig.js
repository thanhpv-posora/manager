/**
 * Database configuration resolution and validation (CR-3).
 *
 * Split out of db.js so that startupValidator can check the environment
 * WITHOUT importing the pool for that purpose, and so db.js keeps exporting
 * the pool itself unchanged (106 modules do `require('../config/db')`).
 *
 * The rule this file enforces:
 *
 *   In production every DB_* variable must be set explicitly. There is no
 *   fallback — a misconfigured production deploy must fail closed rather than
 *   silently connect to root@127.0.0.1 with an empty password, which would
 *   boot the app against the wrong database with no error.
 *
 *   Outside production the historical local defaults are kept exactly as they
 *   were, so existing dev setups and the verification scripts continue to work.
 *
 * Nothing here ever logs, returns or interpolates a credential VALUE. Errors
 * name the offending variable only.
 */

// Every variable that must be explicitly present in production.
const REQUIRED_DB_VARS = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];

// Historical non-production defaults — unchanged from the original db.js.
const DEV_DEFAULTS = {
  DB_HOST: '127.0.0.1',
  DB_PORT: '3306',
  DB_USER: 'root',
  DB_PASSWORD: '',
  DB_NAME: 'meat_business_db',
};

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function isBlank(v) {
  return v === undefined || v === null || String(v).trim() === '';
}

function isValidPort(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 65535;
}

/**
 * Validate the DB environment.
 *
 * @returns {string[]} human-readable error messages, empty when valid.
 *   Messages name variables only — never their values.
 *
 * Outside production this always returns [] : dev keeps its safe local
 * defaults deliberately, per CR-3's "development may retain safe local
 * defaults" allowance.
 */
function validateDbEnv() {
  if (!isProduction()) return [];

  const errors = [];
  for (const name of REQUIRED_DB_VARS) {
    // DB_PASSWORD is included on purpose: in production an empty password is
    // treated as "not configured", not as a valid credential.
    if (isBlank(process.env[name])) {
      errors.push(`${name} must be set in production (no fallback default is applied).`);
    }
  }

  // Only report the port as malformed when it was actually provided; a missing
  // DB_PORT is already reported above and should not produce two errors.
  if (!isBlank(process.env.DB_PORT) && !isValidPort(process.env.DB_PORT)) {
    errors.push('DB_PORT must be an integer between 1 and 65535.');
  }

  return errors;
}

/**
 * Build the mysql2 pool configuration.
 *
 * In production the DB_* values are used verbatim with NO `||` fallback, so a
 * missing variable can never silently become root / empty password / localhost.
 * validateDbEnv() is what turns that into a clean startup failure; this
 * function simply refuses to invent values.
 */
function resolveDbConfig() {
  const prod = isProduction();
  const pick = (name) => (prod ? process.env[name] : (process.env[name] || DEV_DEFAULTS[name]));

  return {
    host: pick('DB_HOST'),
    port: Number(pick('DB_PORT')),
    user: pick('DB_USER'),
    // Note: `pick` uses `||` in dev, which maps an empty password to the dev
    // default — also '' — so behavior is identical to the original code.
    password: pick('DB_PASSWORD'),
    database: pick('DB_NAME'),
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    decimalNumbers: true,
    dateStrings: true,
  };
}

module.exports = { validateDbEnv, resolveDbConfig, REQUIRED_DB_VARS, isProduction };
