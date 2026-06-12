module.exports = {
  name: 'PaymentSkill',
  version: '1.0.0',
  description: 'Preview and confirm customer payment collection with FIFO debt settlement.',
  intents: [
    'CREATE_PAYMENT',
    'PAYMENT_DRAFT',
    'CONFIRM_PREVIOUS_PAYMENT'
  ],
  examples: [
    'HongHien trả 500k',
    'HongHien ck 2tr',
    'ok thu'
  ],
  safety: {
    requiresConfirmation: true,
    writesDatabase: true,
    directDatabaseAccessByLLM: false
  },
  tools: [
    'aiPaymentService.previewPayment',
    'aiPaymentService.confirmPaymentFromPreview'
  ]
};
