const pool = require('../config/db');

// Global quantity display formatting policy (QTY-DECIMAL-CONFIG-001).
// Every backend-generated quantity display (print HTML, AI chat/insight text,
// validation error messages) goes through formatQty() so raw floating-point
// artifacts (e.g. 588.10000000000001) never reach the user. Driven by the
// business_settings key quantity_decimal_places (0-3, default 2), cached in
// memory and refreshed at startup / whenever settings are saved. Presentation
// only — never use this to round a value before saving/calculating.
const ALLOWED_DECIMALS = [0, 1, 2, 3];
const DEFAULT_DECIMALS = 2;

let cachedDecimalPlaces = DEFAULT_DECIMALS;

function setQuantityDecimalPlaces(value) {
  const n = Number(value);
  cachedDecimalPlaces = ALLOWED_DECIMALS.includes(n) ? n : DEFAULT_DECIMALS;
}

function getQuantityDecimalPlaces() {
  return cachedDecimalPlaces;
}

function formatQty(value, decimalPlaces = cachedDecimalPlaces) {
  const dp = ALLOWED_DECIMALS.includes(Number(decimalPlaces)) ? Number(decimalPlaces) : DEFAULT_DECIMALS;
  return Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

async function refreshQuantityDecimalPlaces() {
  try {
    const [[row]] = await pool.query(
      `SELECT setting_value FROM business_settings WHERE setting_key='quantity_decimal_places' LIMIT 1`
    );
    if (row) setQuantityDecimalPlaces(row.setting_value);
  } catch (e) {
    // keep whatever is already cached (default 2) if settings can't be loaded
  }
}

module.exports = { formatQty, getQuantityDecimalPlaces, setQuantityDecimalPlaces, refreshQuantityDecimalPlaces };
