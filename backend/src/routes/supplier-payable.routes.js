'use strict';
const express = require('express');
const { auth } = require('../middleware/auth');
const SupplierPayableAgent = require('../agents/SupplierPayableAgent');
const router = express.Router();

// S10.1 — Supplier Payable (Purchase Order / Receive domain only, never the
// legacy lot-based supplier_payments table). Reads: ADMIN/STAFF, matching
// every other Purchase route (inventory-purchases, inventory-receives).
router.get('/:supplierId/summary', auth(['ADMIN', 'STAFF']), async (req, res, next) => {
  try { res.json(await SupplierPayableAgent.summary(req.params.supplierId)); } catch (e) { next(e); }
});

router.get('/:supplierId/history', auth(['ADMIN', 'STAFF']), async (req, res, next) => {
  try { res.json(await SupplierPayableAgent.history(req.params.supplierId, req.query)); } catch (e) { next(e); }
});

// ADMIN only for financial payment creation — no existing rule explicitly
// approves STAFF for this new domain (same default this project already
// chose for Order Cancel, S8.2).
router.post('/payment', auth(['ADMIN']), async (req, res, next) => {
  try { res.json(await SupplierPayableAgent.createPayment(req.body, req.user)); } catch (e) { next(e); }
});

module.exports = router;
