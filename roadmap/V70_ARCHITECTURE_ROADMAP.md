# MeatBiz V70 Architecture Roadmap

## Objective

Stabilize production risks and establish enterprise-grade architecture foundations.

## P0 Security Sprint

1. Remove JWT fallback secret.
2. Add CORS allowlist.
3. Add login/OTP/AI rate limits.
4. Lock CUSTOMER role routes.
5. Rotate exposed secrets.

## P1 Data Integrity Sprint

1. Ensure payment idempotency table exists.
2. Add price book uniqueness rule.
3. Add AI session TTL.
4. Remove DDL from request handlers.

## P1 Architecture Sprint

1. Create canonical migration framework.
2. Plan payment cancel+replace model.
3. Plan inventory ledger/snapshot model.
4. Remove backend mirror from frontend tree if stale.

## V80 Direction

- Inventory forecasting.
- Supplier AI purchasing.
- Dashboard aggregates.
- Customer portal scoping.

## V90 Direction

- Mobile/tablet optimized POS.
- Offline-safe cashier flow.
- Automated reconciliation.

## V100 Direction

- Autonomous AI operating assistant for meat wholesale business.
