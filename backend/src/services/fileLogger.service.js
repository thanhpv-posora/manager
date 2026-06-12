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
    payload = JSON.stringify(sanitize(data || {}));
  } catch (e) {
    payload = JSON.stringify({ stringify_error: e.message, data: util.inspect(data).slice(0, MAX_TEXT) });
  }
  if (payload.length > MAX_TEXT) payload = payload.slice(0, MAX_TEXT) + '...TRUNCATED';
  return JSON.stringify({ ts: new Date().toISOString(), level, event, payload: JSON.parse(payload) }) + '\n';
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

module.exports = { write, info, warn, error, logAi, logOrder, logError, logSystem, logMail, tail, ROOT };
