const express = require('express');
const { auth } = require('../middleware/auth');
const UnitAgent = require('../agents/UnitAgent');
const router = express.Router();

router.get('/', auth(['ADMIN', 'STAFF']), async (req, res, next) => {
  try { res.json(await UnitAgent.list()); } catch (e) { next(e); }
});
router.post('/', auth(['ADMIN', 'STAFF']), async (req, res, next) => {
  try { res.json(await UnitAgent.create(req.body)); } catch (e) { next(e); }
});
router.put('/:id', auth(['ADMIN', 'STAFF']), async (req, res, next) => {
  try { res.json(await UnitAgent.update(req.params.id, req.body)); } catch (e) { next(e); }
});
router.delete('/:id', auth(['ADMIN', 'STAFF']), async (req, res, next) => {
  try { res.json(await UnitAgent.disable(req.params.id)); } catch (e) { next(e); }
});

module.exports = router;
