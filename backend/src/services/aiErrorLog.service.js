const db = require('../config/db');
const notificationService = require('./notification.service');
const fileLogger = require('./fileLogger.service');

function safeJson(value) {
  try { return JSON.stringify(value || null); } catch (_) { return JSON.stringify({ unserializable: true }); }
}

function shortText(value, max = 4000) {
  const s = String(value || '');
  return s.length > max ? s.slice(0, max) + '...TRUNCATED' : s;
}

async function tableExists(tableName) {
  try {
    const [rows] = await db.query(`
      SELECT COUNT(*) AS cnt
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
    `, [tableName]);
    return Number(rows?.[0]?.cnt || 0) > 0;
  } catch (_) { return false; }
}

async function logAction({ session_id, action_type, intent, request_text, request_json, response_json, success_flg = 1, error_message = null, error_stack = null, user_id = null }) {
  const row = {
    session_id: session_id || null,
    user_id: user_id || null,
    action_type: action_type || 'AI_ACTION',
    intent: intent || null,
    request_text: shortText(request_text),
    request_json: safeJson(request_json),
    response_json: safeJson(response_json),
    success_flg: success_flg ? 1 : 0,
    error_message: error_message ? shortText(error_message, 2000) : null,
    error_stack: error_stack ? shortText(error_stack, 8000) : null
  };

  fileLogger.logAi('AI_ACTION', row);

  try {
    if (!(await tableExists('ai_action_logs'))) {
      console.log('[AI_ACTION_LOG_TABLE_MISSING]', row);
      return { saved: false, table_missing: true };
    }
    await db.query(`
      INSERT INTO ai_action_logs (
        session_id, user_id, action_type, intent, request_text,
        request_json, response_json, success_flg, error_message, error_stack, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
    `, [
      row.session_id, row.user_id, row.action_type, row.intent, row.request_text,
      row.request_json, row.response_json, row.success_flg, row.error_message, row.error_stack
    ]);
    return { saved: true };
  } catch (e) {
    console.error('[AI_ACTION_LOG_FAILED]', e.message, row);
    return { saved: false, error: e.message };
  }
}

async function logError({ session_id, action_type, intent, request_text, request_json, error, extra = {}, notify = true, user_id = null }) {
  const err = error || new Error('Unknown error');
  const payload = {
    session_id: session_id || null,
    user_id: user_id || null,
    action_type: action_type || 'AI_ERROR',
    intent: intent || null,
    request_text: shortText(request_text),
    request_json: safeJson(request_json),
    error_message: shortText(err.message || String(err), 2000),
    error_stack: shortText(err.stack || '', 8000),
    extra_json: safeJson(extra)
  };

  fileLogger.logError('AI_ERROR', payload);

  let errorId = null;
  try {
    if (await tableExists('ai_error_logs')) {
      const [r] = await db.query(`
        INSERT INTO ai_error_logs (
          session_id, user_id, action_type, intent, request_text,
          request_json, error_message, error_stack, extra_json, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'NEW', NOW())
      `, [
        payload.session_id, payload.user_id, payload.action_type, payload.intent, payload.request_text,
        payload.request_json, payload.error_message, payload.error_stack, payload.extra_json
      ]);
      errorId = r.insertId;
    } else {
      console.error('[AI_ERROR_LOG_TABLE_MISSING]', payload);
    }
  } catch (e) {
    console.error('[AI_ERROR_LOG_FAILED]', e.message, payload);
  }

  await logAction({
    session_id: payload.session_id,
    user_id: payload.user_id,
    action_type: payload.action_type,
    intent: payload.intent,
    request_text: payload.request_text,
    request_json,
    response_json: { error_id: errorId, extra },
    success_flg: 0,
    error_message: payload.error_message,
    error_stack: payload.error_stack
  });

  if (notify) {
    try {
      await notificationService.sendSupportMail({
        subject: `[MeatBiz AI Error] ${payload.action_type} failed${errorId ? ' #' + errorId : ''}`,
        text: `Action: ${payload.action_type}\nIntent: ${payload.intent || ''}\nSession: ${payload.session_id || ''}\nMessage: ${payload.request_text || ''}\nError: ${payload.error_message}\n\nStack:\n${payload.error_stack}`,
        html: `<div style="font-family:Arial,sans-serif;line-height:1.5">
          <h2>MeatBiz AI Error${errorId ? ' #' + errorId : ''}</h2>
          <p><b>Action:</b> ${payload.action_type}</p>
          <p><b>Intent:</b> ${payload.intent || ''}</p>
          <p><b>Session:</b> ${payload.session_id || ''}</p>
          <p><b>Message:</b> ${payload.request_text || ''}</p>
          <p><b>Error:</b> ${payload.error_message}</p>
          <pre style="white-space:pre-wrap;background:#fff7ed;border:1px solid #fed7aa;padding:12px;border-radius:10px">${payload.error_stack || ''}</pre>
        </div>`
      });
    } catch (mailErr) {
      fileLogger.logError('AI_ERROR_MAIL_FAILED', { error: mailErr, original_error: payload });
      console.error('[AI_ERROR_MAIL_FAILED]', mailErr.message);
    }
  }

  return { error_id: errorId, ...payload };
}

async function getLatestErrors(limit = 10) {
  if (!(await tableExists('ai_error_logs'))) return [];
  const [rows] = await db.query(`
    SELECT * FROM ai_error_logs
    ORDER BY id DESC
    LIMIT ?
  `, [Number(limit || 10)]);
  return rows;
}

module.exports = { logAction, logError, getLatestErrors };
