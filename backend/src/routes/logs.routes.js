const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const fileLogger = require('../services/fileLogger.service');

// ADMIN only. These endpoints had NO authentication at all: GET /api/logs/tail
// returned raw application log contents to any unauthenticated caller —
// customer phone numbers, order/debt amounts, request payloads, client IPs and
// error stacks — and GET /api/logs/where disclosed the server's filesystem
// path. Same gap class as /api/ai/* (CR-1), which this router was missed by.
//
// ADMIN rather than ADMIN+STAFF: the log tail is cross-customer diagnostic
// data, matching how /api/schema and /api/migrations are already gated.
router.get('/tail', auth(['ADMIN']), (req, res) => {
  try {
    const category = req.query.category || 'errors';
    const lines = Number(req.query.lines || 100);
    const data = fileLogger.tail(category, lines);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/where', auth(['ADMIN']), (req, res) => {
  res.json({ success: true, data: { log_dir: fileLogger.ROOT, categories: ['ai', 'orders', 'errors', 'system', 'mail'] } });
});

module.exports = router;
