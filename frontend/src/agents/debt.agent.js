const debtService = require('../services/debt.service');

async function getCustomerDebt(req, res) {
  try {
    const { name = '' } = req.query;
    const data = await debtService.getCustomerDebt(name);

    res.json({
      success: true,
      data
    });
  } catch (err) {
    console.error('AI getCustomerDebt error:', err);
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
}

module.exports = {
  getCustomerDebt
};