'use strict';

const express = require('express');
const { auth } = require('../middleware/auth');
const WarehouseAgent = require('../agents/WarehouseAgent');
const router = express.Router();

// GET /api/warehouses — active warehouses, default first.
router.get('/', auth(['ADMIN', 'STAFF']), async (req, res, next) => {
  try { res.json(await WarehouseAgent.list()); } catch (e) { next(e); }
});

module.exports = router;
