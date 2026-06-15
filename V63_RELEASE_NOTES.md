# V63 Payment Transaction Safety

## Fixed
- Thu tiền now uses an `idempotency_key` so network drops/retries do not create duplicate payments.
- Current bill + selected old debt allocation runs inside one MySQL transaction.
- Payment allocation details are written to `payment_allocations`.
- Payment request state is written to `payment_transaction_requests`.
- Added API: `GET /api/payments/transaction/:key` to check transaction status.

## SQL
Run:

```text
backend/sql/V63_PAYMENT_TRANSACTION_SAFETY.sql
```

## Test cleanup
For dev/test database only:

```text
backend/sql/V63_TEST_CLEAN_TABLES.sql
```
