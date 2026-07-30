import { calcQtyExpression, roundQty } from './qtyExpression.js';

// Business rule (CRITICAL fix — POS Excel import "Nầm"/"Nạm" mapping bug):
// product identity in Vietnamese depends on tone/vowel diacritics — "Nạm" and
// "Nầm" are different products and must never normalize to the same key.
// The previous implementation stripped every non a-z0-9 character (including
// all Vietnamese diacritics) here, which collapsed "Nạm" and "Nầm" to the
// identical token "n m" and let the fuzzy scorer below silently merge them.
// This now keeps any Unicode letter/number (so đ and every accented vowel
// survive) — only case, NFC form, and whitespace are normalized.
function norm(s) {
  return String(s||'')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s.]/gu,' ')
    .replace(/\s+/g,' ')
    .trim();
}

function compact(s) {
  return norm(s).replace(/\s/g,'');
}

function normalizeOcrLine(line) {
  return String(line||'')
    .replace(/[，]/g, '.')
    .replace(/(\d)\s*[.,]\s*(\d)/g, '$1.$2')
    .replace(/\s+/g, ' ')
    .trim();
}


function strictKey(s) {
  return String(s || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[，]/g, '.')
    .replace(/[\u00a0\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Exact match only — trims/collapses whitespace, normalizes NFC, ignores
// case, but NEVER strips accents (strictKey does not touch diacritics).
// Returns every candidate found so the caller can tell "zero matches" apart
// from "ambiguous — more than one matches" instead of collapsing both cases
// to the same null and risking a silent rows[0]-style pick.
function findExactProductCandidates(name, products) {
  const key = strictKey(name);
  if (!key) return [];

  const candidates = [];
  for (const p of products || []) {
    const productNameKey = strictKey(p.product_name || p.name || '');
    const productCodeKey = strictKey(p.product_code || p.code || '');
    if (key === productNameKey || (productCodeKey && key === productCodeKey)) {
      candidates.push(p);
    }
  }
  return candidates;
}

export function scoreProduct(name, product) {
  const a = norm(name);
  const b = norm(product.product_name || product.name || '');
  const c = norm(product.product_code || '');

  const ac = compact(name);
  const bc = compact(product.product_name || product.name || '');
  const cc = compact(product.product_code || '');

  if (!a) return { score:0, reason:'EMPTY' };
  if (ac === bc || ac === cc) return { score:100, reason:'EXACT' };

  const aTokens = a.split(' ').filter(Boolean);
  const bTokens = b.split(' ').filter(Boolean);

  // Product matching in OCR must be strict:
  // all spoken/imported tokens must appear in product name tokens.
  const allTokensHit = aTokens.every(t => bTokens.some(bt => bt === t || bt.includes(t) || t.includes(bt)));
  if (allTokensHit && aTokens.length >= 2) return { score:90, reason:'TOKEN_FULL' };

  // Compact exact-ish only if length is close; avoids "bosuon" matching "bopho".
  if ((bc.includes(ac) || ac.includes(bc)) && Math.abs(bc.length - ac.length) <= 2) {
    return { score:78, reason:'COMPACT_CLOSE' };
  }

  let hit = 0;
  for (const t of aTokens) {
    if (bTokens.some(bt => bt === t || bt.includes(t) || t.includes(bt))) hit++;
  }
  const ratio = hit / Math.max(aTokens.length, 1);

  // If only first token "bo" matches, score is intentionally low.
  if (ratio < 0.75) return { score:Math.round(ratio*45), reason:'LOW_TOKEN_MATCH' };

  return { score:Math.round(ratio*70), reason:'PARTIAL_TOKEN' };
}

function extractNameQty(line, sourceType='text') {
  const clean = normalizeOcrLine(line);
  const m = clean.match(/^(.+?)\s+([0-9]+(?:\.[0-9]+)?(?:\s*[+\-*/]\s*[0-9]+(?:\.[0-9]+)?)*)$/);
  if (!m) return null;

  const name = m[1].trim();
  const qtyExpr = m[2].replace(/\s+/g, '');

  return { name, qtyExpr, clean, sourceType };
}

export function validateImportedQty(rawLine, qtyExpr, qty, sourceType='text') {
  const warnings = [];
  const errors = [];
  const normalized = normalizeOcrLine(rawLine);

  if (qty <= 0) errors.push('Số lượng <= 0');

  const hasOperator = /[+\-*/]/.test(qtyExpr);
  const hasOperatorWithNoSpaces = /\d[+\-*/]\d/.test(qtyExpr);

  // Production rule:
  // OCR/image mode must never auto-calc ambiguous expression like 23+12.1.
  // It might be table/OCR column merge, not real math.
  if (sourceType === 'image' && hasOperator) {
    errors.push('OCR có phép tính nghi ngờ, cần sửa tay trước khi import');
  }

  // In text/excel mode, expression is allowed only if user intentionally typed it.
  // But still warn if operator is glued without spaces because OCR often creates this.
  if (sourceType !== 'manual' && hasOperatorWithNoSpaces) {
    warnings.push('Biểu thức không có khoảng trắng, cần kiểm tra');
  }

  const hasDecimalInRaw = /\d+\.\d+/.test(normalized);
  if (hasDecimalInRaw && !String(qtyExpr).includes('.') && Number(qty) >= 100) {
    errors.push('Có thể mất dấu chấm thập phân');
  }

  if (Number(qty) >= 100) {
    warnings.push('Số lượng lớn bất thường');
  }

  const dec = normalized.match(/(\d+\.\d+)/);
  if (dec && Math.abs(Number(dec[1]) - Number(qty)) > 0.001 && !hasOperator) {
    errors.push(`OCR có số thập phân ${dec[1]} nhưng parser ra ${qty}`);
  }

  return { warnings, errors };
}

export function parseOrderText(text, sourceType='text') {
  const lines = String(text||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  const rows = [];

  for (const line of lines) {
    const parsed = extractNameQty(line, sourceType);
    if (!parsed) continue;

    const qty = calcQtyExpression(parsed.qtyExpr); // already rounded to 3dp internally
    const validation = validateImportedQty(parsed.clean, parsed.qtyExpr, qty, sourceType);

    if (parsed.name && qty > 0) {
      rows.push({
        name: parsed.name,
        // qtyExpr is what the preview input displays/edits — always the
        // clean evaluated number ("22"), never the raw expression text or a
        // raw floating-point artifact. The original text (e.g. "10+12") is
        // preserved separately in rawQuantityText/raw for the note column —
        // it is never used for calculation.
        qtyExpr: String(qty),
        rawQuantityText: parsed.qtyExpr,
        qty,
        raw: parsed.clean,
        sourceType,
        warnings: validation.warnings,
        errors: validation.errors,
        selected: validation.errors.length === 0
      });
    }
  }
  return rows;
}

export function matchImportedRows(importRows, products) {
  return importRows.map(r => {
    let best = null, bestScore = 0, bestReason = '';
    let ambiguousCandidates = null;
    const warnings = [...(r.warnings || [])];
    const errors = [...(r.errors || [])];
    const sourceType = String(r.sourceType || '').toLowerCase();

    // Business rule: product code/name matching must resolve to exactly one
    // product, using an exact (accent-preserving, case-insensitive,
    // whitespace/NFC-normalized) match — never alias/fuzzy matching, and
    // never a silent "pick the first candidate" when several match. This is
    // tried FIRST for every source, including pasted "text/excel" content
    // and a manual edit of an already-imported row's quantity (the row's
    // name is unchanged in that case) — only "OCR ảnh" (photographed/
    // handwritten text) falls back to fuzzy scoring below, since that source
    // has genuine character-recognition noise an exact match can't tolerate.
    const exactCandidates = findExactProductCandidates(r.name, products);

    if (exactCandidates.length === 1) {
      best = exactCandidates[0];
      bestScore = 100;
      bestReason = 'EXACT_DB_NAME_OR_CODE';
    } else if (exactCandidates.length > 1) {
      // Ambiguous: never rows[0]/findOne/LIMIT 1 — reject and surface it.
      ambiguousCandidates = exactCandidates.map(p => ({
        id: p.product_id ?? p.id, code: p.product_code ?? p.code, name: p.product_name ?? p.name
      }));
      errors.push(`Không thể xác định mặt hàng "${r.name}": tìm thấy nhiều kết quả.`);
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[orderImportParser] ambiguous product match for import row', { name: r.name, candidates: ambiguousCandidates });
      }
    } else if (sourceType === 'image') {
      for (const p of products || []) {
        const result = scoreProduct(r.name, p);
        if (result.score > bestScore) {
          best = p;
          bestScore = result.score;
          bestReason = result.reason;
        }
      }

      // Strict threshold: avoid Bò sườn -> Bò phở.
      if (!best || bestScore < 75) {
        errors.push('Không khớp mặt hàng chắc chắn');
      } else if (bestScore < 90) {
        warnings.push('Tên khớp chưa chắc chắn');
      }
    } else {
      errors.push('Không mapping đúng tên hàng trong database');
    }

    const matchedOk = !!best && errors.length === 0 && (sourceType === 'image' ? bestScore >= 75 : bestScore === 100);

    return {
      ...r,
      product: best,
      product_id: best?.product_id,
      product_name: best?.product_name,
      score: bestScore,
      match_reason: bestReason,
      ambiguousCandidates,
      ok: matchedOk,
      canApply: matchedOk,
      warnings,
      errors,
      selected: matchedOk && r.selected !== false
    };
  });
}

export function rematchOne(row, products) {
  return matchImportedRows([row], products)[0];
}

// product_id is the only allowed cart-merge key (never name/normalized name/
// alias/display label/array position) — shared here so CreateOrder.jsx does
// not keep its own duplicate copy of this rule.
export function getProductKey(obj) {
  const id = obj?.product_id ?? obj?.id ?? obj?.productId;
  return id === undefined || id === null ? '' : String(id);
}

// Groups already-matched, selected import rows by resolved product_id before
// they are applied to the cart — so two Excel rows for the same product
// (e.g. two "Nầm" lines) accumulate into one cart row instead of overwriting
// or landing on separate lines. Quantities are summed via roundQty() (never
// raw JS addition) so the merged total never shows an IEEE754 artifact like
// 51.99999999999999. Also collects the original per-row qty expressions so
// the caller can preserve them as a "= 10+12" style note without treating
// that note as the current input value.
export function groupImportRowsByProduct(rowsToApply) {
  const grouped = new Map();
  for (const r of rowsToApply || []) {
    const product = r.product || {};
    const key = getProductKey(product) || String(r.product_id || '');
    if (!key) continue;
    const old = grouped.get(key) || { product, row: r, qty: 0, count: 0, names: [], qtyExprs: [] };
    old.qty = roundQty(Number(old.qty || 0) + Number(r.qty || 0));
    old.count += 1;
    old.names.push(r.name || r.raw || product.product_name || '');
    old.qtyExprs.push(String(r.qtyExpr || r.qty || ''));
    grouped.set(key, old);
  }
  return grouped;
}
