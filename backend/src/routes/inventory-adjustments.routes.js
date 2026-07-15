'use strict';

const express = require('express');
const { auth } = require('../middleware/auth');
const InventoryAdjustmentAgent = require('../agents/InventoryAdjustmentAgent');
const router = express.Router();

// S6.6/S7.2 — standalone Inventory Adjustment. Admin only, per business requirement.
// No PUT/DELETE — no reversal, no editing a past adjustment (matches "No Reversal").

router.get('/', auth(['ADMIN']), async (req, res, next) => {
  try { res.json(await InventoryAdjustmentAgent.list(req.query)); } catch (e) { next(e); }
});

router.post('/', auth(['ADMIN']), async (req, res, next) => {
  try { res.json(await InventoryAdjustmentAgent.create(req.body, req.user)); } catch (e) { next(e); }
});

// S7.2 — bulk Excel-style stock count save. One request, one DB transaction,
// looping the existing per-item adjustment logic (create()'s own
// _applyOneAdjustment) once per product whose actual quantity actually
// changed. No batch header, no new document model — every row lands in the
// existing inventory_adjustments table exactly like a standalone create() would.
router.post('/batch', auth(['ADMIN']), async (req, res, next) => {
  try { res.json(await InventoryAdjustmentAgent.createBatch(req.body, req.user)); } catch (e) { next(e); }
});

module.exports = router;
