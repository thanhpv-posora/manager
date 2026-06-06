export function calcExpression(input) {
  if (input === null || input === undefined) return 0;

  let expr = String(input)
    .replace(/，/g, '.')
    .replace(/,/g, '.')
    .replace(/[^0-9.+\-*/()\s]/g, '')
    .trim();

  if (!expr) return 0;
  if (!/^[0-9.+\-*/()\s]+$/.test(expr)) return 0;

  try {
    const v = Function(`"use strict"; return (${expr})`)();
    return Number.isFinite(Number(v)) ? Number(Number(v).toFixed(3)) : 0;
  } catch {
    const n = Number(expr);
    return Number.isFinite(n) ? Number(n.toFixed(3)) : 0;
  }
}
