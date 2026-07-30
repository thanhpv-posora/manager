# Demo Smoke Test Checklist

Run this checklist manually, in the browser, after:
1. Backup taken (`rollback_or_backup_notes.md`)
2. `reset_non_master_data_dry_run.sql` reviewed
3. `reset_non_master_data.sql` executed (or skipped, if starting from a clean DB)
4. `restore_demo_data.sql` executed
5. `backend/scripts/restore-demo-opening-stock.js` executed

None of steps 3–5 have been executed as part of this task — this checklist documents the intended verification sequence for whoever runs them.

Demo identities used below: `DEMO_CUS_CARCASS` ("DEMO - Khách Bò xô"), `DEMO_CUS_STOCK` ("DEMO - Khách Hàng kho"), `DEMO_SUP_001` ("DEMO - Nhà cung cấp"), `DEMO_PRD_CARCASS` ("DEMO - Thịt bò xô"), `DEMO_PRD_STOCK` ("DEMO - Bắp bò kho").

---

## 1. Login
- [ ] Log in with an existing real ADMIN account (this script does not create or touch users/passwords).
- [ ] Confirm the sidebar menu loads per that user's `user_menu_permissions`.

## 2. Product list
- [ ] Open Products (Mặt hàng). Confirm `DEMO - Thịt bò xô` and `DEMO - Bắp bò kho` both appear.
- [ ] Confirm the "Luồng bán" column shows "Bò xô" for the first, "Hàng kho" for the second.
- [ ] Open Edit on `DEMO - Bắp bò kho` — confirm "Làm mới" button is hidden (Edit-mode guard), and stock quantity shows the opening balance posted by the Node script (50, unless changed).

## 3. Partner list
- [ ] Open Customers/Partners (Đối tác). Confirm `DEMO - Khách Bò xô` and `DEMO - Khách Hàng kho` appear, each with the correct `default_sales_flow` reflected in the UI (if displayed).
- [ ] Confirm `DEMO - Nhà cung cấp` appears under Suppliers.

## 4. Bò Xô (CARCASS_POS / NON_STOCK) bill
- [ ] Create a new order for `DEMO - Khách Bò xô`.
- [ ] Add `DEMO - Thịt bò xô` to the cart. Confirm the demo price (150,000) is applied from the demo price book.
- [ ] Complete the sale. Confirm no stock-quantity check/rejection occurs (NON_STOCK — untracked).
- [ ] Confirm the order appears in Order history with correct total.

## 5. Hàng Kho (INVENTORY_SALE / TRACK_STOCK) bill
- [ ] Create a new order for `DEMO - Khách Hàng kho`.
- [ ] Add `DEMO - Bắp bò kho`, quantity less than the current opening balance. Confirm the demo price (180,000) is applied.
- [ ] Complete the sale. Confirm `stock_quantity` decreases by the sold quantity (check Product edit screen or Stock Ledger).
- [ ] Attempt to sell a quantity greater than remaining stock. Confirm it is rejected (unless `allow_negative_stock` was enabled — it is not, for this demo product) with the expected Vietnamese error message.

## 6. Pricing validation
- [ ] Confirm both demo products only ever price from their respective demo price book — no accidental fallback to another customer's/category's pricing.

## 7. Inventory deduction validation
- [ ] After the Hàng Kho sale in step 5, check Stock Ledger (Sổ kho) for `DEMO - Bắp bò kho`: one `OPENING_BALANCE` (IN) row, one `OUT` (SALE) row, balance reconciles.

## 8. Partial payment
- [ ] On the Hàng Kho order, record a partial payment less than the order total. Confirm remaining debt is computed correctly and reflected against `DEMO - Khách Hàng kho`.

## 9. Debt validation
- [ ] Confirm `DEMO - Khách Hàng kho`'s current debt (computed live from `debt_transactions`, per business rule — never stored) matches order total minus partial payment from step 8.

## 10. Purchase / receive test
- [ ] Create a Purchase Order or Receive Voucher from `DEMO - Nhà cung cấp` for `DEMO - Bắp bò kho`, using the seeded `supplier_purchase_options` row (unit: kg).
- [ ] Complete the receive. Confirm `stock_quantity` for `DEMO - Bắp bò kho` increases by the received quantity, and a corresponding `IN` row appears in Stock Ledger with `reference_type` pointing at the receive voucher (not `OPENING_BALANCE`).

## 11. Reports
- [ ] Open relevant business reports (Sales / Inventory / Debt) and confirm the demo transactions above appear without errors and without corrupting totals for real, non-demo data.

## 12. Repeatable-reset verification
- [ ] Re-run `restore_demo_data.sql` a second time (against the same DB state). Confirm it completes with no duplicate rows created (re-check the verification SELECT block inside the script — every `@demo_*` id should resolve to the SAME id as before).
- [ ] Re-run `restore-demo-opening-stock.js` a second time. Confirm it logs "Opening balance already posted... Nothing to do." and does NOT add a second opening entry or double the stock.

---

## Pass / Fail Summary
- [ ] All 12 sections passed — demo dataset is ready for repeated test cycles.
- [ ] Any failures — record here with section number, expected vs actual, and whether it blocks sign-off.
