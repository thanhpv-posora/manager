const express = require('express');
const { auth } = require('../middleware/auth');
const PartnerAgent = require('../agents/PartnerAgent');
const router = express.Router();

// GET /api/partners?role=supplier|customer|both|all
router.get('/', auth(['ADMIN', 'STAFF', 'CUSTOMER']), async (req, res, next) => {
  try {
    const data = await PartnerAgent.listPartners(req.user, { role: req.query.role || 'all' });
    res.json(data);
  } catch (e) { next(e); }
});

module.exports = router;
