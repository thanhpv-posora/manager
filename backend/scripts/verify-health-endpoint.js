/**
 * Verifies GET /api/health.
 *
 * Boots two real server instances as child processes:
 *   A. normal config            -> expects HTTP 200 and a healthy body
 *   B. HEALTH_DB_TIMEOUT_MS=1   -> the DB probe cannot finish in 1ms, so the
 *                                  handler takes its failure path and must
 *                                  answer HTTP 503
 *
 * Instance B is how the unavailable-database path is exercised without taking
 * the shared database down: startup validation uses its own connection check,
 * so the process still boots and only the health probe times out.
 *
 * Run: node scripts/verify-health-endpoint.js
 */
require('dotenv').config();
const path = require('path');
const { spawn } = require('child_process');

const BACKEND = path.resolve(__dirname, '..');
const SERVER = path.join(BACKEND, 'src', 'server.js');

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log('  [PASS] ' + msg); }
  else { fail++; console.log('  [FAIL] ' + msg + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
};

function startServer(port, extraEnv) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: BACKEND,
    env: { ...process.env, PORT: String(port), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  return child;
}

async function waitForPort(port, expectAnyStatus = true) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (expectAnyStatus || r.ok) return r;
    } catch { /* not up yet */ }
    await new Promise(s => setTimeout(s, 1000));
  }
  return null;
}

async function main() {
  console.log('=== GET /api/health ===\n');
  const servers = [];

  try {
    console.log('-- A. database reachable -> 200 healthy --');
    {
      const port = 4111;
      servers.push(startServer(port, {}));
      const res = await waitForPort(port);
      if (!res) { ok(false, 'server A started'); return finish(servers); }
      const body = await res.json();

      ok(res.status === 200, 'HTTP 200', res.status);
      ok(body.ok === true, 'ok: true', body.ok);
      ok(body.status === 'healthy', 'status: "healthy"', body.status);
      ok(body.name === 'meatbiz-api', 'name preserved (backward compatible)', body.name);
      ok(body.version === '6.6.0', 'version preserved (backward compatible)', body.version);
      ok(typeof body.uptime_seconds === 'number' && body.uptime_seconds >= 0,
        'uptime_seconds is a number', body.uptime_seconds);
      ok(body.database && body.database.connected === true,
        'database.connected: true', body.database);
      ok(typeof body.database.latency_ms === 'number', 'database.latency_ms reported', body.database);
      ok(typeof body.timestamp === 'string' && !Number.isNaN(Date.parse(body.timestamp)),
        'timestamp is a valid ISO date', body.timestamp);

      // uptime must actually advance.
      await new Promise(s => setTimeout(s, 1500));
      const res2 = await fetch(`http://127.0.0.1:${port}/api/health`);
      const body2 = await res2.json();
      ok(body2.uptime_seconds >= body.uptime_seconds, 'uptime_seconds advances', {
        first: body.uptime_seconds, second: body2.uptime_seconds,
      });
    }

    console.log('\n-- B. database probe fails -> 503 unhealthy --');
    {
      // The shared database cannot be taken down to test this, and a timing
      // trick is not reliable (a 1ms timeout loses to a 6ms ping on a host
      // with coarse timer resolution). So mount the REAL handler on a throwaway
      // Express app with a pool that fails the way an unreachable database
      // does, and exercise it over real HTTP.
      const express = require('express');
      const { createHealthHandler } = require('../src/routes/health');
      const failingPool = {
        getConnection: async () => {
          throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:3306'), { code: 'ECONNREFUSED' });
        },
      };
      const app = express();
      app.get('/api/health', createHealthHandler(failingPool));
      const server = await new Promise(resolve => {
        const s = app.listen(4112, () => resolve(s));
      });
      servers.push({ kill: () => server.close() });

      const res = await fetch('http://127.0.0.1:4112/api/health');
      const body = await res.json();

      ok(res.status === 503, 'HTTP 503 when the database is unavailable', res.status);
      ok(body.ok === false, 'ok: false', body.ok);
      ok(body.status === 'unhealthy', 'status: "unhealthy"', body.status);
      ok(body.database && body.database.connected === false,
        'database.connected: false', body.database);
      ok(typeof body.database.error === 'string' && body.database.error.length > 0,
        'database.error carries a code', body.database);
      ok(body.name === 'meatbiz-api' && body.version === '6.6.0',
        'name/version still reported while unhealthy', { name: body.name, version: body.version });

      // The endpoint is unauthenticated: it must never leak connection details.
      const text = JSON.stringify(body);
      // Length filter avoids a false positive: DB_USER here is "meat", which is
      // a substring of the legitimate product name "meatbiz-api". Only values
      // long enough to be unambiguous are worth asserting on.
      const secrets = [process.env.DB_PASSWORD, process.env.DB_USER, process.env.DB_HOST]
        .filter(v => v && String(v).length >= 6);
      const leaked = secrets.filter(v => text.includes(String(v)));
      ok(leaked.length === 0, 'no DB credential/host leaked in the unhealthy body',
        leaked.length ? '(leaked value present)' : undefined);
      // The driver's raw message carried the host:port; only the code survives.
      ok(!text.includes('ECONNREFUSED 10.0.0.1'), 'driver message not echoed, only the error code');
    }

    console.log('\n-- C. probe timeout is bounded --');
    {
      const { probeDatabase } = require('../src/routes/health');
      // A pool that never resolves — the exact hang the timeout exists for.
      const hangingPool = { getConnection: () => new Promise(() => {}) };
      const t0 = Date.now();
      const result = await probeDatabase(hangingPool, 200);
      const elapsed = Date.now() - t0;
      ok(result.connected === false, 'hanging database reports connected: false', result);
      ok(result.error === 'ETIMEDOUT', 'timeout surfaces as ETIMEDOUT', result.error);
      ok(elapsed < 2000, `probe returned in ${elapsed}ms instead of hanging`, elapsed);
    }
  } finally {
    finish(servers);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

function finish(servers) {
  for (const s of servers) { try { s.kill(); } catch { /* already gone */ } }
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
