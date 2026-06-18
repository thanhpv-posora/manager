# P0 Security Rules

## SEC-0001 JWT must fail closed
No fallback secret such as `dev_secret` is allowed. Missing JWT_SECRET must stop the server.

## SEC-0002 CORS allowlist
Wildcard CORS is forbidden in production. Use explicit origin allowlist.

## SEC-0003 Login rate limit
Login, OTP, and forgot password endpoints require rate limiting.

## SEC-0004 CUSTOMER scope validation
CUSTOMER role must be scope-limited on every read/write. Never trust request body customer_id.

## SEC-0005 Secrets rotation
If `.env`, API keys, or service-account JSON are uploaded/shared, rotate credentials immediately.

## SEC-0006 No frontend service account
Google service account JSON must never exist in frontend.
