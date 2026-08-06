const aiPaymentService = require('../services/aiPayment.service');

async function createPayment(req, res) {
  try {
    const { message, confirm = false } = req.body;

    // GO-LIVE F-AI-ATTRIBUTION (Flow 5 audit): previously hardcoded a
    // synthetic { id: null, role: 'ADMIN' } here regardless of who actually
    // called this route — /api/ai is auth(['ADMIN','STAFF']) at the router
    // level (server.js), so req.user is always the real authenticated staff
    // account. Every AI-created payment was being recorded with no creator
    // (created_by=NULL), breaking BR-CORE-002/BR-SEC-008 traceability for
    // this entire flow. Use the real caller.
    const data = await aiPaymentService.createPaymentFromMessage(message, {
      confirm,
      user: req.user
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
