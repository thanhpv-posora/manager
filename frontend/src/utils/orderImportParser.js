import { calcQtyExpression } from './qtyExpression';

function norm(s) {
  return String(s||'')
    .toLowerCase()
    .normalize('NFC')
    .replace(/[đ]/g,'d')
    .replace(/[^a-z0-9\s.]/g,' ')
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

function strictExcelProductMatch(name, products) {
  const key = strictKey(name);
  if (!key) return null;

  const candidates = [];
  for (const p of products || []) {
    const productNameKey = strictKey(p.product_name || p.name || '');
    const productCodeKey = strictKey(p.product_code || p.code || '');
    if (key === productNameKey || (productCodeKey && key === productCodeKey)) {
      candidates.push(p);
    }
  }

  // Production safety: nếu trùng nhiều mặt hàng cùng tên/code thì không tự chọn đại.
  if (candidates.length !== 1) return null;
  return candidates[0];
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

    const qty = calcQtyExpression(parsed.qtyExpr);
    const validation = validateImportedQty(parsed.clean, parsed.qtyExpr, qty, sourceType);

    if (parsed.name && qty > 0) {
      rows.push({
        name: parsed.name,
        qtyExpr: parsed.qtyExpr,
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
    const warnings = [...(r.warnings || [])];
    const errors = [...(r.errors || [])];

    // Excel import tuyệt đối KHÔNG dùng alias / fuzzy matching.
    // Tên trong Excel phải khớp đúng tên hàng hoặc mã hàng trong database.
    // Tránh rủi ro Nầm/Nạm/Lòng bị cộng nhầm số lượng sang mặt hàng khác.
    if (String(r.sourceType || '').toLowerCase() === 'excel') {
      best = strictExcelProductMatch(r.name, products);
      if (best) {
        bestScore = 100;
        bestReason = 'EXCEL_EXACT_DB_NAME_OR_CODE';
      } else {
        errors.push('Không mapping đúng tên hàng trong database');
      }
    } else {
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
    }

    const matchedOk = !!best && errors.length === 0 && (String(r.sourceType || '').toLowerCase() === 'excel' ? bestScore === 100 : bestScore >= 75);

    return {
      ...r,
      product: best,
      product_id: best?.product_id,
      product_name: best?.product_name,
      score: bestScore,
      match_reason: bestReason,
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
