// Automated tests for the POS Excel-import product-resolution fix
// (CRITICAL bug: "Nầm" quantity silently merged into "Nạm").
//
// Run with: node --test src/utils/orderImportParser.test.js
// (frontend/package.json has "type":"module", so Node's built-in test
// runner can import these ES modules directly — no bundler/dep needed.)

import test from 'node:test';
import assert from 'node:assert/strict';
import { matchImportedRows, rematchOne, getProductKey, groupImportRowsByProduct, parseOrderText } from './orderImportParser.js';
import { calcQtyExpression, roundQty } from './qtyExpression.js';

function product(id, code, name) {
  return { product_id: id, product_code: code, product_name: name };
}

const NAM = product(101, 'B00003', 'Nạm');
const NAM2 = product(102, 'B00004', 'Nầm');

// Mirrors how CreateOrder.jsx's parseOrderText/extractNameQty build a row:
// qty is the EVALUATED expression (e.g. "10+12" -> 22), qtyExpr is the raw
// text preserved separately.
function excelRow(name, qtyExpr) {
  return { name, qtyExpr, qty: calcQtyExpression(qtyExpr), raw: `${name} ${qtyExpr}`, sourceType: 'excel', warnings: [], errors: [], selected: true };
}

test('2. Exact Excel mapping — Nạm and Nầm resolve to their own distinct product_id', () => {
  const products = [NAM, NAM2];
  const rows = [excelRow('Nạm', '82.8'), excelRow('Nầm', '10+12')];
  const matched = matchImportedRows(rows, products);

  const namRow = matched.find(r => r.name === 'Nạm');
  const nam2Row = matched.find(r => r.name === 'Nầm');

  assert.equal(namRow.product_id, 101);
  assert.equal(namRow.qty, 82.8);
  assert.equal(namRow.ok, true);

  assert.equal(nam2Row.product_id, 102);
  assert.equal(nam2Row.qty, 22);
  assert.equal(nam2Row.ok, true);

  // The historical bug: Nầm's quantity must never land on Nạm's product_id.
  assert.notEqual(namRow.product_id, nam2Row.product_id);
});

test('3. Repeated same product — two Excel rows for Nầm accumulate to one product_id with summed qty', () => {
  const products = [NAM, NAM2];
  const rows = [excelRow('Nầm', '10'), excelRow('Nầm', '12')];
  const matched = matchImportedRows(rows, products);
  assert.equal(matched[0].product_id, 102);
  assert.equal(matched[1].product_id, 102);

  const grouped = groupImportRowsByProduct(matched);
  assert.equal(grouped.size, 1);
  const g = [...grouped.values()][0];
  assert.equal(g.qty, 22);
  assert.equal(g.qtyExprs.join(' + '), '10 + 12');
});

test('4. Distinct accent products remain separate for every required pair', () => {
  const pairs = [
    ['Nạm', 'Nầm'],
    ['Bú', 'Bù'],
    ['Bắp', 'Bập'],
    ['Nạc', 'Nấc'],
    ['Lòng', 'Lông'],
    ['Gân', 'Gần'],
  ];
  for (const [a, b] of pairs) {
    const pa = product(1, 'A', a);
    const pb = product(2, 'B', b);
    const products = [pa, pb];
    const matched = matchImportedRows([excelRow(a, '5'), excelRow(b, '7')], products);
    assert.equal(matched[0].product_id, 1, `${a} should resolve to product 1, not ${b}'s product`);
    assert.equal(matched[1].product_id, 2, `${b} should resolve to product 2, not ${a}'s product`);
    assert.notEqual(matched[0].product_id, matched[1].product_id, `${a} and ${b} must never share a product_id`);
  }
});

test('5. Case-insensitive resolution when only one such product exists', () => {
  const products = [NAM2]; // only "Nầm" exists
  for (const variant of ['Nầm', 'nầm', 'NẦM']) {
    const matched = matchImportedRows([excelRow(variant, '3')], products);
    assert.equal(matched[0].product_id, 102, `variant "${variant}" should resolve`);
    assert.equal(matched[0].ok, true);
  }
});

test('6. Spacing and Unicode NFC/NFD normalize, but accents remain distinct', () => {
  const products = [NAM, NAM2];

  const spaced = matchImportedRows([excelRow('  Nầm  ', '4'), excelRow('Nầm   với   nhiều   khoảng   trắng'.replace('với nhiều khoảng trắng', ''), '4')], products);
  assert.equal(spaced[0].product_id, 102);

  // NFD (decomposed) input for "Nầm" must resolve to the SAME product as the
  // NFC (composed) DB value — this is a Unicode-form difference, not a
  // different word, and matchImportedRows must not depend on the caller
  // normalizing the form first.
  const nfd = 'Nầm'.normalize('NFD');
  assert.notEqual(nfd, 'Nầm'); // sanity: confirm the test actually exercises NFD, not an identical string
  const nfdMatched = matchImportedRows([excelRow(nfd, '6')], products);
  assert.equal(nfdMatched[0].product_id, 102);

  // But NFD "Nạm" must still resolve to Nạm, not Nầm — proves the fix isn't
  // accidentally accent-insensitive under NFD input either.
  const nfdNam = 'Nạm'.normalize('NFD');
  const nfdNamMatched = matchImportedRows([excelRow(nfdNam, '6')], products);
  assert.equal(nfdNamMatched[0].product_id, 101);
});

