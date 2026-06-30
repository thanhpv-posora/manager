'use strict';
const express = require('express');
const { auth } = require('../middleware/auth');
const PurchasePriceResolver = require('../services/PurchasePriceResolver');

const router = express.Router();

// GET /api/supplier-purchase-price?supplier_id=X&product_ids=1,2,3
// Returns negotiated purchase prices from product_supplier_links.
// Used by InventoryReceives form to pre-fill price column.
router.get('/', auth(['ADMIN', 'STAFF']), async (req, res, next) => {
  try {
    const supplierId = Number(req.query.supplier_id);
    if (!supplierId) return res.status(400).json({ message: 'supplier_id bắt buộc' });
    const ids = String(req.query.product_ids || '')
      .split(',')
      .map(s => Number(s.trim()))
      .filter(n => n > 0);
    if (!ids.length) return res.json({ prices: {} });
    const prices = await PurchasePriceResolver.resolveForSupplierItems(supplierId, ids);
    res.json({ prices });
  } catch (e) { next(e); }
});

// POST /api/supplier-purchase-price
// Upsert a negotiated price into product_supplier_links.
// Called when buyer adds an ad-hoc product and opts to save it to the supplier matrix.
router.post('/', auth(['ADMIN', 'STAFF']), async (req, res, next) => {
  try {
    const { supplier_id, product_id, purchase_price } = req.body;
    if (!supplier_id) return res.status(400).json({ message: 'supplier_id bắt buộc' });
    if (!product_id)  return res.status(400).json({ message: 'product_id bắt buộc' });
    res.json(await PurchasePriceResolver.upsertLink(Number(supplier_id), Number(product_id), purchase_price));
  } catch (e) { next(e); }
});

module.exports = router;
