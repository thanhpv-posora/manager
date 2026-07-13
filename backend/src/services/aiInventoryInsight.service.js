const inventoryService = require('./inventory.service');
const { formatQty } = require('../utils/quantityFormat');

function normalizeText(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/tồn kho/g, 'ton kho')
    .replace(/còn/g, 'con')
    .replace(/bao nhiêu/g, 'bao nhieu')
    .replace(/sắp hết/g, 'sap het')
    .replace(/hết hàng/g, 'het hang')
    .replace(/kiểm tra/g, 'kiem tra')
    .replace(/gà/g, 'ga')
    .replace(/vịt/g, 'vit')
    .replace(/nầm/g, 'nam')
    .replace(/gầu/g, 'gau')
    .replace(/\s+/g, ' ');
}

function isInventoryMessage(message) {
  const text = normalizeText(message);

  return (
    text.includes('ton kho') ||
    text.includes('con bao nhieu') ||
    text.includes('sap het') ||
    text.includes('het hang') ||
    text.includes('kiem tra ton') ||
    /^con\s+.+/i.test(text)
  );
}

function extractProductName(message) {
  const text = normalizeText(message);

  const patterns = [
    /con bao nhieu\s+(.+)$/i,
    /con\s+(.+)\s+bao nhieu/i,
    /ton kho\s+(.+)$/i,
    /kiem tra ton(?: kho)?\s+(.+)$/i,
    /^con\s+(.+)$/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return match[1]
        .replace(/\b(kg|con|cai|thung|bao)\b/gi, '')
        .trim();
    }
  }

  return '';
}

async function handleInventoryInsight(message) {
  const text = normalizeText(message);

  if (text.includes('sap het') || text.includes('het hang')) {
    const rows = await inventoryService.getLowStockProducts();

    return {
      intent: 'INVENTORY_LOW_STOCK',
      data: rows,
      text: rows.length === 0
        ? 'Hiện chưa có sản phẩm TRACK_STOCK nào dưới ngưỡng tồn kho.'
        : 'Các sản phẩm sắp hết:\n' + rows.map((row, index) => {
            return `${index + 1}. ${row.name}: còn ${formatQty(row.stock_quantity)} ${row.unit || ''}, ngưỡng ${formatQty(row.low_stock_threshold)}.`;
          }).join('\n')
    };
  }

  const productName = extractProductName(message);
  const rows = await inventoryService.getInventorySummary(productName);

  return {
    intent: 'INVENTORY_SUMMARY',
    query: productName,
    data: rows,
    text: rows.length === 0
      ? (productName
          ? `Không tìm thấy sản phẩm kiểm tồn phù hợp với: ${productName}.`
          : 'Không có sản phẩm kiểm tồn phù hợp.')
      : rows.map((row) => {
          return `${row.name}: còn ${formatQty(row.stock_quantity)} ${row.unit || ''} (${row.inventory_mode})`;
        }).join('\n')
  };
}

module.exports = {
  isInventoryMessage,
  handleInventoryInsight
};
