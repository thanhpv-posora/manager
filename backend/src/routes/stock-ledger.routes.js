'use strict';
const express = require('express');
const { auth } = require('../middleware/auth');
const StockLedgerAgent = require('../agents/StockLedgerAgent');
const router = express.Router();

// S5.2 — read-only ledger. GET only; no write endpoints exist for this resource.
router.get('/', auth(['ADMIN', 'STAFF']), async (req, res, next) => {
  try { res.json(await StockLedgerAgent.list(req.query)); } catch (e) { next(e); }
});

module.exports = router;
