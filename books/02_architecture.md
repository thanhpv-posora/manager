# Book 2 - Architecture

## Current pattern

Frontend -> API routes -> Agent -> Service -> MySQL.

Routes should stay thin.
Agents coordinate business workflow and transactions.
Services implement domain logic.
Utilities provide shared helpers.

## Boundaries

- UI may display suggested price but backend must re-resolve trusted price.
- UI may calculate preview totals but backend owns final amount.
- AI may parse intent but backend owns authorization and validation.
- Agent may coordinate transaction; service must not hide cross-domain side effects.

## Target architecture V70+

- Dedicated migration framework.
- Inventory ledger + snapshot separation.
- Payment append-only correction model.
- PriceBook uniqueness and conflict prevention.
- Security middleware per route group.
- Testable domain services.

## Architecture smell list

- Business logic in route files.
- DDL inside request handlers.
- Backend source mirrored in frontend tree.
- Shared normalization duplicated in frontend and backend without tests.
- Payment update by reverting and reapplying allocations.
