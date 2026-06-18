# MeatBiz Business Bible V1

This file defines the first formal business governance rules for MeatBiz.

## Prime Rule

Business correctness is more important than implementation convenience.

## Core Governance

### BR-CORE-001
Business correctness is more important than code elegance.

### BR-CORE-002
Every financial action must be traceable.

### BR-CORE-003
Every destructive action must be reversible or auditable.

### BR-CORE-004
Soft delete is the default for business records.

### BR-CORE-005
Historical records are evidence and must not be silently rewritten.

### BR-CORE-006
AI must ask questions when business intent is unclear.

### BR-CORE-007
No hard-coded customer, product, price, or date may enter production logic.

### BR-CORE-008
Production must fail closed when required secrets are missing.

### BR-CORE-009
One task must have one clear owner and one clear outcome.

### BR-CORE-010
Code changes must be reviewed against this Business Bible before merge.

## Customer Scope

### BR-SCOPE-001
CUSTOMER role may represent a distributor, not only an end buyer.

### BR-SCOPE-002
A CUSTOMER may have child customers.

### BR-SCOPE-003
A user may only access data in their allowed customer tree.

### BR-SCOPE-004
ADMIN may access all customer trees.

### BR-SCOPE-005
STAFF access must be explicitly scoped by policy.

### BR-SCOPE-006
CUSTOMER must never see another root customer tree.

### BR-SCOPE-007
customer_id in request body must never be trusted blindly.

### BR-SCOPE-008
Customer scope must be enforced server-side, not only by frontend menus.

### BR-SCOPE-009
Creating a child customer must attach it to the current customer scope unless ADMIN/STAFF overrides.

### BR-SCOPE-010
Product/catalog writes by CUSTOMER are forbidden until scoped catalog design exists.

## Bills and POS

### BR-BILL-001
Bill total at creation must be calculated on the backend.

### BR-BILL-002
Frontend price is only a suggestion and must be revalidated.

### BR-BILL-003
Bill date must not be in the future.

### BR-BILL-004
Historical bill item price must remain immutable after confirmation.

### BR-BILL-005
Editing a paid bill must use correction/versioning workflow, not silent overwrite.

### BR-BILL-006
Bill print must reflect stored data, not recomputed current prices.

### BR-BILL-007
AI voice may create draft bills only.

### BR-BILL-008
Human confirmation is required before real bill creation.

### BR-BILL-009
Bill status changes must be auditable.

### BR-BILL-010
Bill customer must be inside user scope.

## PriceBook

### BR-PRICE-001
Customer prices are time-dependent.

### BR-PRICE-002
Changing price today must not change old bills.

### BR-PRICE-003
Price lookup must use bill/shipping date, not current date.

### BR-PRICE-004
Only one active effective price should exist for one customer/product/date.

### BR-PRICE-005
PriceBook conflict must be prevented by validation or constraint.

### BR-PRICE-006
Legacy customer_product_prices may be read only as fallback until migration completes.

### BR-PRICE-007
Default product price is fallback only, not customer-specific truth.

### BR-PRICE-008
Manual price must be explicitly marked and audited.

### BR-PRICE-009
Price deletion must be soft delete with reason.

### BR-PRICE-010
Price import must validate duplicates before applying.

## Payment and Debt

### BR-PAY-001
Payment must never modify order item quantities.

### BR-PAY-002
Payment must never silently change historical bill price.

### BR-PAY-003
Payment affects debt, allocation, and payment status only.

### BR-PAY-004
Overpayment must become unapplied credit unless explicitly allocated.

### BR-PAY-005
Payment allocation must be auditable per bill.

### BR-PAY-006
Cancel payment must create/reverse ledger entries safely.

### BR-PAY-007
Payment update should move toward cancel-and-create-new model.

### BR-PAY-008
CUSTOMER may only create payments inside own scope if business policy allows.

### BR-PAY-009
Cash and bank amounts must remain separately traceable.

### BR-PAY-010
Idempotency must not silently fail when payment_transaction_requests table is absent.

## Inventory

### BR-INVENTORY-001
Inventory should be transaction-based.

### BR-INVENTORY-002
Direct stock_quantity updates are technical debt and must be controlled.

### BR-INVENTORY-003
Stock transaction ledger must be append-only.

### BR-INVENTORY-004
Purchase lot is the source of meat supply.

### BR-INVENTORY-005
Sale should create stock OUT transaction when inventory mode requires it.

### BR-INVENTORY-006
NON_STOCK products must not block bill creation due to stock.

### BR-INVENTORY-007
CARCASS_PART logic must be explicit and documented.

### BR-INVENTORY-008
Inventory race conditions must be addressed before high-volume production.

### BR-INVENTORY-009
Inventory snapshot may be derived from transactions.

### BR-INVENTORY-010
Stock adjustment requires reason and audit trail.

## AI and OCR

### BR-AI-001
AI must never invent customer names.

### BR-AI-002
AI must never invent products.

### BR-AI-003
AI must never invent prices.

### BR-AI-004
AI must query database or use deterministic parser where possible.

### BR-AI-005
AI output that affects money must use draft-confirm flow.

### BR-AI-006
AI payment actions must require explicit confirmation.

### BR-AI-007
OCR alias learning must be auditable.

### BR-AI-008
Low-confidence AI results must ask for clarification.

### BR-AI-009
Prompt injection must not override MeatBiz business rules.

### BR-AI-010
AI must not bypass backend validation.

## Security

### BR-SEC-001
JWT secret fallback is forbidden.

### BR-SEC-002
Wildcard CORS is forbidden in production.

### BR-SEC-003
Login endpoints must have rate limiting.

### BR-SEC-004
Real secrets must never be stored in .env.example.

### BR-SEC-005
Service account JSON must never be in frontend.

### BR-SEC-006
ALLOW_PLAIN_PASSWORD must be false in production.

### BR-SEC-007
Role is not enough; scope is required.

### BR-SEC-008
Destructive actions require server-side authorization.

### BR-SEC-009
Audit logs must record privileged operations.

### BR-SEC-010
Production startup must fail if required security env vars are absent.
