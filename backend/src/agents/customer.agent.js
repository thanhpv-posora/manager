const customerService = require('../services/customer.service');

async function searchCustomer(req, res) {
  try {
    const { q = '' } = req.query;
    const data = await customerService.searchCustomer(q);

    res.json({
      success: true,
      data
    });
  } catch (err) {
    console.error('AI searchCustomer error:', err);
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
}

module.exports = {
  searchCustomer
};