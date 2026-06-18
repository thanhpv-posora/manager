const predictionService = require('../services/aiInventoryPrediction.service');
const supplierOrderingService = require('../services/aiSupplierOrdering.service');

async function prediction(req, res) {
  try {
    const data = await predictionService.getInventoryPrediction(req.query || {});
    return res.json({ success: true, data });
  } catch (err) {
    console.error('AI inventory prediction error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
}

async function supplierSuggestion(req, res) {
  try {
    const data = await predictionService.suggestSupplierOrders(req.query || {});
    return res.json({ success: true, data });
  } catch (err) {
    console.error('AI supplier order suggestion error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
}

async function supplierOrderDraft(req, res) {
  try {
    const data = await supplierOrderingService.buildSupplierOrderDraft(req.body || req.query || {});
    return res.json({ success: true, data });
  } catch (err) {
    console.error('AI supplier order draft error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
}

async function confirmSupplierOrderDraft(req, res) {
  try {
    const data = await supplierOrderingService.confirmSupplierOrderDraft(req.body.draft, req.user || { id: null, role: 'ADMIN' });
    return res.json({ success: true, data });
  } catch (err) {
    console.error('AI supplier order confirm error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = {
  prediction,
  supplierSuggestion,
  supplierOrderDraft,
  confirmSupplierOrderDraft
};
