const inventoryService = require('../services/inventory.service');

function formatMoneyLikeNumber(value) {
  return Number(value || 0).toLocaleString('vi-VN');
}

async function summary(req, res) {
  try {
    const { q = '' } = req.query;
    const rows = await inventoryService.getInventorySummary(q);

    return res.json({
      success: true,
      data: rows,
      text: rows.length === 0
        ? 'Không có sản phẩm kiểm tồn phù hợp.'
        : rows.map((row) => {
            return `${row.name}: ${formatMoneyLikeNumber(row.stock_quantity)} ${row.unit || ''} (${row.inventory_mode})`;
          }).join('\\n')
    });
  } catch (err) {
    console.error('AI inventory summary error:', err);

    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
}

async function lowStock(req, res) {
  try {
    const rows = await inventoryService.getLowStockProducts();

    return res.json({
      success: true,
      data: rows,
      text: rows.length === 0
        ? 'Hiện chưa có sản phẩm nào dưới ngưỡng tồn kho.'
        : rows.map((row) => {
            return `${row.name}: còn ${formatMoneyLikeNumber(row.stock_quantity)} ${row.unit || ''}, ngưỡng ${formatMoneyLikeNumber(row.low_stock_threshold)}.`;
          }).join('\\n')
    });
  } catch (err) {
    console.error('AI inventory low stock error:', err);

    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
}

module.exports = {
  summary,
  lowStock
};
