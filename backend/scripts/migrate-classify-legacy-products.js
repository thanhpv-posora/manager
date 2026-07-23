'use strict';
// Legacy Product Classification Tool — ONE-TIME migration script, NOT a
// runtime feature. Never imported by any route/agent/service. Run manually:
//
//   node scripts/migrate-classify-legacy-products.js --dry-run   (preview only)
//   node scripts/migrate-classify-legacy-products.js             (live run)
//
// See backend/scripts/MIGRATE-CLASSIFY-LEGACY-PRODUCTS.md for the full
// release guide (purpose, execution steps, expected report, rollback).
//
// Background: ProductAgent.assertDomainImmutable() (unchanged by this script)
// blocks ProductAgent.updateProduct() from setting sales_flow on any product
// that already has business history (order_items/purchase_order_items/
// inventory_receive_items/stock_transactions). That correctly protects against
// RE-classifying an already-classified product after the fact. It also happens
// to catch products that predate the classification system entirely and have
// never been classified at all — a different situation the rule was never
// actually designed to address. This script is the narrowly-scoped, one-time
// exception for exactly that gap, approved as "Option B" (see architecture
// decision, CTO-approved). It does NOT call and does NOT modify
// assertDomainImmutable() or updateProduct() — it writes directly through a
// query scoped so tightly it cannot touch an already-classified row.
//
// Guarantees:
//   - Only ever touches products.sales_flow, and only where it is currently
//     NULL/'' — enforced both in the SELECT and again in the UPDATE's WHERE
//     clause, so it can never overwrite an existing classification even under
//     a concurrent write.
//   - Target sales_flow is never inferred loosely: it comes from the exact
//     same SALES_FLOW_INVENTORY_MODE_COMPAT bijection (NON_STOCK<->CARCASS_POS,
//     TRACK_STOCK<->INVENTORY_SALE) and assertSalesFlowInventoryModeCombo()
//     validator that ProductAgent/OrderAgent/PriceMatrixAgent already use —
//     no duplicated or looser validation logic.
//   - Products whose name matches this codebase's own throwaway verify-script
//     naming patterns (never real business products) are reported but SKIPPED,
//     never silently classified.
//   - Idempotent: a second run finds nothing left to do, since every candidate
//     it touches no longer matches "sales_flow IS NULL" afterward.
//   - Transactional: all writes commit together or none do.
//
// classify() is exported so verify-migrate-classify-legacy-products.js can
// exercise the real write/rollback/idempotency path against isolated
// throwaway fixtures (via the optional productIds scope below) without ever
// touching real product data — this file's own CLI entrypoint never passes
// productIds, so `node migrate-classify-legacy-products.js` always scans
// every sales_flow-NULL product exactly as before; the scoping option only
// exists for that isolated test harness.

const pool = require('../src/config/db');
const { assertSalesFlowInventoryModeCombo, SALES_FLOW_INVENTORY_MODE_COMPAT } = require('../src/utils/productSalesFlow');
const { normalizeInventoryMode } = require('../src/utils/inventoryMode');

// Names produced by this codebase's own throwaway verify-*/audit-*/debug
// scripts (all self-cleaning in their own `finally` blocks, but a handful
// survived past crashes). Never real business products; never classified here.
const TEST_ARTIFACT_NAME_PATTERN = /^(Recon Test|S11 SALES|S1D|S1DFIX|S1F|S1J-|DEBUG\b)/i;

// Deterministic, never inferred: SALES_FLOW_INVENTORY_MODE_COMPAT is a strict
// bijection (each sales_flow maps to exactly one inventory_mode and vice
// versa), so every candidate's target is already fully determined by its
// current inventory_mode. No "closest match" guessing.
function targetSalesFlowFor(inventoryMode) {
  const mode = normalizeInventoryMode(inventoryMode);
  const entry = Object.entries(SALES_FLOW_INVENTORY_MODE_COMPAT).find(([, modes]) => modes.includes(mode));
  return entry ? entry[0] : null;
}

async function printAggregateCounts(label) {
  const [rows] = await pool.query(
    `SELECT inventory_mode, COALESCE(sales_flow,'(NULL)') sales_flow, COUNT(*) c
     FROM products WHERE del_flg=0 AND is_active=1
     GROUP BY inventory_mode, sales_flow ORDER BY inventory_mode, sales_flow`
  );
  console.log(`${label}:`);
  rows.forEach(r => console.log(`  ${r.inventory_mode} / ${r.sales_flow}: ${r.c}`));
  console.log('');
}

