const orderService = require('../services/order.service');

async function createOrderDraft(req, res) {
  try {
    const draft = await orderService.createOrderDraft(req.body);

    return res.json({
      success: true,
      data: draft
    });
  } catch (err) {
    console.error('AI createOrderDraft error:', err);

    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
}

async function confirmOrderDraft(req, res) {
  try {
    const data = await orderService.confirmOrderDraft(req.body);

    return res.json({
      success: true,
      data
    });
  } catch (err) {
    console.error('AI confirmOrderDraft error:', err);

    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
}

module.exports = {
  createOrderDraft,
  confirmOrderDraft
};