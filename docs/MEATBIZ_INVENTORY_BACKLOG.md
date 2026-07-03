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
