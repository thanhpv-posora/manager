# MeatBiz V65.56 – Global Centered Dialog Messages

## Scope
- Frontend only.
- Replaces default browser alert UI with centered production modal.
- Adds centered confirm modal for system confirmation flows.
- Updates price book delete warning wording.

## Price book delete behavior
When deleting a price book, it is soft-deleted. Existing bills that have not collected payment keep their current item prices and unlink from the deleted price book. They will not automatically attach to a newly created price book for the same period later. New bills will resolve the newly created price book by shipping date.

## Changed files
- src/components/AppDialogHost.jsx
- src/main.jsx
- src/index.css
- src/pages/CreateOrder.jsx
- src/pages/Installments.jsx
- src/pages/Orders.jsx
- src/pages/Payments.jsx
- src/pages/PriceMatrix.jsx
- src/pages/ProductImageImport.jsx
- src/pages/SponsorVideos.jsx
- src/pages/UserCustomerMapping.jsx
- package.json
