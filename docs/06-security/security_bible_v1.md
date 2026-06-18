# MeatBiz Security Bible V1

## P0 Rules

1. No JWT fallback secret.
2. No wildcard CORS in production.
3. No production secrets in git.
4. No service account JSON in frontend.
5. No CUSTOMER cross-scope access.
6. Login, OTP, and password reset must be rate-limited.
7. Production must fail closed if secrets are missing.

## Role + Scope

Role answers: what kind of user is this?  
Scope answers: whose data can this user access?

Both are required.

## Immediate P0 Remediation

- Rotate OpenAI key if uploaded/shared.
- Rotate Google service account key if uploaded/shared.
- Remove real values from `.env.example`.
- Add startup validation for JWT_SECRET and production config.
