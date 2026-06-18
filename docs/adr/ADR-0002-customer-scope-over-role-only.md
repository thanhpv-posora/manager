# ADR-0002 Customer Scope Over Role Only

## Status
Accepted

## Context
A CUSTOMER in MeatBiz may have customers of their own.

## Decision
Authorization is not only role-based. It must be role + customer hierarchy scope.

## Consequence
CUSTOMER write access is not automatically forbidden. It is allowed only for scoped business operations. Shared/global data remains admin/staff-only until scoped versions exist.