// productIds: optional array — when provided, scopes the candidate SELECT to
// exactly those IDs (in addition to the existing sales_flow IS NULL filter).
// Omitted (the CLI's own usage): scans every sales_flow-NULL active product,
// unchanged from the original one-time-migration behavior.
async function classify({ dryRun = false, productIds = null } = {}) {
  console.log(`=== Legacy Product Classification Tool ${dryRun ? '(DRY RUN — no writes)' : '(LIVE)'} ===\n`);

  await printAggregateCounts('BEFORE (aggregate counts)');

  const scopeSql = productIds ? ' AND id IN (?)' : '';
  const scopeParams = productIds ? [productIds] : [];
  const [candidates] = await pool.query(
    `SELECT id, name, inventory_mode, sales_flow FROM products
     WHERE del_flg=0 AND is_active=1 AND (sales_flow IS NULL OR sales_flow='')${scopeSql}
     ORDER BY id`,
    scopeParams
  );

  console.log(`BEFORE REPORT — ${candidates.length} candidate(s) with sales_flow IS NULL:\n`);

  const toClassify = [];
  const skippedTestArtifacts = [];
  const skippedAmbiguous = [];

  for (const p of candidates) {
    if (TEST_ARTIFACT_NAME_PATTERN.test(p.name)) {
      skippedTestArtifacts.push(p);
      console.log(`  [SKIP-TEST-ARTIFACT] #${p.id} "${p.name}" (inventory_mode=${p.inventory_mode}) — matches throwaway verify-script naming, not a real product. Not classified; review for separate manual cleanup.`);
      continue;
    }

    const targetFlow = targetSalesFlowFor(p.inventory_mode);
    if (!targetFlow) {
      skippedAmbiguous.push(p);
      console.log(`  [SKIP-AMBIGUOUS] #${p.id} "${p.name}" — inventory_mode="${p.inventory_mode}" has no unambiguous sales_flow mapping. Reported, not classified.`);
      continue;
    }

    try {
      assertSalesFlowInventoryModeCombo(targetFlow, normalizeInventoryMode(p.inventory_mode));
    } catch (e) {
      skippedAmbiguous.push(p);
      console.log(`  [SKIP-INVALID-COMBO] #${p.id} "${p.name}" — ${e.message}`);
      continue;
    }

    toClassify.push({ ...p, targetFlow });
    console.log(`  [CLASSIFY] #${p.id} "${p.name}" (inventory_mode=${p.inventory_mode}) -> sales_flow=${targetFlow}`);
  }

  console.log(`\nSummary: ${toClassify.length} to classify, ${skippedTestArtifacts.length} test-artifact(s) skipped, ${skippedAmbiguous.length} ambiguous skipped.\n`);

  const result = { candidates, toClassify, skippedTestArtifacts, skippedAmbiguous, classified: [] };

  if (dryRun) {
    console.log('Dry run complete — no changes written.');
    return result;
  }

  if (!toClassify.length) {
    console.log('Nothing to classify. Exiting (idempotent no-op).');
    return result;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const p of toClassify) {
      // Re-guards sales_flow IS NULL at write time, inside the transaction —
      // this is what makes the tool unable to ever overwrite an existing
      // classification, and what makes a second run a safe no-op.
      const [updateResult] = await conn.query(
        `UPDATE products SET sales_flow=? WHERE id=? AND del_flg=0 AND (sales_flow IS NULL OR sales_flow='')`,
        [p.targetFlow, p.id]
      );
      if (updateResult.affectedRows !== 1) {
        throw new Error(`Product #${p.id} "${p.name}" was not classified as expected (already classified by a concurrent process?) — aborting, rolling back everything.`);
      }
    }
    await conn.commit();
    console.log('Transaction committed.\n');
  } catch (e) {
    await conn.rollback();
    console.error('ERROR — transaction rolled back, no changes were made:', e.message);
    throw e;
  } finally {
    conn.release();
  }

  const [after] = await pool.query(
    `SELECT id, name, inventory_mode, sales_flow FROM products WHERE id IN (?) ORDER BY id`,
    [toClassify.map(p => p.id)]
  );
  console.log('AFTER REPORT:\n');
  after.forEach(p => console.log(`  #${p.id} "${p.name}" -> sales_flow=${p.sales_flow} (inventory_mode=${p.inventory_mode})`));
  console.log(`\n${after.length} product(s) classified successfully.\n`);

  await printAggregateCounts('AFTER (aggregate counts)');

  result.classified = after;
  return result;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  await classify({ dryRun });
  process.exit(0);
}

if (require.main === module) {
  main().catch(e => { console.error('FATAL', e); process.exit(1); });
}

module.exports = { classify, targetSalesFlowFor, TEST_ARTIFACT_NAME_PATTERN };
