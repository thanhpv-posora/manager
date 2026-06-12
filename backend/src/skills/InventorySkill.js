module.exports = {
  name: 'InventorySkill',
  version: '1.0.0',
  description: 'Validate, deduct, and report inventory using product inventory_mode.',
  intents: [
    'INVENTORY_CHECK',
    'LOW_STOCK_ALERT',
    'ORDER_INVENTORY_VALIDATE',
    'ORDER_INVENTORY_APPLY'
  ],
  examples: [
    'còn bao nhiêu gà',
    'sản phẩm nào sắp hết',
    'kiểm tra tồn kho Nầm'
  ],
  safety: {
    requiresConfirmation: false,
    writesDatabase: 'only_when_order_confirmed',
    directDatabaseAccessByLLM: false
  },
  rules: {
    NON_STOCK: 'Không kiểm tồn và không trừ kho',
    TRACK_STOCK: 'Kiểm tồn thật và trừ kho thật',
    CARCASS_PART: 'Không chặn bán nhưng ghi OUT transaction để phân tích carcass/yield'
  },
  tools: [
    'inventoryService.validateOrderInventory',
    'inventoryService.applyOrderInventory',
    'inventoryService.getInventorySummary',
    'inventoryService.getLowStockProducts'
  ]
};
