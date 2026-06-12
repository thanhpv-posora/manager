module.exports = {
  name: 'InsightSkill',
  version: '1.0.0',
  description: 'Answer business questions about revenue, debt, today bills, and top debtors.',
  intents: [
    'BUSINESS_INSIGHT',
    'INSIGHT_DAILY_REVENUE',
    'INSIGHT_CUSTOMER_DEBT',
    'INSIGHT_TOP_DEBTORS',
    'INSIGHT_CUSTOMER_TODAY_BILLS'
  ],
  examples: [
    'doanh thu hôm nay',
    'HongHien còn nợ bao nhiêu',
    'top khách nợ nhiều nhất',
    'bill hôm nay của HongHien'
  ],
  safety: {
    requiresConfirmation: false,
    writesDatabase: false,
    directDatabaseAccessByLLM: false
  },
  tools: [
    'aiInsightService.handleInsight'
  ]
};
