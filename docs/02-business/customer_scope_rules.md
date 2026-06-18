# Customer Scope Rules

## Core Concept

CUSTOMER is not always an end buyer. A CUSTOMER may be a distributor with their own customers. Therefore, the correct permission model is role + scope, not role only.

## Scope Tree

A user with CUSTOMER role is attached to a root customer_id. That user may operate only inside that customer tree.

Allowed examples:

- CUSTOMER creates child customer under their own customer_id.
- CUSTOMER creates bill for a child customer in their own tree.
- CUSTOMER views debt for their own child customers.

Forbidden examples:

- CUSTOMER creates payment for customer outside their tree.
- CUSTOMER changes global product catalog.
- CUSTOMER reads another root customer's debt.

## Implementation Requirement

Every endpoint that accepts customer_id must validate the resolved customer is inside the user's allowed scope.
