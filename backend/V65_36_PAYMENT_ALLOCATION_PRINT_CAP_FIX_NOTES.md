# V65.36 Payment allocation print cap fix

- Payment allocation now allocates money to all unpaid customer bills by shipping/order date, oldest first.
- Receipt amount is preserved as original payment, but each bill print only shows the allocated amount for that bill.
- A later receipt that clears old debt partially is capped on the old bill and the remainder is allocated to the next bill.
- Cash/bank split remains preserved per allocation.
- A4/K80 print summary now caps displayed payment rows by remaining bill balance to avoid showing the full receipt amount on an old bill.
