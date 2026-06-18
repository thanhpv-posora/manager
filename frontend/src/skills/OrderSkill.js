module.exports = {
  name: 'OrderSkill',
  version: '1.0.0',
  description: 'Create, edit, confirm, cancel, and repeat customer orders by natural language.',
  intents: [
    'CREATE_ORDER',
    'ADD_ITEM',
    'REMOVE_ITEM',
    'CHANGE_QTY',
    'CONFIRM_PREVIOUS_ORDER',
    'CANCEL_PREVIOUS_DRAFT',
    'REPEAT_ORDER'
  ],
  examples: [
    'HongHien 5 Bon 2 Nam',
    'thêm 1 Gau',
    'bỏ Bon',
    'đổi Nam 3',
    'HongHien lấy như hôm qua',
    'ok lưu',
    'hủy'
  ],
  safety: {
    requiresConfirmation: true,
    writesDatabase: true,
    directDatabaseAccessByLLM: false
  },
  tools: [
    'orderService.createOrderDraft',
    'orderService.confirmOrderDraft',
    'orderService.createRepeatOrderDraft',
    'aiSessionService.saveDraftSession',
    'aiSessionService.updateDraftSession'
  ]
};
