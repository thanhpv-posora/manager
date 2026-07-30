export function calcQtyExpression(input) {
  if (input === null || input === undefined) return 0;

  let expr = String(input)
    .replace(/，/g, '.')
    .replace(/,/g, '.')
    .replace(/[＋]/g, '+')
    .replace(/[－]/g, '-')
    .replace(/[×xX]/g, '*')
    .replace(/[÷]/g, '/')
    .replace(/[^0-9.+\-*/()\s]/g, '')
    .trim();

  if (!expr) return 0;

  // If user is still typing an operator, calculate the stable part.
  expr = expr.replace(/[+\-*/.\s]+$/g, '');
  if (!expr) return 0;

  if (!/^[0-9.+\-*/()\s]+$/.test(expr)) return 0;

  try {
    const result = Function('"use strict"; return (' + expr + ')')();
    if (!Number.isFinite(Number(result))) return 0;
    return Number(Number(result).toFixed(3));
  } catch {
    const n = Number(expr);
    return Number.isFinite(n) ? Number(n.toFixed(3)) : 0;
  }
}

export function calcMeatQty(input) {
  return calcQtyExpression(input);
}

// Shared rounding helper for anywhere two already-evaluated quantities are
// summed outside calcQtyExpression (e.g. merging repeated Excel rows, or
// adding an imported quantity onto an existing cart row). calcQtyExpression
// already rounds its own result to 3dp, but plain JS addition of two such
// numbers can still reintroduce IEEE754 artifacts (e.g. 10.1+41.9 ->
// 51.99999999999999) — always pass sums through this before storing/
// displaying them, instead of scattering ad-hoc .toFixed(3) calls.
export function roundQty(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Number(n.toFixed(3)) : 0;
}
