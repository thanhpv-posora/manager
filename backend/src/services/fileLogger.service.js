const fs = require('fs');
const path = require('path');
const util = require('util');

const ROOT = process.env.LOG_DIR || path.join(process.cwd(), 'logs');
const MAX_TEXT = Number(process.env.LOG_MAX_TEXT || 12000);

function yyyyMmDd(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}

function sanitize(value) {
  if (value == null) return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const key = String(k).toLowerCase();
      if (key.includes('password') || key.includes('token') || key.includes('authorization') || key.includes('cookie') || key.includes('secret')) {
        out[k] = '***MASKED***';
      } else {
        out[k] = sanitize(v);
      }
    }
    return out;
  }
  return value;
}

function toLine(level, event, data) {
  let payload;
  try {
    payload = sanitize(data || {});
  } catch (e) {
    payload = { sanitize_error: e.message };
  }

  let payloadText;
  try {
    payloadText = JSON.stringify(payload);
  } catch (e) {
    payload = { stringify_error: e.message, data: util.inspect(data).slice(0, MAX_TEXT) };
    payloadText = JSON.stringify(payload);
  }

  // Never JSON.parse a truncated string: it can crash the app with
  // "Unterminated string in JSON" on large request/response payloads.
  if (payloadText.length > MAX_TEXT) {
    payload = {
      truncated: true,
      length: payloadText.length,
      preview: payloadText.slice(0, MAX_TEXT)
    };
  }

  return JSON.stringify({ ts: new Date().toISOString(), level, event, payload }) + '\n';
}

function write(category, level, event, data) {
  const safeCategory = String(category || 'system').replace(/[^a-zA-Z0-9_-]/g, '_');
  const dir = path.join(ROOT, safeCategory);
  ensureDir(dir);
  const file = path.join(dir, `${yyyyMmDd()}-${safeCategory}.log`);
  const line = toLine(level || 'info', event || 'LOG', data || {});
  fs.appendFile(file, line, err => {
    if (err) console.error('[FILE_LOG_WRITE_FAILED]', err.message);
  });
}

// ── Retention ────────────────────────────────────────────────────────────────
// Files are already split one-per-day-per-category by write() above, so daily
// rotation exists; what was missing is ever DELETING them, which made the log
// directory grow without bound until the disk filled. This prunes by filename
// date — no new dependency, no change to how lines are written or named.
//
// Filenames are the source of truth rather than mtime: an old file that was
// touched by a copy or a restore must still age out on its own date.
const RETENTION_DAYS = Number(process.env.LOG_RETENTION_DAYS || 30);

const LOG_FILE_RE = /^(\d{4})-(\d{2})-(\d{2})-[a-zA-Z0-9_-]+\.log$/;

function pruneOldLogs(retentionDays = RETENTION_DAYS) {
  const removed = [];
  // 0 or negative disables pruning — an operator who wants to keep everything
  // (e.g. while investigating) must be able to say so.
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return removed;

  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - retentionDays);

  let categories;
  try {
    categories = fs.readdirSync(ROOT, { withFileTypes: true });
  } catch (_) {
    return removed; // no log directory yet
  }

  for (const entry of categories) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(ROOT, entry.name);
    let files;
    try { files = fs.readdirSync(dir); } catch (_) { continue; }

    for (const name of files) {
      const m = LOG_FILE_RE.exec(name);
      if (!m) continue; // never touch a file this module did not create
      const fileDate = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      if (fileDate >= cutoff) continue;
      try {
        fs.unlinkSync(path.join(dir, name));
        removed.push(path.join(entry.name, name));
      } catch (_) { /* locked or already gone — try again next run */ }
    }
  }
  return removed;
}

// Called once at startup and then daily. Deliberately not on the write path:
// pruning on every log line would stat the whole log tree under load.
let pruneTimer = null;
function startLogRotation(retentionDays = RETENTION_DAYS) {
  const run = () => {
    try {
      const removed = pruneOldLogs(retentionDays);
      if (removed.length) {
        write('system', 'info', 'LOG_RETENTION_PRUNED', { removed_count: removed.length, retention_days: retentionDays });
      }
    } catch (e) {
      console.error('[LOG_ROTATION_FAILED]', e.message);
    }
  };
  run();
  if (pruneTimer) clearInterval(pruneTimer);
  pruneTimer = setInterval(run, 24 * 60 * 60 * 1000);
  // Never hold the process open just to prune.
  if (typeof pruneTimer.unref === 'function') pruneTimer.unref();
  return pruneTimer;
}

function info(category, event, data) { write(category, 'info', event, data); }
function warn(category, event, data) { write(category, 'warn', event, data); }
function error(category, event, data) { write(category, 'error', event, data); }

function logAi(event, data) { info('ai', event, data); }
function logOrder(event, data) { info('orders', event, data); }
function logError(event, data) { error('errors', event, data); }
function logSystem(event, data) { info('system', event, data); }
function logMail(event, data) { info('mail', event, data); }

function tail(category = 'errors', lines = 100) {
  const safeCategory = String(category || 'errors').replace(/[^a-zA-Z0-9_-]/g, '_');
  const file = path.join(ROOT, safeCategory, `${yyyyMmDd()}-${safeCategory}.log`);
  if (!fs.existsSync(file)) return { file, lines: [] };
  const content = fs.readFileSync(file, 'utf8');
  const arr = content.split(/\r?\n/).filter(Boolean).slice(-Number(lines || 100));
  return { file, lines: arr };
}

module.exports = { write, info, warn, error, logAi, logOrder, logError, logSystem, logMail, tail, ROOT, pruneOldLogs, startLogRotation, RETENTION_DAYS };
