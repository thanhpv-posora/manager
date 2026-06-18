const aiSkillRegistryService = require('../services/aiSkillRegistry.service');

async function listSkills(req, res) {
  try {
    return res.json({
      success: true,
      data: aiSkillRegistryService.listSkills()
    });
  } catch (err) {
    console.error('AI skill list error:', err);

    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
}

async function manifest(req, res) {
  try {
    return res.json({
      success: true,
      data: aiSkillRegistryService.buildAgentManifest()
    });
  } catch (err) {
    console.error('AI skill manifest error:', err);

    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
}

module.exports = {
  listSkills,
  manifest
};
