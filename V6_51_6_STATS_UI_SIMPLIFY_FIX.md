# MeatBiz V6.51.6 - Installment Stats UI Simplify Fix

## Changes
- Simplified installment actual payment statistics UI.
- When a customer is selected, the date range follows that customer's `billing_calendar_type`.
- If customer uses LUNAR billing, only lunar date inputs are shown.
- If customer uses SOLAR billing, only solar date inputs are shown.
- Removed the confusing duplicated solar + lunar selector panels from the statistics section.
- Statistics button now refreshes both range stats and day/month/year summary.

## Notes
- Statistics still calculate only from actual collected installment money in `payments.installment_amount`.
- No change to installment config page, POS mapping, bill print critical fixes, payment logic, K80/A4 layout fixes.
