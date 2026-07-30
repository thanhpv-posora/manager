import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePriceBookQty, validatePriceBookRows, buildPriceBookApplyRows, mergePriceBookRowsIntoPoRows } from './supplierPriceBookBulkEntry.js';

function row(product_id, overrides = {}) {
  return {
    product_id, product_name: `P${product_id}`, product_code: `C${product_id}`,
    unit_name: 'kg', conversion_qty: 1, supplier_purchase_option_id: 500 + product_id,
    price_book_id: 1, price_book_item_id: 900 + product_id,
    purchase_price: '10000', quantity: '', note: '', available: true, unavailable_reason: '', error: '',
    ...overrides,
  };
}

test('Quantity rule: blank -> skip (not an error)', () => {
  assert.deepEqual(parsePriceBookQty(''), { blank: true });
  assert.deepEqual(parsePriceBookQty('   '), { blank: true });
});

test('Quantity rule: zero -> valid parse (skip decision happens in buildPriceBookApplyRows, not here)', () => {
  assert.deepEqual(parsePriceBookQty('0'), { value: 0 });
});

test('Quantity rule: negative -> validation error', () => {
  const r = parsePriceBookQty('-5');
  assert.ok(r.error);
});

test('Quantity rule: invalid text -> validation error', () => {
  const r = parsePriceBookQty('abc');
  assert.ok(r.error);
});

test('Quantity rule: positive number (comma or dot decimal) -> valid', () => {
  assert.deepEqual(parsePriceBookQty('20'), { value: 20 });
  assert.deepEqual(parsePriceBookQty('12.5'), { value: 12.5 });
  assert.deepEqual(parsePriceBookQty('12,5'), { value: 12.5 });
});

test('Mandatory test: Product A=20 add, Product B=blank skip, Product C=12.5 add, Product D=0 skip', () => {
  const rows = [
    row(1, { quantity: '20' }),
    row(2, { quantity: '' }),
    row(3, { quantity: '12.5' }),
    row(4, { quantity: '0' }),
  ];
  const { hasError } = validatePriceBookRows(rows);
  assert.equal(hasError, false);
  const { toAdd, skipped } = buildPriceBookApplyRows(rows);
  assert.deepEqual(toAdd.map(r => r.product_id), [1, 3]);
  assert.equal(toAdd.find(r => r.product_id === 1).quantity, 20);
  assert.equal(toAdd.find(r => r.product_id === 3).quantity, 12.5);
  assert.equal(skipped, 2);
});

test('Negative or invalid quantity blocks validation (dialog must stay open) — mixed with valid rows', () => {
  const rows = [row(1, { quantity: '20' }), row(2, { quantity: '-3' })];
  const { hasError, rows: validated } = validatePriceBookRows(rows);
  assert.equal(hasError, true);
  assert.equal(validated.find(r => r.product_id === 2).error, 'Số lượng không được âm');
});

test('Unavailable rows are never added and never block validation, even with garbage in quantity', () => {
  const rows = [row(1, { quantity: '20' }), row(2, { available: false, unavailable_reason: 'Sản phẩm không còn hoạt động', quantity: 'not-a-number' })];
  const { hasError } = validatePriceBookRows(rows);
  assert.equal(hasError, false, 'an unavailable row must never block the whole apply');
  const { toAdd } = buildPriceBookApplyRows(rows);
  assert.deepEqual(toAdd.map(r => r.product_id), [1]);
});

test('Duplicate-row behavior: same product_id already in poRows is replaced (existing saveAddDlg rule), never merged by name', () => {
  const poRows = [
    { product_id: 1, product_name: 'Nạm', quantity: '5', purchase_price: '90000', item_id: 55, spo_id: null, spos: [] },
    { product_id: 2, product_name: 'Nạm (kho khác)', quantity: '', purchase_price: '', item_id: null, spo_id: null, spos: [] },
  ];
  const toAdd = [row(1, { quantity: 20, purchase_price: '100000' }), row(3, { quantity: 8 })];
  const merged = mergePriceBookRowsIntoPoRows(poRows, toAdd);

  assert.equal(merged.length, 3, 'product 2 untouched, product 1 replaced in place, product 3 appended');
  const p1 = merged.find(r => r.product_id === 1);
  assert.equal(p1.quantity, '20', 'replaced, not summed with the prior 5');
  assert.equal(p1.item_id, 55, 'existing item_id preserved so the sync endpoint updates the same row instead of inserting a duplicate');
  const p2 = merged.find(r => r.product_id === 2);
  assert.equal(p2.quantity, '', 'a same-name-but-different-id product is never touched (identity is product_id only)');
  const p3 = merged.find(r => r.product_id === 3);
  assert.equal(p3.item_id, null, 'new product appended as a new row');
});

test('100-item price book: validate + build + merge completes near-instantly (no per-row API call, pure in-memory)', () => {
  const rows = Array.from({ length: 100 }, (_, i) => row(i + 1, { quantity: i % 4 === 0 ? '' : i % 4 === 1 ? '0' : String(i) }));
  const start = Date.now();
  const { hasError, rows: validated } = validatePriceBookRows(rows);
  const { toAdd, skipped } = buildPriceBookApplyRows(validated);
  const merged = mergePriceBookRowsIntoPoRows([], toAdd);
  const ms = Date.now() - start;
  assert.equal(hasError, false);
  assert.equal(merged.length, toAdd.length);
  assert.ok(toAdd.length + skipped <= 100);
  assert.ok(ms < 100, `expected well under 100ms for 100 items, got ${ms}ms`);
});

test('Different purchase option/unit for the same product_id is not a scenario this merge function receives duplicates for — identity is always product_id alone', () => {
  // The price-book resolver returns at most one row per product_id (see
  // backend verify-supplier-price-book-bulk-entry.js), so this merge
  // function only ever needs to key on product_id — confirms it does so
  // consistently even when supplier_purchase_option_id differs from what's
  // already in poRows (replace still applies, per the audited existing rule).
  const poRows = [{ product_id: 1, product_name: 'X', quantity: '5', spo_id: 500, spos: [{ id: 500, label: 'Thùng', unit_name: 'Thùng', conversion_qty: 10 }], item_id: 9 }];
  const toAdd = [row(1, { quantity: 3, supplier_purchase_option_id: 999, unit_name: 'Kg', conversion_qty: 1 })];
  const merged = mergePriceBookRowsIntoPoRows(poRows, toAdd);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].spo_id, 999, 'row replaced wholesale, including its purchase option — matches the audited existing saveAddDlg rule');
});
