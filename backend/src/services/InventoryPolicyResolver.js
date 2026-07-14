'use strict';
const { normalizeInventoryMode } = require('../utils/inventoryMode');

// InventoryPolicyResolver — S6.1 (Inventory Policy Extraction)
//
// Pure, side-effect-free extraction of the inline policy decisions that used to live
// directly inside InventoryMovementService.postIn/postOut as ad-hoc conditionals
// (skipBalance / skipStockCheck). Answers exactly one question, given a product's
// configuration: does a movement affect the cached stock_quantity balance, and does
// it require a stock-sufficiency check first?
//
// No behavior change from the pre-extraction inline conditionals:
//   postIn's  skipBalance    === !resolve(product).affectBalance
//   postOut's skipStockCheck === !resolve(product).needStockCheck
//
// This module never queries the database and never writes anything — it only
// resolves a decision from a product row already fetched by the caller.
// InventoryMovementService remains the sole writer of stock_quantity / stock_transactions.

function resolve(product = {}) {
  const mode = normalizeInventoryMode(product.inventory_mode);
  const allowNegative = Number(product.allow_negative_stock || 0) === 1;

  // Bò Xô rule, unchanged: NON_STOCK and CARCASS_PART products never move the
  // cached balance — inventory is not the source of every sale.
  const skipModes = mode === 'NON_STOCK' || mode === 'CARCASS_PART';

  return {
    mode,
    allowNegative,
    // postIn: whether an IN movement should update products.stock_quantity.
    affectBalance: !skipModes,
    // postOut: whether an OUT movement must validate sufficient stock before
    // posting — which, for OUT, is the same gate as whether it affects the balance.
    needStockCheck: !skipModes && !allowNegative,
  };
}

module.exports = { resolve };
