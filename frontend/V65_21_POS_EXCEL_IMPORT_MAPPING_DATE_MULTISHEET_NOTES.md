# MeatBiz V65.21 – POS Excel Import mapping/date/multi-sheet fix

## Fixes
- Fixed POS Excel import apply action so selected rows are applied by stable product_id, not by row/order.
- Duplicate mapped rows in Excel are grouped by product_id before applying to bill.
- Supports reading all sheets in the uploaded Excel workbook.
- Reads bill date from Excel header area.
- If selected customer uses lunar calendar, Excel date is treated as lunar bill date and converted to solar order_date for storage.
- If selected customer uses solar calendar, Excel date is treated as solar bill date.
- Excel import still only uses product name + quantity; prices always come from the system/customer price list.

## Notes
- Unmapped rows remain in preview and are not applied.
- Preview raw row now includes sheet name for easier checking.
