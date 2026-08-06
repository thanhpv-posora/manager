const pool = require('./db');
const { validateDbEnv } = require('./dbConfig');

// JWT_SECRET values that are public knowledge: either the placeholder shipped in
// backend/.env.example, or a real secret that was previously committed to that
// file and therefore still lives in this repository's git history. Booting with
// one of these means the token signing key is not secret — anyone who can read
// the repo can mint a valid token for any role. Kept as an explicit list (not a
// strength heuristic) so this only ever fires on values we know are published.
const PUBLISHED_JWT_SECRETS = new Set([
  'CHANGE_ME',
  'meatbiz_v66_secret',
]);

function parseAllowedOrigins() {
  return (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);
}

async function validateStartupConfig() {
  const isProd = process.env.NODE_ENV === 'production';
  const errors = [];

  if (!process.env.JWT_SECRET) {
    if (isProd) {
      errors.push('JWT_SECRET must be set in production.');
    } else {
      console.warn('[STARTUP WARNING] JWT_SECRET is not set — authentication will fail until it is configured in .env.');
    }
  } else if (PUBLISHED_JWT_SECRETS.has(process.env.JWT_SECRET)) {
    // Deliberately a warning in every environment, not a fatal error: making it
    // fatal would refuse to boot an already-running deployment that is still on
    // the leaked value, turning a disclosure into an outage. Promote to
    // errors.push() once the secret has been rotated everywhere.
    console.warn(
      '[STARTUP WARNING] JWT_SECRET is set to a value that is published in this ' +
      'repository (backend/.env.example and its git history). The token signing key ' +
      'is therefore NOT secret — anyone who can read the repo can forge a token for ' +
      'any user or role. Rotate it now: put a new random value in backend/.env ' +
      '(node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"). ' +
      'Rotating invalidates all existing sessions — users will need to log in again.'
    );
  }

  const origins = parseAllowedOrigins();
  if (isProd && origins.length === 0) {
    errors.push('ALLOWED_ORIGINS must be set in production (comma-separated list of allowed frontend URLs).');
  } else if (!isProd && origins.length === 0) {
    console.warn('[STARTUP WARNING] ALLOWED_ORIGINS not set — CORS will default to localhost origins for development.');
  }

  // CR-3: verify the DB environment BEFORE touching the pool. In production a
  // missing DB_* variable must fail the boot naming the variable, rather than
  // silently connecting to root@127.0.0.1 with an empty password (the old
  // db.js fallbacks) or surfacing as a confusing connection error later.
  // validateDbEnv() returns [] outside production, where the local defaults are
  // deliberately retained. Messages name variables only — never their values.
  const dbEnvErrors = validateDbEnv();
  errors.push(...dbEnvErrors);

  // Only attempt a real connection when the configuration is coherent —
  // connecting with unset credentials would just produce a second, noisier
  // error on top of the precise one already reported above.
  if (dbEnvErrors.length === 0) {
    try {
      const conn = await pool.getConnection();
      await conn.ping();
      conn.release();
    } catch (e) {
      // The driver's raw message embeds the DB user and host (e.g. "Access
      // denied for user 'x'@'10.0.0.1'"). In production report the error code
      // only — enough to diagnose, and it never carries a credential. Dev keeps
      // the full message for local debugging.
      errors.push(isProd
        ? `Cannot connect to database (${e.code || 'connection failed'}).`
        : `Cannot connect to database: ${e.message}`);
    }
  }

  if (errors.length) {
    errors.forEach(e => console.error('[STARTUP ERROR]', e));
    process.exit(1);
  }
}

module.exports = { validateStartupConfig, parseAllowedOrigins };
