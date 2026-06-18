# ADR-0001: Historical Bill Immutability

## Decision
Confirmed historical bill item prices must not be silently changed.

## Reason
Bills are commercial records. Rewriting old bills destroys auditability.

## Consequence
Corrections require versioning, cancellation, adjustment, or correction workflow.
