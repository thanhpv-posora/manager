const pool = require('./db');

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
  }

  const origins = parseAllowedOrigins();
  if (isProd && origins.length === 0) {
    errors.push('ALLOWED_ORIGINS must be set in production (comma-separated list of allowed frontend URLs).');
  } else if (!isProd && origins.length === 0) {
    console.warn('[STARTUP WARNING] ALLOWED_ORIGINS not set — CORS will default to localhost origins for development.');
  }

  try {
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
  } catch (e) {
    errors.push(`Cannot connect to database: ${e.message}`);
  }

  if (errors.length) {
    errors.forEach(e => console.error('[STARTUP ERROR]', e));
    process.exit(1);
  }
}

module.exports = { validateStartupConfig, parseAllowedOrigins };
