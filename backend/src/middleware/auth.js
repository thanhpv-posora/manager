const jwt = require('jsonwebtoken');
const pool = require('../config/db');

function auth(roles = []) {
  return async (req, res, next) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ message: 'Chưa đăng nhập' });
    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (e) {
      return res.status(401).json({ message: 'Token không hợp lệ' });
    }
    // AUTH-SCOPE-001 (Phase 1 authorization foundation): the JWT alone only
    // proves the token was valid at issue time (7-day expiry — see
    // routes/auth.js login). It says nothing about whether the account is
    // still active right now, so a deactivated account's already-issued
    // token previously kept working for up to 7 more days. Re-check
    // is_active on every authenticated request instead — one indexed
    // users.id (primary key) lookup, correctness over premature caching.
    // Public unauthenticated routes (order/lot print-by-token) never call
    // auth() at all and are untouched by this.
    try {
      const [rows] = await pool.query(`SELECT is_active FROM users WHERE id=? LIMIT 1`, [payload.id]);
      if (!rows.length || !rows[0].is_active) {
        return res.status(401).json({ message: 'Tài khoản đã bị khóa hoặc không còn tồn tại' });
      }
    } catch (e) {
      return next(e);
    }
    req.user = payload;
    if (roles.length && !roles.includes(payload.role)) return res.status(403).json({ message: 'Không có quyền' });
    next();
  };
}

// AUTH-SCOPE-001 (Phase 1): structural convenience wrappers so a future
// route can't accidentally omit ADMIN from its role array. Equivalent to
// auth(['ADMIN']) / auth(['ADMIN','STAFF']) respectively — purely additive;
// every existing auth([...]) call site is completely unaffected.
auth.adminOnly = () => auth(['ADMIN']);
auth.staffOrAdmin = () => auth(['ADMIN', 'STAFF']);

module.exports = { auth };
