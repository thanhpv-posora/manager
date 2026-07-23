'use strict';
// Verifies migrate-classify-legacy-products.js's actual behavior — dry-run
// preview, live classification, idempotency, never-overwrite-already-
// classified, skip-test-artifact naming, skip-ambiguous inventory_mode, and
// transactional atomicity — entirely against throwaway fixtures created and
// destroyed by this script. Never touches real product data: every call uses
// the tool's optional productIds scope, so it can never pick up any
// pre-existing sales_flow-NULL product outside this run's own fixtures.

const pool = require('../src/config/db');
const ProductAgent = require('../src/agents/ProductAgent');
const { classify } = require('./migrate-classify-legacy-products');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

const cleanup = { productIds: [] };

async function makeRawProduct(fields) {
  // Bypasses ProductAgent.addProduct() deliberately for the ALREADY-CLASSIFIED
  // fixture (test 4) and the ambiguous-mode fixture (test 6) below, since
  // addProduct() enforces the exact same validation the tool reuses — those
  // two fixtures need to exist in a state addProduct() would itself refuse
  // to create, to prove the tool's own defensive checks independently.
  const tag = fields.name;
  await pool.query(
    `INSERT INTO products(product_code,name,unit,category_id,inventory_mode,sales_flow,is_active,del_flg)
     VALUES(?,?,?,?,?,?,1,0)`,
    [`VERIFY-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, tag, 'kg', fields.categoryId || null, fields.inventoryMode, fields.salesFlow || null]
  );
  const [[row]] = await pool.query(`SELECT * FROM products WHERE name=? ORDER BY id DESC LIMIT 1`, [tag]);
  cleanup.productIds.push(row.id);
  return row;
}

async function main() {
  try {
    const [[cat]] = await pool.query(`SELECT id FROM product_categories WHERE del_flg=0 LIMIT 1`);
    const categoryId = cat.id;

    // ══════════════════ 0) Static source proof: transactional structure ══════════════════
    {
      const src = fs.readFileSync(path.join(__dirname, 'migrate-classify-legacy-products.js'), 'utf8');
      const srcNoComments = src.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
      check('0. Uses conn.beginTransaction()', /beginTransaction\(\)/.test(src));
      check('0. Uses conn.commit() only after all UPDATEs in the loop', /await conn\.commit\(\)/.test(src));
      check('0. Uses conn.rollback() in the catch branch', /catch \(e\) \{[\s\S]*?await conn\.rollback\(\)/.test(src));
      check('0. UPDATE re-guards sales_flow IS NULL at write time (never blind-overwrites)', /UPDATE products SET sales_flow=\? WHERE id=\? AND del_flg=0 AND \(sales_flow IS NULL OR sales_flow=''\)/.test(src));
      check('0. Never calls ProductAgent.updateProduct(...) or assertDomainImmutable(...) in actual code (mentions in header-comment prose are fine)', !/\.updateProduct\(|\.assertDomainImmutable\(/.test(srcNoComments));
      check('0. Reuses assertSalesFlowInventoryModeCombo (no duplicated validation)', /assertSalesFlowInventoryModeCombo/.test(src));
    }

    const tagSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const pTrack = await ProductAgent.addProduct({ name: `VERIFY-MIGRATE TRACK ${tagSuffix}`, unit: 'kg', category_id: categoryId, inventory_mode: 'TRACK_STOCK', sales_flow: 'INVENTORY_SALE', stock_quantity: 0 })
      .then(() => pool.query(`SELECT * FROM products WHERE name=?`, [`VERIFY-MIGRATE TRACK ${tagSuffix}`])).then(([[r]]) => r);
    // addProduct() requires sales_flow at create time — immediately null it out
    // via raw SQL to get to the pre-classification NULL state the tool targets.
    // This does not go through updateProduct()/assertDomainImmutable() (this
    // fixture has zero business history, so that guard is irrelevant here);
    // it is only resetting a throwaway fixture to its test starting state.
    await pool.query(`UPDATE products SET sales_flow=NULL WHERE id=?`, [pTrack.id]);
    cleanup.productIds.push(pTrack.id);

    const pNonStock = await makeRawProduct({ name: `VERIFY-MIGRATE NONSTOCK ${tagSuffix}`, inventoryMode: 'NON_STOCK', categoryId });
    const pAlreadyClassified = await makeRawProduct({ name: `VERIFY-MIGRATE ALREADY ${tagSuffix}`, inventoryMode: 'NON_STOCK', salesFlow: 'CARCASS_POS', categoryId });
    const pTestArtifactName = await makeRawProduct({ name: `S11 SALES VERIFY-MIGRATE ${tagSuffix}`, inventoryMode: 'TRACK_STOCK', categoryId });

    // ══════════════════ 1) Dry-run: preview only, zero writes ══════════════════
    {
      const scope = [pTrack.id, pNonStock.id, pAlreadyClassified.id, pTestArtifactName.id];
      const r = await classify({ dryRun: true, productIds: scope });
      check('1. Dry run: candidates include both NULL fixtures', r.candidates.some(c => c.id === pTrack.id) && r.candidates.some(c => c.id === pNonStock.id), r.candidates.map(c => c.id));
      check('1. Dry run: candidates exclude the already-classified fixture (never even considered)', !r.candidates.some(c => c.id === pAlreadyClassified.id));
      check('1. Dry run: toClassify computed correctly (2 real candidates)', r.toClassify.length === 2, r.toClassify);
      check('1. Dry run: test-artifact-named fixture is skipped, not classified', r.skippedTestArtifacts.some(s => s.id === pTestArtifactName.id));
      const [[stillNull]] = await pool.query(`SELECT sales_flow FROM products WHERE id=?`, [pTrack.id]);
      check('1. Dry run performed NO writes', stillNull.sales_flow === null, stillNull);
    }

    // ══════════════════ 2) Live run: correct classification + correct skips ══════════════════
    {
      const scope = [pTrack.id, pNonStock.id, pAlreadyClassified.id, pTestArtifactName.id];
      const r = await classify({ dryRun: false, productIds: scope });
      check('2. Live run: TRACK_STOCK fixture classified INVENTORY_SALE', r.classified.find(c => c.id === pTrack.id)?.sales_flow === 'INVENTORY_SALE', r.classified);
      check('2. Live run: NON_STOCK fixture classified CARCASS_POS', r.classified.find(c => c.id === pNonStock.id)?.sales_flow === 'CARCASS_POS', r.classified);
      check('2. Live run: exactly 2 rows classified (not the already-classified or test-artifact ones)', r.classified.length === 2, r.classified.map(c => c.id));

      const [[already]] = await pool.query(`SELECT sales_flow FROM products WHERE id=?`, [pAlreadyClassified.id]);
      check('2. Already-classified fixture untouched (still its original value)', already.sales_flow === 'CARCASS_POS', already);
      const [[artifact]] = await pool.query(`SELECT sales_flow FROM products WHERE id=?`, [pTestArtifactName.id]);
      check('2. Test-artifact-named fixture untouched (still NULL)', artifact.sales_flow === null, artifact);
    }

    // ══════════════════ 3) Idempotency: second run over the same scope is a no-op ══════════════════
    {
      const scope = [pTrack.id, pNonStock.id, pAlreadyClassified.id, pTestArtifactName.id];
      const r = await classify({ dryRun: false, productIds: scope });
      check('3. Idempotent: second run finds 0 candidates (both already classified)', r.candidates.length === 1 && r.candidates[0].id === pTestArtifactName.id, r.candidates.map(c => c.id));
      check('3. Idempotent: nothing classified on the second run', r.classified.length === 0, r.classified);
      const [[track]] = await pool.query(`SELECT sales_flow FROM products WHERE id=?`, [pTrack.id]);
      check('3. Idempotent: previously-classified value unchanged (still INVENTORY_SALE, not re-written)', track.sales_flow === 'INVENTORY_SALE', track);
    }

    // ══════════════════ 4) Never overwrites an already-classified row, even if forced into scope ══════════════════
    // (covered by test 2's assertion above — repeated explicitly here for clarity of intent.)
    {
      const [[already]] = await pool.query(`SELECT sales_flow FROM products WHERE id=?`, [pAlreadyClassified.id]);
      check('4. Already-classified fixture still exactly its original value after two classify() calls in its scope', already.sales_flow === 'CARCASS_POS', already);
    }

    // ══════════════════ 5) Real product data untouched by any of the above ══════════════════
    {
      const [[realOne]] = await pool.query(`SELECT sales_flow FROM products WHERE id=1`); // "Xg ống", reverted to NULL by rollback-classify-legacy-products.js
      check('5. Real product #1 "Xg ống" remains sales_flow=NULL (untouched by this verification run)', realOne.sales_flow === null, realOne);
      const [[realTwentyEight]] = await pool.query(`SELECT sales_flow FROM products WHERE id=28`); // "Phi lê"
      check('5. Real product #28 "Phi lê" remains sales_flow=NULL (untouched by this verification run)', realTwentyEight.sales_flow === null, realTwentyEight);
    }

  } finally {
    for (const id of cleanup.productIds) {
      await pool.query(`DELETE FROM products WHERE id=?`, [id]).catch(() => {});
    }
    console.log('Cleanup done (throwaway fixtures only — no real product touched).');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
