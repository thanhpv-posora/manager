// S9 — single source of truth for the "would this line exceed stock" check.
// Mirrors the backend's postOut() gate (TRACK_STOCK, no allow_negative_stock)
// for early, non-blocking UI warning only. InventoryService/postOut() remains
// the sole business authority — this is display-only and never gates the save.
export function isQtyOverStock(inventoryMode, allowNegativeStock, stockQuantity, qty) {
  if (inventoryMode !== 'TRACK_STOCK') return false;
  if (Number(allowNegativeStock) === 1) return false;
  return Number(qty || 0) > Number(stockQuantity || 0);
}
