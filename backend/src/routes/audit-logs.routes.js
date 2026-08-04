'use strict';
const express = require('express');
const { auth } = require('../middleware/auth');
const AuditLogAgent = require('../agents/AuditLogAgent');
const router = express.Router();

// P1-02 — ADMIN only. STAFF/CUSTOMER get 403 from auth() itself (same
// pattern as every other ADMIN-only route in this codebase, e.g.
// permissions.js's /users route) — no additional in-agent role check needed.
router.get('/', auth(['ADMIN']), async (req, res, next) => {
  try { res.json(await AuditLogAgent.list(req.query)); } catch (e) { next(e); }
});

module.exports = router;
