# Legacy Product Classification — Migration Guide

## Purpose

`products.sales_flow` (CARCASS_POS / INVENTORY_SALE) is required for a product to be sellable through either the existing POS screen or the new Inventory Sales screen. Products created before this classification existed have `sales_flow IS NULL`. `ProductAgent.assertDomainImmutable()` — an existing, unchanged business rule — refuses to let `ProductAgent.updateProduct()` set a classification on any product that already has business history (`order_items` / `purchase_order_items` / `inventory_receive_items` / `stock_transactions`), since that rule exists to stop an *already-classified* product from being silently reclassified after the fact.

`migrate-classify-legacy-products.js` is the approved, narrowly-scoped, one-time exception for the different situation of a product that has *never* been classified. It does not call and does not modify `assertDomainImmutable()` or `updateProduct()`. It writes `sales_flow` directly, through a query that can only ever touch a row where `sales_flow IS NULL` — both in its candidate `SELECT` and again in the `UPDATE`'s own `WHERE` clause — so it structurally cannot overwrite an existing classification, including under a concurrent write.

Target classification is never guessed: `SALES_FLOW_INVENTORY_MODE_COMPAT` (in `backend/src/utils/productSalesFlow.js`) is a strict bijection — `NON_STOCK` can only ever be `CARCASS_POS`, `TRACK_STOCK` can only ever be `INVENTORY_SALE` — and the tool validates every target through the same `assertSalesFlowInventoryModeCombo()` that `ProductAgent`/`OrderAgent`/`PriceMatrixAgent` already use at runtime. No duplicated or looser validation logic exists anywhere in this tool.

Products whose name matches this codebase's own throwaway verify-script naming (`Recon Test...`, `S11 SALES...`, `S1D...`, `DEBUG ...`, etc.) are reported but **skipped**, never classified — they are not real business data.

## Status

**Not executed against real data as of this release.** The tool has been verified against isolated throwaway fixtures only (`verify-migrate-classify-legacy-products.js`, 22/22 passing) — see that script for coverage detail. Real product data currently has `sales_flow IS NULL` on every not-yet-classified product; executing this tool for real is a separate, deliberate release action, not something this commit performs.

## Execution Steps

Run from `backend/`:

```
node scripts/migrate-classify-legacy-products.js --dry-run   # 1. preview — no writes
node scripts/migrate-classify-legacy-products.js             # 2. live run — writes inside a transaction
```

Always run `--dry-run` first and read the report before running live. The tool is safe to run more than once (idempotent) — a second run will simply report 0 candidates once the first run has completed.

## Dry-Run

`--dry-run` runs the exact same candidate discovery, skip-logic, and validation as a live run, but exits before opening a transaction. Nothing is written. Use it to confirm the classification plan before committing to it, and to re-check state at any time without risk.

## Expected Report

Every run prints, in order:
1. **BEFORE (aggregate counts)** — `products` grouped by `(inventory_mode, sales_flow)`, for a full-picture sanity check before anything happens.
2. **BEFORE REPORT** — one line per candidate (`sales_flow IS NULL`, active, not soft-deleted): `[CLASSIFY]` for a real product with an unambiguous target, `[SKIP-TEST-ARTIFACT]` for a throwaway-script-named row, `[SKIP-AMBIGUOUS]` for an `inventory_mode` with no valid mapping or a combo that fails validation.
3. **Summary** line: counts for each of the three outcomes above.
4. (Live run only) **Transaction committed.**, then **AFTER REPORT** — the final `sales_flow` for every row just classified, then the same aggregate counts as step 1 for before/after comparison.

On error inside the transaction, the run instead prints `ERROR — transaction rolled back, no changes were made:` with the reason, and exits non-zero — nothing partial is ever left committed.

## Rollback

There is no standing rollback script in the repository — a real migration run's rollback is inherently point-in-time (it must target the exact IDs that specific run classified), so a reusable script would either need re-editing per run anyway or would risk silently reverting the wrong set. Instead, roll back using the run's own **AFTER REPORT** (every ID it touched and the exact `sales_flow` it set) as the input to a manual, reviewed, transactional statement:

```sql
START TRANSACTION;

UPDATE products SET sales_flow=NULL
WHERE id IN (<INVENTORY_SALE ids from that run's AFTER REPORT>) AND sales_flow='INVENTORY_SALE';

UPDATE products SET sales_flow=NULL
WHERE id IN (<CARCASS_POS ids from that run's AFTER REPORT>) AND sales_flow='CARCASS_POS';

COMMIT;
```

The `AND sales_flow='...'` guard matters: it ensures the rollback only reverts rows still holding exactly the value that run set, so it can never revert a row someone else has since reclassified for a real reason. Run the equivalent `SELECT ... WHERE id IN (...) AND sales_flow<>'...'` first to confirm zero rows would be skipped unexpectedly, then re-run `verify-product-sales-flow-separation.js` afterward (see Post Verification) to confirm no regression.

If this needs to happen often enough to justify a reusable tool, that is itself a signal the tool should gain a `--rollback --run-log=<path>` mode reading a persisted report from the live run, rather than reconstructing a one-off script per incident — track that as a follow-up if it comes up, not something to pre-build speculatively now.

## Post Verification

After a live run (forward or rollback), confirm:
1. Aggregate counts in the AFTER REPORT match expectations (no unexpected `(NULL)` rows shrinking/growing).
2. `node scripts/verify-product-sales-flow-separation.js` still passes 100% (proves the classification didn't regress either sales channel).
3. Spot-check a handful of real product IDs directly: `SELECT id, name, sales_flow FROM products WHERE id IN (...)`.
