# Customer Scope Rules

## Principle

A CUSTOMER account represents a business customer, not merely an end-user. That customer may also manage sub-customers.

## Allowed scope

A CUSTOMER may read/write business data only where:

- record.customer_id == user.customer_id, or
- record.customer_id is a descendant of user.customer_id in the customer hierarchy.

## Forbidden

CUSTOMER must never:

- see unrelated customers
- create payments for customers outside scope
- update global product catalog
- delete shared data
- bypass parent_customer_id validation

## Implementation direction

Create a single shared scope helper/service and use it everywhere:

```text
CustomerScopeService
  - getScopedCustomerIds(user)
  - assertCustomerInScope(user, customerId)
  - buildCustomerWhere(user, alias)
```
