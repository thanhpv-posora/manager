const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');

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

// GO-LIVE P0: this entire router had NO auth middleware at all — every route
// below (including order confirmation, payment creation, supplier order
// confirmation, customer debt/PII lookup, and daily revenue reports) was
// reachable by anyone, unauthenticated. auth(['ADMIN','STAFF']) matches the
// role pair every other business-write route in this codebase already uses
// (inventory-receives, supplier-payable, ...) and matches this feature's own
// menu grants (dashboard/agents are ADMIN-only by default; the AI panels
// that call these routes are embedded in CreateOrder.jsx, which STAFF also
// has access to). Applied once, router-wide, so it also covers the
// '/bug-investigator' sub-router mounted below — none of the handlers behind
// these routes read req.user for their own logic (verified), so this is a
// pure auth gate with no behavior change for already-authenticated callers.
router.use(auth(['ADMIN', 'STAFF']));

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