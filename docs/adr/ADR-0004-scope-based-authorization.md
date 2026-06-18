# ADR-0004: Scope-Based Authorization

## Decision
CUSTOMER role is governed by customer tree scope, not simple read-only permission.

## Reason
A MeatBiz customer may also have customers of their own.

## Consequence
Every endpoint must validate role and customer scope.
