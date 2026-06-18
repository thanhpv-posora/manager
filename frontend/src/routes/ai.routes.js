const express = require('express');
const router = express.Router();

const customerAgent = require('../agents/customer.agent');
const debtAgent = require('../agents/debt.agent');
const reportAgent = require('../agents/report.agent');
const orderAgent = require('../agents/order.agent');
const chatAgent = require('../agents/chat.agent');
const aiPaymentAgent = require('../agents/aiPayment.agent');
const aiInsightAgent = require('../agents/aiInsight.agent');
const aiSkillAgent = require('../agents/aiSkill.agent');
const inventoryAgent = require('../agents/inventory.agent');
const aiInventoryPredictionAgent = require('../agents/aiInventoryPrediction.agent');
const aiBugInvestigatorRoutes = require('./aiBugInvestigator.routes');

router.post('/chat', chatAgent.handleChat);
router.use('/bug-investigator', aiBugInvestigatorRoutes);
router.get('/skills', aiSkillAgent.listSkills);
router.get('/manifest', aiSkillAgent.manifest);
router.get('/inventory/summary', inventoryAgent.summary);
router.get('/inventory/low-stock', inventoryAgent.lowStock);
router.get('/inventory/prediction', aiInventoryPredictionAgent.prediction);
router.get('/suppliers/suggest-orders', aiInventoryPredictionAgent.supplierSuggestion);
router.post('/suppliers/order-draft', aiInventoryPredictionAgent.supplierOrderDraft);
router.post('/suppliers/confirm-order-draft', aiInventoryPredictionAgent.confirmSupplierOrderDraft);
// Backward-compatible typo alias for terminal testing mistakes.
router.get('/supers/suggest-orders', aiInventoryPredictionAgent.supplierSuggestion);
router.post('/payment', aiPaymentAgent.createPayment);
router.post('/insight', aiInsightAgent.handleInsight);
router.post('/orders/create-draft', orderAgent.createOrderDraft);
router.get('/reports/daily', reportAgent.dailyReport);
router.get('/customers/debt', debtAgent.getCustomerDebt);
router.post('/orders/confirm-draft', orderAgent.confirmOrderDraft);
router.get('/customers/search', (req, res) => {
  return customerAgent.searchCustomer(req, res);
});

module.exports = router;