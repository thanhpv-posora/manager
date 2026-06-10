# MeatBiz V6.51 – Debt Schedule Management Completed

## Done

- Removed manual "Thu nợ cũ" input from the payment UI.
- Added monthly debt schedule table: `debt_monthly_installments`.
- Added `DebtMonthlyInstallmentAgent` with:
  - `getActiveInstallment(customerId, month, year)`
  - `activeByDate(customerId, dateText)`
  - `list(month, year)`
  - `upsertCustomerInstallment(customerId, month, year, amount)`
  - `applyMonthlyInstallments(month, year, customerInstallments)`
- Added monthly installment routes under `/api/installments/monthly`.
- Updated `Payments.jsx`:
  - payment form now has bill today + cash + bank transfer only.
  - monthly installment is pulled from plan automatically.
  - added monthly installment management section.
- Updated POS payment panel in `CreateOrder.jsx`:
  - bill today + monthly installment = payable total.
  - cash/bank auto-fill each other.
  - if both fields are manually edited, underpayment is accepted.
- Updated `PaymentAgent`:
  - calculates payable total, paid total, remaining debt.
  - applies payment to today's bill first, then monthly installment allocation.
  - no validation error when paid total is less than payable total.
- Updated print:
  - Bill hôm nay
  - Góp nợ tháng
  - Tổng cần thanh toán
  - Tiền mặt
  - Chuyển khoản
  - Còn nợ

## Scope respected

Did not modify POS voice, OCR, Lots/NCC, SupplierAgent, ProductAgent business logic.

## Verification

- Backend syntax checked with `node -c` for changed backend files.
- Frontend production build passed with `npm run build`.
