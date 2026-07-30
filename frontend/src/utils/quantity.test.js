// Automated tests for the floating-point display fix (51.99999999999999 -> 52).
// Run with: node --test src/utils/quantity.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatQtyTrim } from './quantity.js';
import { roundQty, calcQtyExpression } from './qtyExpression.js';

test('8. formatQtyTrim collapses IEEE754 artifacts and trims trailing zeros', () => {
  assert.equal(formatQtyTrim(51.99999999999999), '52');
  assert.equal(formatQtyTrim(52), '52');
  assert.equal(formatQtyTrim(52.5), '52.5');
  assert.equal(formatQtyTrim(52.125), '52.125');
  assert.equal(formatQtyTrim(52.5), '52.5'); // "52.500" style trailing zeros must not appear
});

test('Excel-preview-dialog acceptance scenarios (POS Excel import preview precision story)', () => {
  // Exact mandatory-test values from the preview-precision story.
  assert.equal(roundQty(51.99999999999999), 52);
  assert.equal(roundQty(52.00000000000001), 52);
  assert.equal(roundQty(52.50000000000001), 52.5);
  assert.equal(roundQty(52.125), 52.125);
  assert.equal(roundQty(0.30000000000000004), 0.3);

  assert.equal(formatQtyTrim(51.99999999999999), '52');
  assert.equal(formatQtyTrim(52.00000000000001), '52');
  assert.equal(formatQtyTrim(52.50000000000001), '52.5');
  assert.equal(formatQtyTrim(52.125), '52.125');
  assert.equal(formatQtyTrim(0.30000000000000004), '0.3');
});

test('roundQty output stays a number, never a formatted string (calculation-safe)', () => {
  const q = roundQty(51.99999999999999);
  assert.equal(typeof q, 'number');
  assert.equal(q + 1, 53); // arithmetic must still work directly on it
});

test('roundQty removes the artifact that raw JS addition can introduce', () => {
  // 51.99999999999999 is the exact symptom reported by the CTO — whatever
  // upstream arithmetic produces it (e.g. summing two already-rounded
  // quantities), roundQty must normalize it back to a clean 52.
  const artifact = 51.99999999999999;
  assert.notEqual(String(artifact), '52'); // sanity: confirm this literal really is imprecise in this JS engine
  assert.equal(roundQty(artifact), 52);
  assert.equal(String(roundQty(artifact)), '52');

  // Also verify a real addition of two already-rounded quantities can
  // reproduce the same class of artifact, and that roundQty fixes it too.
  const a = 0.1, b = 0.2;
  assert.notEqual(a + b, 0.3); // classic IEEE754 case, sanity-checked
  assert.equal(roundQty(a + b), 0.3);
});

test('roundQty is idempotent and money amounts are never touched by it (documentation test)', () => {
  assert.equal(roundQty(roundQty(52.1255)), roundQty(52.1255));
  // roundQty only ever operates on values the caller explicitly passes as
  // quantities — it must never be applied to sale_price/money fields
  // (enforced by code review / call-site discipline, not by this function).
});

test('calcQtyExpression already rounds its own result — unaffected by this fix', () => {
  assert.equal(calcQtyExpression('10+12'), 22);
  assert.equal(calcQtyExpression('0.1+0.2'), 0.3);
});
