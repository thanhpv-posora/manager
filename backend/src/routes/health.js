/**
 * GET /api/health — liveness/readiness probe.
 *
 * Reports application status, database connectivity, version and uptime, and
 * answers 503 when the database is unavailable so a load balancer or process
 * supervisor takes the instance out of rotation instead of routing traffic to a
 * process that cannot serve a single request.
 *
 * Exported as a factory taking the pool rather than importing it directly, so
 * the unavailable-database path can be exercised over real HTTP with an
 * injected failing pool — the shared database can't be taken down to test it,
 * and a timing trick is not reliable (a sub-millisecond timeout cannot beat a
 * few-millisecond ping on a host with coarse timer resolution).
 */

const DEFAULT_TIMEOUT_MS = Number(process.env.HEALTH_DB_TIMEOUT_MS || 3000);

/**
 * @param {object} pool  mysql2 pool (or anything exposing getConnection()).
 * @param {number} timeoutMs  bound on the probe.
 * @returns {Promise<{connected:boolean, latency_ms:number, error?:string}>}
 */
async function probeDatabase(pool, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const startedAt = Date.now();
  try {
    // Bounded on purpose: getConnection() can block for the driver's whole
    // connect timeout when the DB is unreachable, and a probe that hangs reads
    // as "still starting" rather than "down" to most supervisors.
    await Promise.race([
      (async () => {
        const conn = await pool.getConnection();
        try { await conn.ping(); } finally { conn.release(); }
      })(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(Object.assign(new Error('health check timed out'), { code: 'ETIMEDOUT' })),
          timeoutMs
        )
      ),
    ]);
    return { connected: true, latency_ms: Date.now() - startedAt };
  } catch (e) {
    // Error CODE only — the driver's message embeds the DB user and host
    // (CR-3), and /api/health is unauthenticated.
    return {
      connected: false,
      error: e && e.code ? e.code : 'CONNECTION_FAILED',
      latency_ms: Date.now() - startedAt,
    };
  }
}

/**
 * Build the /api/health handler.
 *
 * The ok/name/version fields are kept exactly as they were — existing callers
 * and the contract documented in CLAUDE.md depend on them; everything else is
 * additive.
 */
function createHealthHandler(pool, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  return async function healthHandler(req, res) {
    const database = await probeDatabase(pool, timeoutMs);
    const ok = database.connected;
    res.status(ok ? 200 : 503).json({
      ok,
      status: ok ? 'healthy' : 'unhealthy',
      name: 'meatbiz-api',
      version: '6.6.0',
      uptime_seconds: Math.floor(process.uptime()),
      database,
      timestamp: new Date().toISOString(),
    });
  };
}

module.exports = { createHealthHandler, probeDatabase, DEFAULT_TIMEOUT_MS };
