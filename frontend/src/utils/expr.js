export function calcExpression(input) {
  if (input === null || input === undefined) return 0;

  let raw = String(input)
    .replace(/，/g, '.')
    .replace(/,/g, '.')
    .replace(/kg|KG|Kg/g, '')
    .replace(/;/g, '\n')
    .trim();

  if (!raw) return 0;

  // Support supplier lot entry with many lines: 90.5 / 75.8 / 64.2 => 90.5+75.8+64.2
  // If the user already writes operators, keep them.
  let expr = raw
    .split(/\r?\n+/)
    .map(x => x.trim())
    .filter(Boolean)
    .map(x => x.replace(/[^0-9.+\-*/()\s]/g, '').trim())
    .filter(Boolean)
    .join('+')
    .replace(/\s+/g, '');

  if (!expr) return 0;
  if (!/^[0-9.+\-*/()]+$/.test(expr)) return 0;

  try {
    const v = Function(`"use strict"; return (${expr})`)();
    return Number.isFinite(Number(v)) ? Number(Number(v).toFixed(3)) : 0;
  } catch {
    const n = Number(expr);
    return Number.isFinite(n) ? Number(n.toFixed(3)) : 0;
  }
}
