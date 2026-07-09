# MeatBiz Inventory Backlog

---

## Sprint S4.1 — Receive Voucher

- Partial Receive
- Multiple Receive
- Short Close
- Receive Tolerance
- Actual Weight
- Reopen Draft for Confirmed PO if no receive/movement exists

---

## Sprint S5.1 — Inventory Movement Hardening

- **S5.1-C — Inventory Movement Idempotency IN** (IMPLEMENTED — pending CEO review before commit)

  **Problem:** `InventoryMovementService.postIn()` guards against duplicate RECEIVE_VOUCHER postings with
  `SELECT stock_transactions WHERE product_id=? AND reference_type='RECEIVE_VOUCHER' AND reference_id=? AND type='IN'`
  followed later by an `INSERT`. This is check-then-act: two concurrent `postIn()` calls for the same
  `(product_id, reference_id)` can both pass the SELECT before either INSERT commits, producing a duplicate
  IN movement and double stock increment.

  **Existing mitigation (not sufficient alone):** `InventoryReceiveService.receive()` takes
  `SELECT ... FROM inventory_receives WHERE id=? FOR UPDATE` on the voucher header and rejects re-processing
  once status leaves `PENDING`. That closes the race for concurrent `receive()` calls on the *same* receiveId,
  but `postIn()`'s own dup-check is meant as a second, independent line of defense ("must not depend on callers
  getting that right") — and that second line is itself not atomic.

  **Decision — uniqueness key must include `product_id`:** one `inventory_receives.id` spans multiple
  `inventory_receive_items` rows, each with its own `product_id`. So the dedup key must be
  `(product_id, reference_type, reference_id, type)` — never `reference_id` alone, or the first product line
  posted would falsely block every other legitimate product line under the same voucher.

  **Options evaluated:**
  1. **DB unique constraint on `stock_transactions(product_id, reference_type, reference_id, type)`** — rejected
     as a blanket index: `SALE`/`OUT` and `MANUAL` adjustment rows can legitimately repeat the same tuple (e.g.
     the same product on two order lines, or an order line adjusted twice), which a blanket constraint would
     falsely block. `reference_id IS NULL` rows (MANUAL, OPENING_BALANCE) are unaffected either way since MySQL
     treats each NULL as distinct.
     - **Recommended refinement:** scope the constraint to RECEIVE_VOUCHER/IN only via a generated column —
       `receive_dedup_key VARCHAR(64) GENERATED ALWAYS AS (CASE WHEN reference_type='RECEIVE_VOUCHER' AND type='IN' THEN CONCAT(product_id,':',reference_id) ELSE NULL END) STORED`
       + `UNIQUE KEY` on that column. NULL bypasses uniqueness for every other movement type, so SALE/ADJUSTMENT/LOT/OPENING_BALANCE behavior is provably unchanged.
  2. **Insert-first strategy** — not standalone; only meaningful paired with option 1. Attempt the INSERT
     (relying on the unique constraint) instead of SELECT-then-INSERT, and catch `ER_DUP_ENTRY` to raise the
     existing "đã được ghi nhận tồn kho" error. Removes the race window entirely since MySQL enforces the
     constraint atomically at INSERT time regardless of concurrent transactions.
  3. **Named lock / transaction lock (`GET_LOCK`)** — rejected as primary. Session-scoped locks are unreliable
     against a pooled connection, and `receive()`'s header-level `FOR UPDATE` already achieves voucher-granularity
     locking for the same receiveId; a second, weaker lock at the movement level adds complexity without closing
     the cross-caller "sole writer" gap this ticket is about.
  4. **Application-level guard only (current state)** — rejected; this is the bug being fixed.

  **Recommendation:** Option 1 (generated-column scoped unique constraint) + Option 2 (insert-first, catch
  duplicate-key). Requires a schema migration — out of scope for this ticket; needs a dedicated
  schema-migration ticket before implementation.

  **Implementation (this pass):**
  - `backend/src/config/bootstrap.js` — added generated column `stock_transactions.receive_dedup_key`
    (`VARCHAR(64) GENERATED ALWAYS AS (CASE WHEN reference_type='RECEIVE_VOUCHER' AND type='IN' THEN
    CONCAT(product_id,':',reference_id) ELSE NULL END) STORED`) and `UNIQUE KEY
    uq_stock_transactions_receive_dedup(receive_dedup_key)`, applied via the existing idempotent
    `safeAddColumn`/`safeAddIndex` helpers (safe to re-run; no-ops if already present).
  - `backend/src/services/InventoryMovementService.js` `postIn()` — replaced the SELECT-then-INSERT guard
    with insert-first: the `INSERT INTO stock_transactions` now runs immediately (after the warehouse
    existence check, before the stock_quantity balance update), and a caught `ER_DUP_ENTRY` whose message
    matches `receive_dedup` is translated to the existing user-facing error
    ("Phiếu nhận hàng này đã được ghi nhận tồn kho cho sản phẩm này, không thể ghi trùng"); any other error
    is rethrown unchanged. The balance UPDATE only runs after the INSERT commits, so a rejected duplicate
    never touches `stock_quantity`.
  - No changes to `postOut()`, `InventoryReceiveService`, POS bò xô flow, or any other movement type.
  - Verified against dev DB: two concurrent `postIn()` calls for the same `(product_id, reference_id,
    RECEIVE_VOUCHER, IN)` — one succeeds, one fails with the Vietnamese duplicate message, final stock
    increases exactly once; same `reference_id` with a different `product_id` succeeds independently;
    a sequential retry after the first call already committed is also correctly rejected.

---

## Technical Debt

- STAB-005: Remove direct stock update from `InventoryService.applyOrderInventory()`. Sales OUT must delegate to `InventoryMovementService.postOut()`.
- Manual browser smoke test required before release
- Event Stream / Business Events
- Soft delete purchase_order_items
- syncItems transaction boundary
- Inventory single-writer cleanup for sales-side applyOrderInventory
- FK constraints for purchase/receive tables

---

## Future Business

- Supplier Score
- Print Purchase Order
- Print Receive Voucher
- Export Excel Purchase Order
- Export Excel Receive Voucher
- Warehouse Ledger

---

## S4.x Future Optimization

- Timeline API should move from JS merge/sort/paginate to SQL UNION ALL with ORDER BY event_time and LIMIT/OFFSET when timeline volume grows.
