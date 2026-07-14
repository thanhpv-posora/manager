'use strict';

const express = require('express');
const { auth } = require('../middleware/auth');
const InventoryAdjustmentAgent = require('../agents/InventoryAdjustmentAgent');
const router = express.Router();

// S6.6 — standalone Inventory Adjustment. Admin only, per business requirement.
// No PUT/DELETE — no reversal, no editing a past adjustment (matches "No Reversal").

router.get('/', auth(['ADMIN']), async (req, res, next) => {
  try { res.json(await InventoryAdjustmentAgent.list(req.query)); } catch (e) { next(e); }
});

router.post('/', auth(['ADMIN']), async (req, res, next) => {
  try { res.json(await InventoryAdjustmentAgent.create(req.body, req.user)); } catch (e) { next(e); }
});

module.exports = router;
