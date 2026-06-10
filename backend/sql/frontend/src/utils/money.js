export function formatMoney(value) {
  const n = Number(value || 0);
  return n.toLocaleString('en-US');
}
export function formatVnd(value) { return formatMoney(value) + 'đ'; }
export function moneyVnd(value) { return formatVnd(value); }
export function money(value) { return formatVnd(value); }
export function parseMoney(value) {
  if (value === null || value === undefined) return 0;
  const s = String(value).replace(/[\sđ₫]/g, '').replace(/,/g, '').replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}
