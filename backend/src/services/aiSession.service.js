const db = require('../config/db');

async function saveSession(sessionId, customerId, payload, status) {
  const [result] = await db.query(`
    INSERT INTO ai_chat_sessions (
      session_id,
      customer_id,
      draft_json,
      status
    ) VALUES (?, ?, ?, ?)
  `, [
    sessionId,
    customerId || null,
    JSON.stringify(payload),
    status
  ]);

  return result.insertId;
}

async function getLatestSessionByStatus(sessionId, status) {
  const [rows] = await db.query(`
    SELECT *
    FROM ai_chat_sessions
    WHERE session_id = ?
      AND status = ?
    ORDER BY id DESC
    LIMIT 1
  `, [sessionId, status]);

  if (rows.length === 0) {
    return null;
  }

  return {
    ...rows[0],
    draft_json: JSON.parse(rows[0].draft_json)
  };
}

async function saveDraftSession(sessionId, customerId, draft) {
  return saveSession(sessionId, customerId, draft, 'DRAFT');
}

async function getLatestDraftSession(sessionId) {
  return getLatestSessionByStatus(sessionId, 'DRAFT');
}

async function cancelOpenOrderDrafts(sessionId) {
  await db.query(`
    UPDATE ai_chat_sessions
    SET status = 'CANCELLED'
    WHERE session_id = ?
      AND status = 'DRAFT'
  `, [sessionId]);
}

async function savePaymentSession(sessionId, customerId, paymentPreview) {
  return saveSession(sessionId, customerId, paymentPreview, 'PAYMENT_DRAFT');
}

async function saveSupplierOrderSession(sessionId, draft) {
  return saveSession(sessionId, null, draft, 'SUPPLIER_ORDER_DRAFT');
}

async function getLatestPaymentSession(sessionId) {
  return getLatestSessionByStatus(sessionId, 'PAYMENT_DRAFT');
}

async function getLatestPendingSession(sessionId) {
  const [rows] = await db.query(`
    SELECT *
    FROM ai_chat_sessions
    WHERE session_id = ?
      AND status IN ('DRAFT', 'PAYMENT_DRAFT', 'SUPPLIER_ORDER_DRAFT')
    ORDER BY id DESC
    LIMIT 1
  `, [sessionId]);

  if (rows.length === 0) {
    return null;
  }

  return {
    ...rows[0],
    draft_json: JSON.parse(rows[0].draft_json)
  };
}

async function getRecentDraftSessions(limit = 5) {
  const [rows] = await db.query(`
    SELECT *
    FROM ai_chat_sessions
    WHERE status = 'DRAFT'
      AND created_at >= DATE_SUB(NOW(), INTERVAL 2 HOUR)
    ORDER BY id DESC
    LIMIT ?
  `, [Number(limit) || 5]);

  return rows.map((row) => ({
    ...row,
    draft_json: row.draft_json ? JSON.parse(row.draft_json) : null
  }));
}

async function getLatestAnyDraftSession() {
  const rows = await getRecentDraftSessions(10);
  if (rows.length === 0) return null;
  return rows[0];
}

async function updateDraftSession(id, draft) {
  await db.query(`
    UPDATE ai_chat_sessions
    SET
      draft_json = ?,
      updated_at = NOW()
    WHERE id = ?
  `, [
    JSON.stringify(draft),
    id
  ]);
}

async function markSessionConfirmed(id) {
  await db.query(`
    UPDATE ai_chat_sessions
    SET status = 'CONFIRMED'
    WHERE id = ?
  `, [id]);
}

async function markSessionCancelled(id) {
  await db.query(`
    UPDATE ai_chat_sessions
    SET status = 'CANCELLED'
    WHERE id = ?
  `, [id]);
}

module.exports = {
  saveDraftSession,
  getLatestDraftSession,
  savePaymentSession,
  getLatestPaymentSession,
  saveSupplierOrderSession,
  getLatestPendingSession,
  updateDraftSession,
  markSessionConfirmed,
  markSessionCancelled,
  cancelOpenOrderDrafts,
  getRecentDraftSessions,
  getLatestAnyDraftSession
};
