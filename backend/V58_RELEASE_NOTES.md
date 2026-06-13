# V58 User-scoped products + mobile numeric keyboard

- Numeric/money/quantity fields open numeric keyboard on phone/tablet.
- New products save `created_by` from logged-in user.
- Non-admin users only see products they created.
- Dashboard revenue is scoped by customer_id for customer users.
- Price matrix product lists are scoped by product creator.
- Run backend SQL: `sql/V58_USER_SCOPED_PRODUCTS_DASHBOARD.sql`.
