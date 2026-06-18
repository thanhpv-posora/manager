const aiPaymentService = require('../services/aiPayment.service');

async function createPayment(req, res) {
  try {
    const { message, confirm = false } = req.body;

    const data = await aiPaymentService.createPaymentFromMessage(message, {
      confirm,
      user: { id: null, role: 'ADMIN' }
    });

    return res.json({
      success: true,
      data
    });
  } catch (err) {
    console.error('AI payment error:', err);

    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
}

module.exports = {
  createPayment
};
