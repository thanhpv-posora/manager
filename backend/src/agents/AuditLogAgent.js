'use strict';
const pool = require('../config/db');

// AuditLogAgent — P1-02 (Production Readiness audit finding C2).
//
// Read-only viewer for the existing `audit_logs` table (bootstrap.js —
// id, user_id, action, entity_type, entity_id, note, created_at). This is
// the ONLY general-purpose, entity-agnostic audit table in the schema
// (see ReturnAgent.js's own header comment) — currently written by
// ReturnAgent.js (Sales Return lifecycle) and aiSupplierOrdering.service.js
// (AI-generated PO drafts). This agent adds the missing read path; it does
// NOT write to audit_logs, does NOT touch delete_logs/Trash, and does NOT
// backfill history for modules that never wrote to it.
//
// Scope discipline (locked for this story): audit_logs only. Unifying this
// with delete_logs, orders.cancelled_* columns, or debt_transactions
// reversal rows is explicitly out of scope — see the audit's own finding
// M4 for that broader (future) consolidation question.

function badRequest(message, code) {
  const err = new Error(message);
  err.status = 400; err.statusCode = 400;
  if (code) err.code = code;
  return err;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// created_at is DATETIME; range filters use half-open >= start / < next-day
// bounds rather than DATE(created_at) so the (future) idx_audit_logs_created_at
// index stays usable — DATE()-wrapping an indexed column defeats index range
// scans in MySQL because the optimizer can't push a function of the column
// through the index.
function nextDayAfter(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class AuditLogAgent {
  constructor() {
    this.version = '1.0.0';
    this.responsibility = 'P1-02 — read-only query API over the existing audit_logs table. Never writes to it.';
  }

  // GET /api/audit-logs — ADMIN only (enforced at the route layer).
  async list(query = {}) {
    const where = ['1=1'];
    const params = [];

    if (query.entity_type) {
      where.push('al.entity_type = ?');
      params.push(String(query.entity_type).trim());
    }

    if (query.entity_id !== undefined && query.entity_id !== '' && query.entity_id !== null) {
      const entityId = Number(query.entity_id);
      if (!Number.isFinite(entityId)) throw badRequest('entity_id phải là số', 'INVALID_ENTITY_ID');
      where.push('al.entity_id = ?');
      params.push(entityId);
    }

    if (query.action) {
      where.push('al.action = ?');
      params.push(String(query.action).trim());
    }

    if (query.user_id !== undefined && query.user_id !== '' && query.user_id !== null) {
      const userId = Number(query.user_id);
      if (!Number.isFinite(userId)) throw badRequest('user_id phải là số', 'INVALID_USER_ID');
      where.push('al.user_id = ?');
      params.push(userId);
    }

    if (query.from_date) {
      const fromDate = String(query.from_date).slice(0, 10);
      if (!DATE_RE.test(fromDate)) throw badRequest('from_date không hợp lệ (YYYY-MM-DD)', 'INVALID_FROM_DATE');
      where.push('al.created_at >= ?');
      params.push(`${fromDate} 00:00:00`);
    }

    if (query.to_date) {
      const toDate = String(query.to_date).slice(0, 10);
      if (!DATE_RE.test(toDate)) throw badRequest('to_date không hợp lệ (YYYY-MM-DD)', 'INVALID_TO_DATE');
      const next = nextDayAfter(toDate);
      if (!next) throw badRequest('to_date không hợp lệ (YYYY-MM-DD)', 'INVALID_TO_DATE');
      where.push('al.created_at < ?');
      params.push(`${next} 00:00:00`);
    }

    if (query.search) {
      const term = `%${String(query.search).trim()}%`;
      where.push('(al.note LIKE ? OR al.action LIKE ? OR al.entity_type LIKE ?)');
      params.push(term, term, term);
    }

    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(query.limit) || DEFAULT_LIMIT));
    const offset = (page - 1) * limit;

    const whereSql = where.join(' AND ');

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) total FROM audit_logs al WHERE ${whereSql}`, params
    );

    // Stable newest-first sort: created_at DESC alone is not a stable order
    // when two rows share the same timestamp (same-second concurrent writes
    // are plausible under real load) — id DESC as the tie-break makes the
    // order deterministic without relying on insertion order being preserved
    // by the storage engine.
    const [rows] = await pool.query(
      `SELECT al.id, al.action, al.entity_type, al.entity_id, al.note, al.user_id,
              u.full_name user_name, al.created_at
       FROM audit_logs al
       LEFT JOIN users u ON u.id = al.user_id
       WHERE ${whereSql}
       ORDER BY al.created_at DESC, al.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return {
      rows,
      pagination: {
        page, limit, total: Number(total),
        total_pages: Math.max(1, Math.ceil(Number(total) / limit)),
      },
    };
  }
}

module.exports = new AuditLogAgent();
