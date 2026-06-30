const express = require('express');
const { auth } = require('../middleware/auth');
const RetailSummaryAgent = require('../agents/RetailSummaryAgent');
const { solarToLunar, parseLunarText, lunarToSolarDate } = require('../utils/lunarDate');
const router = express.Router();

function lunarToText(l) {
  if (!l) return '';
  return `${String(l.day).padStart(2,'0')}/${String(l.month).padStart(2,'0')}/${l.year}`;
}

// Bidirectional date conversion — no record required
router.get('/convert-date', auth(['ADMIN','STAFF']), async (req, res, next) => {
  try {
    const { solar_date, lunar_date_text } = req.query;
    if (solar_date && /^\d{4}-\d{2}-\d{2}$/.test(solar_date)) {
      return res.json({ solar_date, lunar_date_text: lunarToText(solarToLunar(solar_date)) });
    }
    if (lunar_date_text) {
      const parsed = parseLunarText(String(lunar_date_text));
      if (!parsed) return res.json(null);
      const sd = lunarToSolarDate(parsed);
      return res.json({ solar_date: sd, lunar_date_text: String(lunar_date_text).trim() });
    }
    res.json(null);
  } catch(e) { next(e); }
});

router.get('/', auth(['ADMIN','STAFF']), async (req, res, next) => {
  try {
    const { business_date, calendar_type, lunar_date_text } = req.query;
    res.json(await RetailSummaryAgent.getByDate(business_date, calendar_type, lunar_date_text));
  } catch(e) { next(e); }
});

router.post('/upsert', auth(['ADMIN','STAFF']), async (req, res, next) => {
  try {
    res.json(await RetailSummaryAgent.upsert(req.body, req.user));
  } catch(e) { next(e); }
});

module.exports = router;
