const express = require('express');
const { auth } = require('../middleware/auth');
const SupplierPurchaseOptionAgent = require('../agents/SupplierPurchaseOptionAgent');
const router = express.Router();

router.get('/units', auth(['ADMIN', 'STAFF']), async (req, res, next) => {
  try { res.json(await SupplierPurchaseOptionAgent.listUnits()); } catch (e) { next(e); }
});
router.get('/', auth(['ADMIN', 'STAFF']), async (req, res, next) => {
  try {
    const { supplier_id, product_id } = req.query;
    if (!supplier_id || !product_id) return res.status(400).json({ message: 'Thiếu supplier_id hoặc product_id' });
    res.json(await SupplierPurchaseOptionAgent.listBySupplierProduct(supplier_id, product_id));
  } catch (e) { next(e); }
});
router.post('/', auth(['ADMIN', 'STAFF']), async (req, res, next) => {
  try { res.json(await SupplierPurchaseOptionAgent.create(req.body)); } catch (e) { next(e); }
});
router.put('/:id', auth(['ADMIN', 'STAFF']), async (req, res, next) => {
  try { res.json(await SupplierPurchaseOptionAgent.update(req.params.id, req.body)); } catch (e) { next(e); }
});
router.delete('/:id', auth(['ADMIN', 'STAFF']), async (req, res, next) => {
  try { res.json(await SupplierPurchaseOptionAgent.disable(req.params.id)); } catch (e) { next(e); }
});

module.exports = router;
