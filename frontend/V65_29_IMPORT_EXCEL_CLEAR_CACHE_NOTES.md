# V65.29 - Import Excel clear cache fix

## Fixed
- POS import Excel: selecting a new Excel/image file now starts a fresh import session.
- Clears previous preview, import text, sheet queue, current sheet index, and file input value.
- Resets import mode to REPLACE for each new file to avoid accidental ADD duplication.
- Adds read sequence guard so late async file reads cannot overwrite the latest import session.
- After applying rows to bill, applied preview rows are unselected to prevent double-click applying the same rows again.
- Price Matrix import Excel: clears previous preview/file cache before reading a new file and resets file input value.

## Notes
- Backend unchanged from V65.28.
