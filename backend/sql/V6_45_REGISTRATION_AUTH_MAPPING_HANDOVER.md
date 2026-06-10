# V6.45 Registration/Auth Mapping Agent

Scope: Registration/Auth/User mapping only.

Root cause:
- Public registration saved data into customer_account_registrations only.
- Admin approval only changed status to APPROVED.
- No users row was created, so customer could not login.
- RegisterAccount validation had missing braces, so submit could be blocked incorrectly.

Fixed:
1. RegistrationAgent.updateStatus(APPROVED)
   - Creates customers row.
   - Creates users row with role CUSTOMER.
   - Copies registration password_hash into users.password_hash.
   - Maps users.customer_id to customers.id.
   - Stores user_id/customer_id/approved_at back into registration row.

2. RegistrationAgent.create
   - Blocks duplicate username in users.
   - Blocks duplicate registration username.
   - Uses bcrypt password_hash, no plain password.

3. RegisterAccount.jsx
   - Fixed validation braces.
   - Added show/hide password buttons.

4. Registrations.jsx
   - Button text changed to "Duyệt & tạo user".
   - Shows user_id/customer_id after approval.
   - Uses toast success/error.

Expected flow:
- Customer registers account.
- Admin opens registrations and clicks "Duyệt & tạo user".
- Customer can login using registered username/password.
- Admin can assign menus in UserPermissions screen.

Files changed:
- backend/src/agents/RegistrationAgent.js
- frontend/src/pages/RegisterAccount.jsx
- frontend/src/pages/Registrations.jsx
- frontend/src/index.css
