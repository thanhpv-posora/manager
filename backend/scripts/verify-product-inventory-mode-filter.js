'use strict';
// Verifies the pre-commit cleanup patch to ProductAgent.products()/GET /products:
// the optional inventory_mode filter must be validated, never silently
// normalized. Covers: omitted param (unchanged/backward compatible), each of
// the 3 valid modes (exact match, no leakage), and an invalid value (rejected
// with a business error, not silently coerced to NON_STOCK).
//
// Self-cleaning: throwaway products, removed in `finally`.

const pool = require('../src/config/db');
const ProductAgent = require('../src/agents/ProductAgent');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}

async function makeProduct(mode) {
  await ProductAgent.addProduct({
    name: `S8.0 PIM FILTER ${mode} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    unit: 'kg', inventory_mode: mode, stock_quantity: 0,
  });
  const [[created]] = await pool.query(`SELECT * FROM products WHERE name LIKE 'S8.0 PIM FILTER ${mode} %' ORDER BY id DESC LIMIT 1`);
  return created;
}

async function main() {
  const productIds = [];

  try {
    const pTrack = await makeProduct('TRACK_STOCK');
    const pCarcass = await makeProduct('CARCASS_PART');
    const pNonStock = await makeProduct('NON_STOCK');
    productIds.push(pTrack.id, pCarcass.id, pNonStock.id);

    // ── omitted param: unchanged / backward compatible ──
    {
      const all = await ProductAgent.products('');
      check('omitted param: no last_count_at field leaks onto rows', !('last_count_at' in (all[0] || {})));
      const found = all.filter(p => productIds.includes(p.id));
      check('omitted param: sees all 3 test products regardless of mode', found.length === 3, found.length);
    }

    // ── each valid mode: exact match, no leakage ──
    for (const mode of ['TRACK_STOCK', 'CARCASS_PART', 'NON_STOCK']) {
      const rows = await ProductAgent.products('', mode);
      const modes = new Set(rows.map(r => r.inventory_mode));
      check(`valid mode ${mode}: every returned row has inventory_mode=${mode}`, modes.size <= 1 && (modes.size === 0 || modes.has(mode)), [...modes]);
      const ownRow = rows.find(r => productIds.includes(r.id));
      check(`valid mode ${mode}: the ${mode} test product is present`, !!ownRow, ownRow);
    }

    // ── case-insensitive convenience (still an exact real mode, just lowercase) ──
    {
      const rows = await ProductAgent.products('', 'track_stock');
      check('lowercase "track_stock" still resolves (case-folded, not a different value)', rows.some(r => r.id === pTrack.id));
    }

    // ── invalid mode: rejected, not silently coerced to NON_STOCK ──
    for (const bad of ['TYPO', 'STOCK', 'ALL', '']) {
      if (bad === '') continue; // empty string means "omitted" by design, not invalid — tested above
      let threw = null;
      try { await ProductAgent.products('', bad); } catch (e) { threw = e; }
      check(`invalid mode "${bad}": rejected with an error`, !!threw, threw && threw.message);
      check(`invalid mode "${bad}": error carries HTTP 400`, threw && (threw.status === 400 || threw.statusCode === 400), threw && (threw.status || threw.statusCode));
    }

    // Explicit proof of the exact bug this patch closes: a typo must NOT
    // silently come back as if it meant NON_STOCK.
    {
      let threw = null, result = null;
      try { result = await ProductAgent.products('', 'TYPO'); } catch (e) { threw = e; }
      check('TYPO never silently resolves to a NON_STOCK-filtered result set', !result && !!threw);
    }

  } finally {
    for (const id of productIds) {
      await pool.query(`DELETE FROM stock_transactions WHERE product_id=?`, [id]).catch(() => {});
      await pool.query(`DELETE FROM products WHERE id=?`, [id]).catch(() => {});
    }
    console.log('Cleanup done.');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
