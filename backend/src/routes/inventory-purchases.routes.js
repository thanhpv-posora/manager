const express = require('express');
const { auth } = require('../middleware/auth');
const InventoryPurchaseAgent = require('../agents/InventoryPurchaseAgent');
const router = express.Router();

router.get('/', auth(['ADMIN', 'STAFF']), async (req, res, next) => {
  try { res.json(await InventoryPurchaseAgent.list(req.query)); } catch (e) { next(e); }
});

router.get('/:id', auth(['ADMIN', 'STAFF']), async (req, res, next) => {
  try {
    const item = await InventoryPurchaseAgent.get(req.params.id);
    if (!item) return res.status(404).json({ message: 'Không tìm thấy' });
    res.json(item);
  } catch (e) { next(e); }
});

router.post('/', auth(['ADMIN', 'STAFF']), async (req, res, next) => {
  try { res.json(await InventoryPurchaseAgent.create(req.body, req.user.id)); } catch (e) { next(e); }
});

router.patch('/:id/status', auth(['ADMIN', 'STAFF']), async (req, res, next) => {
  try { res.json(await InventoryPurchaseAgent.updateStatus(req.params.id, req.body.status, req.user.id)); } catch (e) { next(e); }
});

module.exports = router;
