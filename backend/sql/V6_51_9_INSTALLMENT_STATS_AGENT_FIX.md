# V6.51.9 - Installment Stats Agent Fix

Fixed `DebtMonthlyInstallmentAgent` statistics.

## Problem
Bill/print showed `Góp nợ/ngày` was paid, but the statistics page returned 0.
Some old payment rows had `payments.installment_amount = 0` even though the payment amount included installment money.

## Fix
Statistics now uses an effective paid installment amount:

1. Use `payments.installment_amount` if it is greater than 0.
2. Otherwise derive it from:
   `payment.amount - current_bill_amount`, limited by `orders.installment_amount`.

## SQL repair
Added:
`backend/sql/v6_51_9_installment_stats_agent_fix.sql`
