const express = require('express');
const router = express.Router();
const fileLogger = require('../services/fileLogger.service');

router.get('/tail', (req, res) => {
  try {
    const category = req.query.category || 'errors';
    const lines = Number(req.query.lines || 100);
    const data = fileLogger.tail(category, lines);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/where', (req, res) => {
  res.json({ success: true, data: { log_dir: fileLogger.ROOT, categories: ['ai', 'orders', 'errors', 'system', 'mail'] } });
});

module.exports = router;
