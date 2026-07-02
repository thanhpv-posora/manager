'use strict';

const express = require('express');
const { auth } = require('../middleware/auth');
const InventoryReceiveAgent = require('../agents/InventoryReceiveAgent');
const router = express.Router();

// GET /api/inventory-receives
router.get('/', auth(['ADMIN', 'STAFF']), async (req, res, next) => {
  try { res.json(await InventoryReceiveAgent.list(req.query)); } catch (e) { next(e); }
});

// GET /api/inventory-receives/received-summary?purchase_order_id=X
// S4.1-B: derived received-so-far per PO line (kg), read-only. Must be declared
// before /:id or Express would match "received-summary" as an :id.
router.get('/received-summary', auth(['ADMIN', 'STAFF']), async (req, res, next) => {
  try {
    const purchaseOrderId = req.query.purchase_order_id;
    if (!purchaseOrderId) return res.status(400).json({ message: 'Thiếu purchase_order_id' });
    res.json(await InventoryReceiveAgent.getReceivedSummary(purchaseOrderId));
  } catch (e) { next(e); }
});

// GET /api/inventory-receives/:id
router.get('/:id', auth(['ADMIN', 'STAFF']), async (req, res, next) => {
  try {
    const item = await InventoryReceiveAgent.get(req.params.id);
    if (!item) return res.status(404).json({ message: 'Không tìm thấy phiếu nhận hàng' });
    res.json(item);
  } catch (e) { next(e); }
});

// POST /api/inventory-receives
router.post('/', auth(['ADMIN', 'STAFF']), async (req, res, next) => {
  try { res.json(await InventoryReceiveAgent.create(req.body, req.user.id)); } catch (e) { next(e); }
});

// POST /api/inventory-receives/:id/receive
router.post('/:id/receive', auth(['ADMIN', 'STAFF']), async (req, res, next) => {
  try { res.json(await InventoryReceiveAgent.receive(req.params.id, req.user.id)); } catch (e) { next(e); }
});

// POST /api/inventory-receives/:id/cancel
router.post('/:id/cancel', auth(['ADMIN', 'STAFF']), async (req, res, next) => {
  try { res.json(await InventoryReceiveAgent.cancel(req.params.id, req.user.id)); } catch (e) { next(e); }
});

module.exports = router;
