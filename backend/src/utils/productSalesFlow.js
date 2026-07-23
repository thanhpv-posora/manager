'use strict';

// S1G: Product Sales Domain separation. products.sales_flow (which sales
// catalog/form a product belongs to) is independent from products.inventory_mode
// (stock checking/movement/ledger/reversal). This is the single shared
// compatibility matrix and assertion, reused by ProductAgent (create/update),
// OrderAgent (order write path), and PriceMatrixAgent (price category/book
// guard) — do not duplicate this matrix locally in any caller.
// S1J: CARCASS_PART retired as a current inventory_mode — CARCASS_POS now
// pairs with exactly one current inventory_mode, same as INVENTORY_SALE.
const SALES_FLOW_INVENTORY_MODE_COMPAT = {
  CARCASS_POS: ['NON_STOCK'],
  INVENTORY_SALE: ['TRACK_STOCK'],
};

const VALID_SALES_FLOWS = Object.keys(SALES_FLOW_INVENTORY_MODE_COMPAT);

function assertValidSalesFlow(salesFlow) {
  if (!VALID_SALES_FLOWS.includes(salesFlow)) {
    throw Object.assign(
      new Error(`Luồng bán không hợp lệ: "${salesFlow}". Chỉ chấp nhận CARCASS_POS hoặc INVENTORY_SALE.`),
      { status: 400, statusCode: 400, code: 'INVALID_PRODUCT_SALES_FLOW' }
    );
  }
}

// Throws an HTTP 400 business error (never a 500) on an unapproved
// sales_flow + inventory_mode combination. Called for every new/edited
// product, and again server-side at order-write time (never trust the
// frontend's combination).
function assertSalesFlowInventoryModeCombo(salesFlow, inventoryMode) {
  assertValidSalesFlow(salesFlow);
  const allowed = SALES_FLOW_INVENTORY_MODE_COMPAT[salesFlow];
  if (!allowed.includes(inventoryMode)) {
    throw Object.assign(
      new Error(`Chế độ tồn kho "${inventoryMode}" không tương thích với luồng bán "${salesFlow}". ${salesFlow === 'CARCASS_POS' ? 'Bò Xô chỉ chấp nhận Không kiểm tồn.' : 'Hàng Kho chỉ chấp nhận Kiểm tồn kho.'}`),
      { status: 400, statusCode: 400, code: 'PRODUCT_SALES_FLOW_INVENTORY_MODE_MISMATCH' }
    );
  }
}

module.exports = { SALES_FLOW_INVENTORY_MODE_COMPAT, VALID_SALES_FLOWS, assertValidSalesFlow, assertSalesFlowInventoryModeCombo };
