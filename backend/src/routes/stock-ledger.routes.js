'use strict';
const express = require('express');
const { auth } = require('../middleware/auth');
const StockLedgerAgent = require('../agents/StockLedgerAgent');
const router = express.Router();

// S5.2 — read-only ledger. GET only; no write endpoints exist for this resource.
router.get('/', auth(['ADMIN', 'STAFF']), async (req, res, next) => {
  try { res.json(await StockLedgerAgent.list(req.query)); } catch (e) { next(e); }
});

// S6.3 — read-only reconciliation (cache vs. reconstructed ledger balance).
// GET only; detects drift, never repairs it. Same resource family as the
// ledger above, so it stays under this router rather than a new prefix.
router.get('/reconciliation', auth(['ADMIN', 'STAFF']), async (req, res, next) => {
  try { res.json(await StockLedgerAgent.reconciliation(req.query)); } catch (e) { next(e); }
});

module.exports = router;
