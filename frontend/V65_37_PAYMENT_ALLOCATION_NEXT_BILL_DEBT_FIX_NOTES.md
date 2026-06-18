# V65.37 Payment Allocation Next Bill Debt Fix

- Fix Thu tiền allocation when customer pays more than the oldest bill debt.
- Payment now continues to the next unpaid bill by Ngày xuất hàng, oldest first.
- Uses computed debt `max(debt_amount, total_amount - paid_amount)` to avoid stale `debt_amount` blocking allocation.
- Keeps cash/bank split per allocation.
- Print A4/K80 continues to read payment_allocations by bill, so each bill prints only the amount allocated to itself.
