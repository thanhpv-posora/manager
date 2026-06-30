'use strict';

// Canonical inventory mode helper — shared across ProductAgent, InventoryService,
// InventoryMovementService, and InventoryPurchaseAgent.
//
// DB enum: enum('NON_STOCK','TRACK_STOCK','CARCASS_PART')
// 'STOCK' is a legacy alias for TRACK_STOCK that no longer exists in the DB.

function normalizeInventoryMode(value) {
  const mode = String(value || 'NON_STOCK').toUpperCase();
  if (mode === 'TRACK_STOCK' || mode === 'STOCK') return 'TRACK_STOCK';
  if (mode === 'CARCASS_PART') return 'CARCASS_PART';
  return 'NON_STOCK';
}

function isStockTracked(value) {
  return normalizeInventoryMode(value) === 'TRACK_STOCK';
}

module.exports = { normalizeInventoryMode, isStockTracked };

// TODO INV-006: replace inventory_mode with a transaction-level flag
//   affect_inventory / stock_policy on purchase_order_items / order_items.
//   Product master should only carry a technical default; actual stock behaviour
//   is decided per-transaction (PO receive, sale, return, adjustment).
