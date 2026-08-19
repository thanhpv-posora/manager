// Price Matrix fast-entry — safe arithmetic evaluator for VND unit-price
// input ("2000000/12.5" -> 160000). Deliberately separate from
// utils/qtyExpression.js and utils/expr.js: those round to 3 decimal places
// (correct for kg quantities) and silently coerce a non-finite result (e.g.
// division by zero) to 0 — both wrong for a money field, where a silent 0
// would look like a real, saveable price. Same underlying safe-eval
// mechanism (character whitelist -> Function(), never eval()), money-specific
// rules layered on top.
//
// Returns { ok:true, value:<non-negative integer VND> } on success,
// { ok:false } on anything invalid — never guesses/falls back to 0.
export function evalMoneyExpression(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false };

  // Thousand-separator commas are the only "formatting" MoneyInput's own
  // display ever adds (see utils/money.js formatMoney) — strip them so
  // resuming an already-formatted value (e.g. "160,000" + "/2") still works.
  // Nothing else gets stripped: any other character fails the whitelist below.
  const cleaned = raw.replace(/,/g, '');

  if (!/^[0-9.+\-*/()\s]+$/.test(cleaned)) return { ok: false };
  if (!/[0-9]/.test(cleaned)) return { ok: false };
  // Reject "**" (JS exponentiation, not one of the supported + - * / operators),
  // "//", and any other doubled-up operator ("+-", "--", etc.) — the character
  // whitelist alone would let Function() interpret these in ways outside the
  // four supported operators.
  if (/[+\-*/]{2,}/.test(cleaned)) return { ok: false };

  let result;
  try {
    // eslint-disable-next-line no-new-func
    result = Function('"use strict"; return (' + cleaned + ')')();
  } catch {
    return { ok: false };
  }

  const n = Number(result);
  // Number.isFinite(n) is false for both NaN (malformed/0-0-like results)
  // and Infinity (division by zero) — one check covers both required
  // rejections generically, including indirect cases like "1/(2-2)", not
  // just a literal "/0" in the source text.
  if (!Number.isFinite(n)) return { ok: false };
  if (n < 0) return { ok: false };

  return { ok: true, value: Math.round(n) };
}
