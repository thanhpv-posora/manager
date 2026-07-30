// Global quantity display formatting policy (QTY-DECIMAL-CONFIG-001).
// Every quantity shown to a user goes through formatQty() so raw floating-point
// artifacts (e.g. 588.10000000000001) never reach the screen. Driven by the
// business_settings key quantity_decimal_places (0-3, default 2). Formatting only —
// never use this to round a value before saving/calculating.
const ALLOWED_DECIMALS = [0, 1, 2, 3];
const DEFAULT_DECIMALS = 2;

let cachedDecimalPlaces = DEFAULT_DECIMALS;

export function setQuantityDecimalPlaces(value) {
  const n = Number(value);
  cachedDecimalPlaces = ALLOWED_DECIMALS.includes(n) ? n : DEFAULT_DECIMALS;
}

export function getQuantityDecimalPlaces() {
  return cachedDecimalPlaces;
}

export function formatQty(value, decimalPlaces = cachedDecimalPlaces) {
  const dp = ALLOWED_DECIMALS.includes(Number(decimalPlaces)) ? Number(decimalPlaces) : DEFAULT_DECIMALS;
  const n = Number(value || 0);
  return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export async function loadQuantityDecimalPlaces(api) {
  try {
    const r = await api.get('/settings');
    setQuantityDecimalPlaces(r.data?.quantity_decimal_places);
  } catch (e) {
    // keep whatever is already cached (default 2) if settings can't be loaded
  }
}

// Trimmed-decimal display for the quantity-expression live echo/note only
// (e.g. the "= 22" shown next to the qty input while typing "10+12", or the
// preserved "= 10+12" import note). Deliberately separate from formatQty():
// formatQty() always pads to the admin-configured decimal places (business
// display policy, used for stock/totals/etc. app-wide) — this one always
// rounds to at most 3dp and drops trailing zeros (52 -> "52", 52.5 -> "52.5",
// 52.125 -> "52.125"), which is what this specific echo needs and is not a
// change to formatQty's app-wide behavior.
export function formatQtyTrim(value, maxDecimals = 3) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '0';
  return String(Number(n.toFixed(maxDecimals)));
}

// S9/S11: non-blocking POS nudge only — InventoryService/postOut() on the backend
// remains the sole authority on whether a sale actually goes through.
export function isOverStock(inventoryMode, allowNegativeStock, stockQuantity, quantity) {
  return String(inventoryMode || '').toUpperCase() === 'TRACK_STOCK'
    && Number(allowNegativeStock) !== 1
    && Number(quantity || 0) > Number(stockQuantity || 0);
}
