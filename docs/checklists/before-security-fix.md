# Before Security Fix Checklist

- [ ] Does the fix preserve customer hierarchy scope?
- [ ] Does it block cross-customer access?
- [ ] Does it avoid breaking CUSTOMER's valid sub-customer workflow?
- [ ] Are secrets removed from examples?
- [ ] Are all changed endpoints tested as ADMIN, STAFF, CUSTOMER?
