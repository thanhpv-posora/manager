# ADR-0001 Business Correctness First

## Status
Accepted

## Decision
Business correctness is more important than clean code, convenience, or short-term speed.

## Consequences

- AI must not simplify business rules without approval.
- Security fixes must preserve customer hierarchy scope.
- Payment, price, inventory, and historical bill logic require extra review.
