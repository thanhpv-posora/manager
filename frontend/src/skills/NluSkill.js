module.exports = {
  name: 'NluSkill',
  version: '1.0.0',
  description: 'Optional LLM-based natural language understanding that extracts validated JSON intents.',
  intents: [
    'CREATE_ORDER',
    'REPEAT_ORDER',
    'ADD_ITEM',
    'REMOVE_ITEM',
    'CHANGE_QTY',
    'CREATE_PAYMENT',
    'BUSINESS_INSIGHT',
    'CONFIRM',
    'CANCEL'
  ],
  examples: [
    'chị Hiền lấy thêm ít bon với 2 ký nầm',
    'chị Sơn trả hai triệu rồi hỏi còn nợ bao nhiêu',
    'lặp lại bill gần nhất của HongHien'
  ],
  safety: {
    requiresConfirmation: 'depends_on_intent',
    writesDatabase: false,
    directDatabaseAccessByLLM: false,
    fallbackWhenUnavailable: true
  },
  tools: [
    'aiNluService.extractIntent'
  ]
};