test('7. Ambiguous result — multiple products with the same exact name are rejected, never auto-picked', () => {
  const dup1 = product(201, 'X001', 'Ba chỉ');
  const dup2 = product(202, 'X002', 'Ba chỉ');
  const products = [dup1, dup2];
  const matched = matchImportedRows([excelRow('Ba chỉ', '5')], products);

  assert.equal(matched[0].product, null);
  assert.equal(matched[0].product_id, undefined);
  assert.equal(matched[0].ok, false);
  assert.equal(matched[0].canApply, false);
  assert.equal(matched[0].selected, false);
  assert.ok(matched[0].errors.some(e => e.includes('nhiều kết quả')));
  assert.ok(Array.isArray(matched[0].ambiguousCandidates));
  assert.equal(matched[0].ambiguousCandidates.length, 2);
  assert.deepEqual(matched[0].ambiguousCandidates.map(c => c.id).sort(), [201, 202]);
});

test('Zero matches are marked "Không mapping", not silently dropped or guessed', () => {
  const products = [NAM, NAM2];
  const matched = matchImportedRows([excelRow('Mặt hàng không tồn tại', '5')], products);
  assert.equal(matched[0].product, null);
  assert.equal(matched[0].ok, false);
  assert.ok(matched[0].errors.some(e => e.includes('Không mapping')));
});

test('Product code exact match also resolves one product', () => {
  const products = [NAM, NAM2];
  const matched = matchImportedRows([excelRow('B00004', '9')], products);
  assert.equal(matched[0].product_id, 102);
});

test('getProductKey uses only product_id, never name/label/position', () => {
  assert.equal(getProductKey({ product_id: 102, product_name: 'Nầm' }), '102');
  assert.equal(getProductKey({ product_id: 101, product_name: 'Nầm' }), '101'); // same name, different id -> different key
  assert.equal(getProductKey({}), '');
});

test('rematchOne (manual re-edit path) still uses exact matching, not accent-stripped fuzzy scoring', () => {
  const products = [NAM, NAM2];
  const row = { name: 'Nầm', qtyExpr: '22', qty: 22, sourceType: 'manual', warnings: [], errors: [] };
  const rematched = rematchOne(row, products);
  assert.equal(rematched.product_id, 102);
});

test('Regression: OCR image source still falls back to fuzzy token matching for non-accent noise (partial/incomplete text)', () => {
  const products = [product(301, 'C001', 'Bò sườn non')];
  // OCR dropped the trailing "non" but kept the accents intact — fuzzy
  // token matching (unrelated to the accent fix) still resolves this.
  const row = { name: 'bò sườn', qtyExpr: '2', qty: 2, sourceType: 'image', warnings: [], errors: [] };
  const matched = matchImportedRows([row], products);
  assert.equal(matched[0].product_id, 301);
});

test('Intentional behavior change: OCR fuzzy matching no longer bridges accent loss (business rule applies to every source, not just Excel)', () => {
  // If OCR text itself drops all diacritics ("bo suon" for "Bò sườn non"),
  // the fix's accent-preserving norm() means this can no longer silently
  // resolve on compact-string equality alone — consistent with "Nạm and
  // Nầm are different products" being an unconditional business rule, not
  // an Excel-only one. This is a deliberate, documented change (see the
  // Feature Preservation Matrix), not an accidental regression.
  const products = [product(301, 'C001', 'Bò sườn non')];
  const row = { name: 'bo suon non', qtyExpr: '2', qty: 2, sourceType: 'image', warnings: [], errors: [] };
  const matched = matchImportedRows([row], products);
  // A low-confidence candidate may still be attached for diagnostics, but it
  // must never be treated as applicable — accent loss alone (all diacritics
  // dropped) must not clear the fuzzy-match confidence threshold.
  assert.equal(matched[0].ok, false);
  assert.equal(matched[0].canApply, false);
  assert.equal(matched[0].selected, false);
  assert.ok(matched[0].score < 75, `score should be well below the apply threshold, got ${matched[0].score}`);
});

// ---------------------------------------------------------------------------
// POS Excel import PREVIEW precision + row-model separation
// (rawQuantityText / qty / qtyExpr) — the preview dialog's own display bug,
// independent of the earlier product-mapping fix.
// ---------------------------------------------------------------------------

test('parseOrderText: preview row model separates raw expression text from the clean displayed/calculated quantity', () => {
  const rows = parseOrderText('Nầm 10+12', 'text');
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.qty, 22); // numeric, used for calculation
  assert.equal(typeof r.qty, 'number');
  assert.equal(r.qtyExpr, '22'); // what the preview input displays/edits — clean, not "10+12"
  assert.equal(r.rawQuantityText, '10+12'); // original expression preserved separately, for the note/"Raw" column only
});

test('parseOrderText: a raw floating-point-imprecise quantity in the source text is normalized before it ever reaches the row model', () => {
  // calcQtyExpression already rounds internally, so even if a line contains
  // the raw artifact verbatim, the row's qty/qtyExpr must be clean.
  const rows = parseOrderText('Ba chỉ 51.99999999999999', 'text');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].qty, 52);
  assert.equal(rows[0].qtyExpr, '52');
});

test('groupImportRowsByProduct never lets the calculated quantity drift into a formatted string mid-pipeline', () => {
  const p = { product_id: 9, product_code: 'X', product_name: 'Test' };
  const rows = [
    { product: p, product_id: 9, name: 'Test', qty: 51.99999999999999, qtyExpr: '52' },
  ];
  const grouped = groupImportRowsByProduct(rows);
  const g = [...grouped.values()][0];
  assert.equal(typeof g.qty, 'number');
  assert.equal(g.qty, 52); // roundQty applied inside the grouping step itself
});
