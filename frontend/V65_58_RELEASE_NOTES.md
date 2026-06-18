# MeatBiz Frontend V65.58 - Customer Delete Centered Message

## Changed
- Customers page no longer uses browser `prompt()` for delete reason.
- Customer delete uses centered production modal consistent with V65.56/V65.57.
- Delete customer now requires a reason before calling the API.
- Save/delete feedback uses app toast helpers instead of native alert/prompt.

## Changed files
- src/pages/Customers.jsx
- package.json
