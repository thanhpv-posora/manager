# Technical Debt Register

## TD-0001 target_debt_amount unused
Appears in many tables but lacks clear business implementation. Decide whether to remove, document, or implement.

## TD-0002 payment_transaction_requests table uncertainty
PaymentAgent expects idempotency table. Ensure canonical migration creates it.

## TD-0003 frontend contains backend mirror
Frontend source tree appears to contain backend-like files. Confirm if intentional; otherwise remove to reduce maintenance risk.

## TD-0004 mixed schema management
bootstrap.js, AutoMigrationAgent, and inline DDL overlap. Need V70 migration governance.

## TD-0005 supplier records can be created from two paths — CLOSED
Originally: suppliers could be created via SupplierAgent's direct CRUD (Suppliers.jsx,
P2-01) or via CustomerAgent._syncPartnerToSupplier() (Customers.jsx). CTO final decision
(fix/partner cleanup): **Đối tác (Customers.jsx) is the single user-facing management
path.** The standalone Suppliers.jsx CRUD page, its 'suppliers' app_menus/
role_menu_permissions/user_menu_permissions rows were removed (SchemaMigrationAgent
cleanup, idempotent). `suppliers` remains an internal backend record — table, SupplierAgent,
/api/suppliers, supplier_partner_map, SupplierPayableAgent, and every Purchase/Inventory
Receive/price-book consumer are unchanged and still required.

Synchronization now goes exclusively through `CustomerAgent._syncPartnerToSupplier()`,
triggered whenever a Partner has the supplier bit set (`partner_type & 1 = 1` — see
customers.partner_type bitmask note below). Two synchronization bugs found during this
cleanup's audit were fixed in the same pass:
- Once mapped, every later save was a no-op for sync — editing a Partner's name/phone/
  address/note/billing_calendar_type never propagated to the linked supplier after the
  first save. Fixed: an already-mapped partner now UPDATEs its linked supplier.
- male_price/female_price/fragment_price (Bò Xô purchase prices) were never set by the
  auto-sync path at all. Fixed: moved into Customers.jsx's Partner form as a collapsed-
  by-default "Thông tin giá Bò Xô" section (shown only when the Partner has the supplier
  bit), and threaded through _syncPartnerToSupplier() on both create and every
  subsequent sync.

Also found and fixed in the same audit: `customers.partner_type` is a bitmask
(1=Nhà cung cấp, 2=Khách hàng, 3=Khách hàng và Nhà cung cấp) — already read that way by
PartnerAgent.listPartners(), InventoryPurchaseAgent._resolvePartner(), and
SupplierPurchaseOptionAgent, but CustomerAgent.create()/update() only ever wrote 1 or 2,
making a Partner marked as both roles impossible to create. CustomerAgent now writes the
full bitmask; Customers.jsx exposes the third "Khách hàng và Nhà cung cấp" option.

Remaining, not addressed here (unrelated to this cleanup, tracked separately): TD-0003
(frontend/src contains a mirrored backend-like tree, including a duplicate suppliers
route file — out of scope for this story).
