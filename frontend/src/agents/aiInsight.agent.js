const aiInsightService = require('../services/aiInsight.service');

async function handleInsight(req, res) {
  try {
    const { message } = req.body;

    const data = await aiInsightService.handleInsight(message);

    return res.json({
      success: true,
      data
    });
  } catch (err) {
    console.error('AI insight error:', err);

    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
}

module.exports = {
  handleInsight
};
