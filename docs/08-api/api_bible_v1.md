# MeatBiz API Bible V1

## API Principles

- Every write endpoint must validate role and scope.
- Every money endpoint must validate on backend.
- Every list endpoint that exposes customer data must enforce scope.
- Every destructive endpoint must soft-delete or audit.
- Every retryable financial endpoint should be idempotent.

## Response Style

Use consistent JSON:
- success
- data
- message
- error code when needed
