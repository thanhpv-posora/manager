// Pure helpers for "Nạp bảng giá NCC" (load supplier purchase price book
// into a Purchase Order). Kept dependency-free and outside the .jsx component
// so the quantity-rule and duplicate-row logic can be unit tested directly.

// Quantity rule: blank -> skip (not an error), "0" -> skip (not an error),
// negative -> error, non-numeric text -> error, positive -> valid.
// Plain numeric only (no "10+12" expressions) — matches the existing PO
// grid's own quantity input convention (comma-decimal, not expression-based).
export function parsePriceBookQty(text) {
  const t = String(text || '').trim();
  if (!t) return { blank: true };
  const norm = t.replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(norm)) return { error: 'Số lượng không hợp lệ' };
  const n = Number(norm);
  if (n < 0) return { error: 'Số lượng không được âm' };
  return { value: n };
}

// Validates every row up front (step 4 of the apply lifecycle) — a single
// invalid (negative/non-numeric) row blocks the whole apply. Blank/zero rows
// are never errors, only skipped. Only rows the caller marked `available`
// are considered; unavailable rows are always ignored (never added, never
// block the apply even if they happen to carry stale text in `quantity`).
export function validatePriceBookRows(rows) {
  let hasError = false;
  const validated = rows.map(r => {
    if (!r.available) return { ...r, error: '' };
    const parsed = parsePriceBookQty(r.quantity);
    if (parsed.error) { hasError = true; return { ...r, error: parsed.error }; }
    return { ...r, error: '' };
  });
  return { hasError, rows: validated };
}

// Step 5 of the apply lifecycle: build the rows where quantity > 0, and
// count how many were skipped (blank/zero) — used for the mandatory
// "Đã thêm N mặt hàng vào phiếu. Bỏ qua M mặt hàng chưa nhập số lượng."
// message. Assumes validatePriceBookRows() already confirmed no errors.
export function buildPriceBookApplyRows(rows) {
  const toAdd = [];
  let skipped = 0;
  for (const r of rows) {
    if (!r.available) continue;
    const parsed = parsePriceBookQty(r.quantity);
    if (parsed.blank || parsed.value === 0) { skipped++; continue; }
    toAdd.push({ ...r, quantity: parsed.value });
  }
  return { toAdd, skipped };
}

// Duplicate-row behavior — audited from the existing, already-shipped
// saveAddDlg() handler (Products.jsx-adjacent "+ Thêm sản phẩm" flow): the
// ONLY verified existing rule is "match by product_id, replace the row" —
// it does not distinguish purchase unit/option, and never merges/sums
// quantities. This reuses that exact rule for consistency rather than
// inventing a new (SPO-aware, quantity-summing) one — see report
// §"Duplicate-row behavior" for the full audit trail and the follow-up
// REQUIRES_CTO_DECISION on whether the stricter behavior should replace it.
// Never merges/matches by product name — product_id only.
export function mergePriceBookRowsIntoPoRows(poRows, rowsToAdd) {
  let arr = [...poRows];
  for (const row of rowsToAdd) {
    const idx = arr.findIndex(x => String(x.product_id) === String(row.product_id));
    const newRow = {
      product_id: row.product_id,
      product_name: row.product_name,
      product_code: row.product_code,
      category_name: null,
      spo_id: row.supplier_purchase_option_id,
      purchase_price: String(row.purchase_price || ''),
      quantity: String(row.quantity),
      note: row.note || '',
      unit_label: row.unit_name,
      spos: row.supplier_purchase_option_id
        ? [{ id: row.supplier_purchase_option_id, label: `${row.unit_name} (${row.conversion_qty}kg)`, unit_name: row.unit_name, conversion_qty: row.conversion_qty }]
        : [],
      item_id: idx >= 0 ? arr[idx].item_id : null,
      price_book_id: row.price_book_id,
      price_book_item_id: row.price_book_item_id,
    };
    if (idx >= 0) arr[idx] = { ...arr[idx], ...newRow, item_id: arr[idx].item_id };
    else arr.push(newRow);
  }
  return arr;
}
