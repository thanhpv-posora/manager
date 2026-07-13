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
