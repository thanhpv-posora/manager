# V58 User scope + mobile numeric input

## Backend
Run SQL after deploy:

```sql
source backend/sql/V58_USER_SCOPED_PRODUCTS_DASHBOARD.sql;
```

Changes:
- products.created_by added.
- New products are saved with logged-in user id.
- Non-admin users only see/manipulate products they created.
- Price matrix product list is filtered by product owner.
- Dashboard revenue is restricted by customer_id for customer users.

## Frontend
- Numeric/money/quantity fields get inputmode numeric/decimal on phone/tablet.
- Build checked OK, then dist/node_modules removed from zip.
