# MeatBiz Initial Source Audit V1

## Scope

Reviewed uploaded `backend(4).zip` and `frontend(6).zip` at source-structure and high-risk pattern level.

## Immediate P0 actions

1. Rotate exposed OpenAI API key found in uploaded backend `.env`.
2. Rotate/revoke service account key if `service-account.json` is real.
3. Remove `.env`, `service-account.json`, `package-lock` if not needed for sharing, logs, uploads, and generated assets from AI/share packages.
4. Fix JWT fallback `dev_secret` in backend auth/signing code.
5. Replace wildcard CORS with origin allowlist for production.
6. Review CUSTOMER role permissions across routes before production.

## P0 code locations observed

- `backend/src/server.js`: `app.use(cors())`.
- `backend/src/middleware/auth.js`: `process.env.JWT_SECRET || 'dev_secret'`.
- `backend/src/routes/auth.js`: JWT signing fallback `dev_secret`.
- `backend/src/routes/orders.js`: CUSTOMER can create and edit order items.
- `backend/src/routes/payments.js`: CUSTOMER can create payment.
- `backend/src/routes/priceMatrix.js`: CUSTOMER can update/delete/copy price books.
- `backend/src/routes/products.js`: CUSTOMER can create/update/delete products/categories/prices.
- `backend/src/routes/customers.js`: CUSTOMER can create/update/delete customers.

## Important nuance

The business owner said CUSTOMER users may have their own customers and may create bills for their own customers. Therefore the fix is not simply “remove CUSTOMER everywhere.” The correct fix is:

- Introduce explicit capability permissions.
- Enforce tenant/customer scope in backend service layer.
- Restrict global master-data operations.
- Allow customer-owned sub-customer workflows only within scope.

## Architecture observation

The project already has useful modular foundations: routes, agents, services, AI skills, lunar utilities, price-book service, payment agent, order agent, and frontend pages/components. The next improvement should be boundary discipline and business invariant enforcement, not a rewrite.

## Recommended next sprint

Sprint P0 Security & Scope:

1. Secret hygiene.
2. JWT fail-closed.
3. CORS allowlist.
4. Rate limit login.
5. Route permission matrix.
6. Service-layer `assertCustomerScope` / `assertTenantScope`.
7. Price/payment/order backend revalidation.
