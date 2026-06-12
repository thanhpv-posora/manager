module.exports = {
  name: 'InventoryPredictionSkill',
  version: '1.0.0',
  description: 'Predict stock risk from recent sales and suggest supplier ordering quantities.',
  intents: [
    'INVENTORY_PREDICTION',
    'SUPPLIER_ORDER_SUGGESTION'
  ],
  examples: [
    'dự báo tồn kho tuần tới',
    '7 ngày tới thiếu hàng gì',
    'nên nhập hàng gì',
    'đề xuất đặt nhà cung cấp'
  ],
  safety: {
    requiresConfirmation: false,
    writesDatabase: false,
    directDatabaseAccessByLLM: false
  },
  rules: {
    predictionBasis: 'Uses order_items sold quantity over lookback_days; no LLM hallucinated quantities.',
    supplierSuggestion: 'Suggests quantity only; does not create purchase lot/order automatically.'
  },
  tools: [
    'aiInventoryPredictionService.getInventoryPrediction',
    'aiInventoryPredictionService.suggestSupplierOrders'
  ]
};
