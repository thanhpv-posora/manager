# MeatBiz V65.18 - Lot form reset empty after save

## Changes
- After saving a purchase lot successfully, reset the lot entry form fields to empty strings instead of `0`.
- Cleared: lot name, raw weight, rib/bone weight, total animals, female animals, deduct kg, manual deduct, fragment kg, damage/fat/other deductions, deduction note.
- Collapse the detailed deduction block after successful save.
- Keep supplier/date/calendar/price context so the user can continue entering another lot for the same supplier without reselecting.

## Build
- Frontend build completed successfully using Vite.
