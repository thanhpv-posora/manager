const db = require('../config/db');
const { findBestMatch } = require('../utils/textNormalizer');
const InventoryService = require('./InventoryService');

function normalizeInventoryMode(value) {
  const mode = String(value || 'NON_STOCK').toUpperCase();

  // Backward compatible: older MeatBiz builds used STOCK.
  // Production rule now uses TRACK_STOCK.
  if (mode === 'TRACK_STOCK' || mode === 'STOCK') return 'TRACK_STOCK';
  if (mode === 'CARCASS_PART') return 'CARCASS_PART';
  return 'NON_STOCK';
}

function normalizeNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

async function getProductForInventory(conn, productId) {
  const [[product]] = await conn.query(`
    SELECT
      id,
      name,
      stock_quantity,
      inventory_mode,
      allow_negative_stock
    FROM products
    WHERE id = ?
    LIMIT 1
  `, [productId]);

  if (!product) {
    throw new Error(`Không tìm thấy sản phẩm ID=${productId}`);
  }

  product.inventory_mode = normalizeInventoryMode(product.inventory_mode);
  product.stock_quantity = normalizeNumber(product.stock_quantity);
  product.allow_negative_stock = Number(product.allow_negative_stock || 0);

  return product;
}

async function validateOrderInventory(conn, items = []) {
  const warnings = [];

  for (const item of items) {
    const product = await getProductForInventory(conn, item.product_id);
    const qty = normalizeNumber(item.quantity);

    if (qty <= 0) {
      throw new Error(`Số lượng không hợp lệ cho ${product.name}`);
    }

    if (product.inventory_mode === 'NON_STOCK') {
      warnings.push({
        product_id: product.id,
        product_name: product.name,
        inventory_mode: product.inventory_mode,
        action: 'SKIP_CHECK'
      });
      continue;
    }

    if (product.inventory_mode === 'CARCASS_PART') {
      warnings.push({
        product_id: product.id,
        product_name: product.name,
        inventory_mode: product.inventory_mode,
        action: 'SKIP_CHECK_LOG_OUT'
      });
      continue;
    }

    if (
      product.inventory_mode === 'TRACK_STOCK' &&
      product.allow_negative_stock !== 1 &&
      product.stock_quantity < qty
    ) {
      throw new Error(
        `Không đủ tồn kho ${product.name}. Tồn hiện tại: ${product.stock_quantity}, cần bán: ${qty}`
      );
    }
  }

  return warnings;
}

async function applyOrderInventory(conn, orderId, items = [], options = {}) {
  // All write logic lives in InventoryService (single writer rule — STAB-004).
  return InventoryService.applyOrderInventory(conn, orderId, items, options);
}

async function getInventorySummary(productName = '') {
  const keyword = String(productName || '').trim();

  const [rows] = await db.query(`
    SELECT
      p.id,
      p.name,
      p.unit,
      p.stock_quantity,
      p.low_stock_threshold,
      p.inventory_mode,
      p.allow_negative_stock
    FROM products p
    WHERE p.del_flg = 0
      AND p.is_active = 1
      AND p.inventory_mode IN ('TRACK_STOCK', 'STOCK', 'CARCASS_PART')
    ORDER BY
      CASE
        WHEN p.low_stock_threshold IS NOT NULL
         AND p.stock_quantity <= p.low_stock_threshold THEN 1
        ELSE 2
      END,
      p.name ASC
    LIMIT 10000
  `);

  if (!keyword) {
    return rows.slice(0, 50);
  }

  const matched = rows.filter((row) => {
    const best = findBestMatch(keyword, [row], (item) => item.name, 20);
    return Boolean(best);
  });

  if (matched.length > 0) {
    return matched.slice(0, 50);
  }

  const best = findBestMatch(keyword, rows, (item) => item.name, 20);
  return best ? [best.item] : [];
}

async function getLowStockProducts() {
  const [rows] = await db.query(`
    SELECT
      p.id,
      p.name,
      p.unit,
      p.stock_quantity,
      p.low_stock_threshold,
      p.inventory_mode,
      p.allow_negative_stock
    FROM products p
    WHERE p.del_flg = 0
      AND p.is_active = 1
      AND p.inventory_mode IN ('TRACK_STOCK', 'STOCK')
      AND p.low_stock_threshold IS NOT NULL
      AND p.stock_quantity <= p.low_stock_threshold
    ORDER BY p.stock_quantity ASC, p.name ASC
    LIMIT 50
  `);

  return rows;
}

module.exports = {
  validateOrderInventory,
  applyOrderInventory,
  getInventorySummary,
  getLowStockProducts
};
