const reportService = require('../services/report.service');

async function dailyReport(req, res) {
  try {

    const data = await reportService.dailyReport();

    res.json({
      success: true,
      data
    });

  } catch (err) {

    console.error('AI dailyReport error:', err);

    res.status(500).json({
      success: false,
      message: err.message
    });

  }
}

module.exports = {
  dailyReport
};