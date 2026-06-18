# V65.30 - Price Matrix Excel Import Button Fix

- Fixed PriceMatrix Excel import button after V65.29 cache clear changes.
- Added missing resetPriceImportFileInput helper.
- Added safe read sequence guard for PriceMatrix import so stale Excel reads are ignored.
- Kept POS Excel import cache fix intact.
- Verified frontend production build OK.
