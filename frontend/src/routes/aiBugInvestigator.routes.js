const express = require('express');
const router = express.Router();
const investigator = require('../services/aiBugInvestigator.service');

router.get('/latest', async (req, res) => {
  try {
    const data = await investigator.investigateLatest();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/list', async (req, res) => {
  try {
    const data = await investigator.listInvestigations(Number(req.query.limit || 10));
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
