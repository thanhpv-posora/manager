# MeatBiz V59 - User Scope + Mobile Numeric Keyboard

## Fixed in this package

1. Mobile/tablet numeric keyboard
- POS quantity inputs use `inputMode="decimal"`.
- POS cash/bank fields already use `MoneyInput`, now globally enhanced.
- Price matrix numeric inputs use numeric keyboard.
- Product stock / threshold fields use decimal keyboard.
- A global input enhancer in `App.jsx` also catches dynamically rendered numeric fields.

2. Product owner scope
- New products store `product_owner_user_id`, `created_by`, `owner_prefix`.
- Product code is automatically prefixed by user, e.g. `U12-BO0001`.
- If a user manually types `BO0001`, backend stores `U12-BO0001`.
- ADMIN can see all products.
- STAFF/CUSTOMER see only products they created.

3. Dashboard scope
- ADMIN sees all dashboard data.
- CUSTOMER sees only their customer data.
- STAFF/non-admin sees orders created by their user.

4. Private price matrix scope
- Product list in price matrix only shows products available to that user.
- Adding product to customer catalog validates product ownership.
- POS customer catalog order endpoint uses the same product scope.

## Required SQL
Run:

```sql
source backend/sql/V59_USER_SCOPED_PRODUCTS_MOBILE_NUMERIC.sql;
```

## Important note
Existing old products have no `product_owner_user_id`, so non-admin users will not see legacy/global products. This is intentional based on the requirement: each user sees only products created by that user. Admin still sees all.
