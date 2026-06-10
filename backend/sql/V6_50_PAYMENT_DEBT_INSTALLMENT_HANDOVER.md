# V6.50 Payment / Debt / Installment Patch

Scope:
- PaymentAgent
- DebtInstallmentAgent
- Payments.jsx
- Installments.jsx
- bootstrap migration
- index.css

Main rule:
- Only 1 payment row / 1 receipt per payment.
- Payment row stores:
  - amount = total received
  - cash_amount
  - bank_amount
  - current_bill_amount
  - installment_amount

Example:
- Bill today: 70,000,000
- Old debt/installment collected: 3,000,000
- Cash received: 73,000,000
- One payments row:
  - amount = 73,000,000
  - cash_amount = 73,000,000
  - bank_amount = 0
  - current_bill_amount = 70,000,000
  - installment_amount = 3,000,000

Debt:
- Installment/old debt payment reduces debt.
- It does not add to debt.
- Current debt = sales/adjustment increase - payments/adjustment decrease.

Installment:
- Installment payments can be irregular.
- Each payment has its own amount, cash_amount, bank_amount.
- Monthly/daily planned amount is only default suggestion, not mandatory.
