'use strict';
const express = require('express');
const { auth } = require('../middleware/auth');
const SupplierPurchaseCatalogResolver = require('../services/SupplierPurchaseCatalogResolver');

const router = express.Router();

// GET /api/supplier-catalog?partner_id=X&purchase_date=Y&calendar_type=SOLAR
// Returns the full purchase catalog for a supplier on an effective date.
// Items come from product_supplier_links (price) + supplier_purchase_options (SPO metadata).
// Requires either partner_id or supplier_id.
router.get('/', auth(['ADMIN', 'STAFF']), async (req, res, next) => {
  try {
    const { partner_id, supplier_id, purchase_date, calendar_type } = req.query;
    if (!partner_id && !supplier_id)
      return res.status(400).json({ message: 'Cần partner_id hoặc supplier_id' });
    const catalog = await SupplierPurchaseCatalogResolver.resolveCatalog(
      partner_id ? Number(partner_id) : null,
      supplier_id ? Number(supplier_id) : null,
      purchase_date || new Date().toISOString().slice(0, 10),
      calendar_type || 'SOLAR'
    );
    res.json(catalog);
  } catch (e) { next(e); }
});

module.exports = router;
