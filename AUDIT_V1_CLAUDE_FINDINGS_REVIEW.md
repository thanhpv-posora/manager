# Audit V1 - Claude Findings Reviewed by Chief Architect

Claude's first repository discovery is accepted as a valid baseline.

## Accepted P0 findings

1. `dev_secret` JWT fallback.
2. wildcard CORS.
3. missing rate limiting.
4. CUSTOMER role over-permission risk.
5. plain-text seed password risk.
6. secrets exposure risk.

## Accepted P1 findings

1. mixed migration mechanisms.
2. payment update revert/reapply.
3. inventory direct stock update.
4. ai_chat_sessions no TTL.
5. payment_transaction_requests may be missing.
6. backend source mirrored inside frontend.

## Business clarifications to encode

1. Bill after payment should require correction workflow.
2. PriceBook duplicate effective dates must be blocked, not last-write-wins.
3. target_debt_amount is technical debt until business meaning is confirmed.
4. Payment update should become cancel + replacement.
5. Inventory should move to ledger + snapshot.
