# Database Rules

- Use explicit history/ledger tables for money and inventory.
- Do not rely on silent startup DDL for high-risk production migrations forever.
- Add migration history for every schema change.
- Add unique constraints for business invariants where possible.
- Do not keep live secrets in `.env.example`.

## V70 targets

- Normalize payment idempotency table creation.
- Add CustomerScope-friendly indexes.
- Add PriceBook uniqueness rules.
- Move inventory toward transaction + snapshot model.
