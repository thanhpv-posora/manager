const express = require('express');
const { auth } = require('../middleware/auth');
const RetailSummaryAgent = require('../agents/RetailSummaryAgent');
const { parseLunarText, lunarToSolarDate } = require('../utils/lunarDate');
const router = express.Router();

router.get('/', auth(['ADMIN','STAFF']), async (req, res, next) => {
  try {
    const { business_date, calendar_type, lunar_date_text } = req.query;
    const calType = String(calendar_type || 'SOLAR').toUpperCase() === 'LUNAR' ? 'LUNAR' : 'SOLAR';
    let solarDate = business_date;
    if (calType === 'LUNAR' && lunar_date_text) {
      const parsed = parseLunarText(String(lunar_date_text));
      if (parsed) solarDate = lunarToSolarDate(parsed);
    }
    if (!solarDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(solarDate))) return res.json(null);
    res.json(await RetailSummaryAgent.getByDate(solarDate, calType));
  } catch(e) { next(e); }
});

router.post('/upsert', auth(['ADMIN','STAFF']), async (req, res, next) => {
  try {
    res.json(await RetailSummaryAgent.upsert(req.body, req.user));
  } catch(e) { next(e); }
});

module.exports = router;
