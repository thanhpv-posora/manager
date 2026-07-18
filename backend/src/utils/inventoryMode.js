'use strict';

// Canonical inventory mode helper — shared across ProductAgent, InventoryService,
// InventoryMovementService, and InventoryPurchaseAgent.
//
// S1J: current Product inventory domain is exactly NON_STOCK / TRACK_STOCK.
// CARCASS_PART is retired as a current classification — this function is the
// single centralized compatibility boundary for it: a historical product row
// or order_items snapshot still carrying the legacy value reads as NON_STOCK
// (its original runtime semantics — no stock validation, no Inventory OUT, no
// ledger balance movement — are identical to NON_STOCK, so nothing about
// historical reads/reversal changes). This is a HISTORICAL-READ boundary only;
// it must never be used to make CARCASS_PART an acceptable NEW-write value —
// current-write validation (ProductAgent.assertProductClassification /
// VALID_INVENTORY_MODE_FILTERS) rejects CARCASS_PART before this is ever
// reached on a write path.
//
// 'STOCK' is a legacy alias for TRACK_STOCK that no longer exists in the DB.
function normalizeInventoryMode(value) {
  const mode = String(value || 'NON_STOCK').toUpperCase();
  if (mode === 'TRACK_STOCK' || mode === 'STOCK') return 'TRACK_STOCK';
  if (mode === 'CARCASS_PART') return 'NON_STOCK';
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
