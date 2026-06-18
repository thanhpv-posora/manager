const OrderSkill = require('../skills/OrderSkill');
const PaymentSkill = require('../skills/PaymentSkill');
const InsightSkill = require('../skills/InsightSkill');
const InventorySkill = require('../skills/InventorySkill');
const InventoryPredictionSkill = require('../skills/InventoryPredictionSkill');
const NluSkill = require('../skills/NluSkill');

const skills = [
  NluSkill,
  OrderSkill,
  PaymentSkill,
  InsightSkill,
  InventorySkill
];

function listSkills() {
  return skills.map((skill) => ({
    name: skill.name,
    version: skill.version,
    description: skill.description,
    intents: skill.intents,
    examples: skill.examples,
    safety: skill.safety,
    tools: skill.tools
  }));
}

function getSkillByName(name) {
  const keyword = String(name || '').trim().toLowerCase();

  return skills.find((skill) => {
    return String(skill.name || '').toLowerCase() === keyword;
  }) || null;
}

function findSkillsByIntent(intent) {
  const keyword = String(intent || '').trim().toUpperCase();

  return skills.filter((skill) => {
    return Array.isArray(skill.intents) && skill.intents.includes(keyword);
  });
}

function buildAgentManifest() {
  return {
    name: 'MeatBiz AI Agent',
    version: '1.0.0',
    architecture: 'NLU -> Intent Router -> Skill -> Business Service -> MySQL Transaction',
    safetyPrinciples: [
      'LLM never writes to database directly',
      'Write operations require confirmation unless explicitly confirm=true',
      'Business services validate customer, product, price, calendar, debt, and payment logic',
      'Fallback parser keeps the system usable when LLM is unavailable'
    ],
    skills: listSkills()
  };
}

module.exports = {
  listSkills,
  getSkillByName,
  findSkillsByIntent,
  buildAgentManifest
};
