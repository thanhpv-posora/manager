# P0 Security Rules

## P0-S1 JWT
No `dev_secret` fallback. Server must fail to start if JWT_SECRET is missing.

## P0-S2 CORS
No wildcard CORS in production. Use explicit origin allowlist.

## P0-S3 Scope
CUSTOMER operations must be limited to the user's customer tree.

## P0-S4 Rate Limit
Login, forgot password, and OTP endpoints must be rate limited.

## P0-S5 Secrets
No real keys in `.env.example`, frontend, git history, or documentation. Rotate exposed keys immediately.
