# V6.42 Product Agent Patch

Scope: Product/Mặt hàng only.

Changed:
- frontend/src/pages/Products.jsx
- frontend/src/index.css

Added:
- Search box in Product list.
- Filter by product_code, name, category_name, unit, inventory_mode, sale_price.
- Visible labels for product form fields so users can identify each input.
- Empty number fields do not force fallback 0 while typing for touched fields changed in this screen.

Not touched:
- POS/CreateOrder
- Lots/NCC
- Login
- Docker
- OCR
- Price Matrix
- Backend agents
