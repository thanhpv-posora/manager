'use strict';
const { solarToLunar, parseLunarText } = require('./lunarDate');

// S1D Rule 3: customer.billing_calendar_type is authoritative for every write
// path that creates or confirms a bill (OrderAgent.create(), the AI confirm path
// in order.service.js) — re-read fresh from the DB inside the caller's
// transaction, never trusted from a request's calendar_type field. A LUNAR
// customer's bill is always resolved as LUNAR: when the caller's lunar_date_text
// is missing or unparseable, it is derived from order_date via solar->lunar
// conversion rather than silently falling through to SOLAR — which would never
// match a LUNAR price book and silently degrade to COMMON_PRICE (the exact
// Hồng Hiền production bug this closes). A SOLAR customer's bill is always
// resolved as SOLAR; any lunar_date_text sent is ignored. Normalizes rather than
// rejects, so no existing caller's request shape needs to change to keep working.
//
// Shared by every write path per S1D's "one shared backend resolver" rule — do
// not duplicate this logic locally in a caller.
async function resolveAuthoritativeCalendar(conn, customerId, data) {
  const [[customerRow]] = await conn.query(`SELECT billing_calendar_type FROM customers WHERE id=? LIMIT 1`, [customerId]);
  const calendarType = String(customerRow?.billing_calendar_type || 'SOLAR').toUpperCase() === 'LUNAR' ? 'LUNAR' : 'SOLAR';
  let lunarDateText = '';
  if (calendarType === 'LUNAR') {
    lunarDateText = parseLunarText(data.lunar_date_text) ? data.lunar_date_text : '';
    if (!lunarDateText) {
      const derived = solarToLunar(data.order_date || new Date().toISOString().slice(0, 10));
      lunarDateText = `${String(derived.day).padStart(2, '0')}/${String(derived.month).padStart(2, '0')}/${derived.year}`;
    }
  }
  return { calendarType, lunarDateText };
}

module.exports = { resolveAuthoritativeCalendar };
