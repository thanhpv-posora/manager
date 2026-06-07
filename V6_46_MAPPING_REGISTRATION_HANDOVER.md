# V6.46 Mapping User-KH Registration Approval

Scope:
- Mapping user-KH
- Registration approval flow

Changed:
- frontend/src/pages/UserCustomerMapping.jsx
- backend/src/agents/UserCustomerMappingAgent.js
- backend/src/routes/userMapping.js
- backend/src/agents/RegistrationAgent.js
- frontend/src/index.css

What changed:
- Mapping user-KH screen now shows pending customer account registrations.
- Admin can click "Duyệt & tạo user" directly in Mapping user-KH.
- Approval creates customer + user role CUSTOMER, maps user.customer_id.
- Manual create user now hashes password with bcrypt.
- RegistrationAgent has safe schema upgrade columns: user_id, customer_id, approved_at, rejected_at.

Expected flow:
1. Customer registers from Landing page.
2. Admin opens Mapping user-KH.
3. Pending registration appears at top.
4. Admin clicks Duyệt & tạo user.
5. New user appears in user list and customer mapping is already attached.
6. Admin can go to Phân quyền user to assign trial features.
