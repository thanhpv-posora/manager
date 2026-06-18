# ADR-0002: PriceBook Versioning

## Decision
Customer prices are versioned by effective date and calendar type.

## Reason
A customer may have one price in one month and another price later.

## Consequence
Bill price lookup uses bill/shipping date, never current date.
