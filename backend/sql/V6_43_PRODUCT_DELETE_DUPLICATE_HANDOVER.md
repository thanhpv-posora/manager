# V6.43 Product Agent Delete Warning + Duplicate Name

Scope: Product/Mặt hàng only.

Changed:
- backend/src/agents/ProductAgent.js
- frontend/src/pages/Products.jsx

Backend:
- addProduct checks duplicate product name with LOWER(TRIM(name)).
- updateProduct checks duplicate product name excluding current id.
- quickProduct checks duplicate product name.
- Duplicate names are blocked even if only uppercase/lowercase differs.

Frontend:
- Product save uses toast success/error/warning.
- Product delete catches dependency errors and shows warning toast.
- Delete dependency errors are no longer silent in the console only.

Not touched:
- POS/CreateOrder
- Lots/NCC
- Login
- Docker
- OCR
- Price Matrix
- SoftDeleteAgent
