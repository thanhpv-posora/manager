# MeatBiz Business Bible V2

This file is binding for all human and AI contributors.

## Rules

### BR-CORE-001

Business correctness is more important than code elegance.

### BR-CORE-002

Every financial action must be traceable.

### BR-CORE-003

Every destructive action must be reversible or auditable.

### BR-CORE-004

Soft delete is the default for business records.

### BR-CORE-005

Historical records must not be silently rewritten.

### BR-CORE-006

When business intent is unclear, ask before implementing.

### BR-CORE-007

Frontend data is never authoritative for money, stock, or price.

### BR-CORE-008

Production must fail closed when required secrets are missing.

### BR-BILL-001

Bill total must be calculated on the backend.

### BR-BILL-002

Bill date is the business date, not necessarily system current date.

### BR-BILL-003

Bill price lookup must use bill/shipping date.

### BR-BILL-004

Historical bill item price is immutable after confirmation.

### BR-BILL-005

Editing a paid bill requires correction/versioning workflow.

### BR-BILL-006

Future-date bill creation must be blocked unless explicitly approved.

### BR-BILL-007

AI voice may create only draft bills.

### BR-BILL-008

Human confirmation is required before real bill creation.

### BR-BILL-009

Printing must use stored bill data, not recalculated browser-only data.

### BR-BILL-010

Confirmed bill changes must preserve an audit trail.

### BR-PRICE-001

Customer prices are time dependent.

### BR-PRICE-002

Changing a price today must not affect old bills.

### BR-PRICE-003

Price lookup must use bill/shipping date, not current date.

### BR-PRICE-004

PriceBook is the strategic source of truth for customer pricing.

### BR-PRICE-005

Legacy customer_product_prices is transitional only.

### BR-PRICE-006

Legacy price table may be read as fallback until migration is complete.

### BR-PRICE-007

Two active price books for same customer/product/effective date are forbidden.

### BR-PRICE-008

Manual price must be explicitly marked as manual.

### BR-PRICE-009

Missing price must block bill confirmation unless manual override is approved.

### BR-PRICE-010

Historical bill item stores the resolved price and price source.

### BR-PAY-001

Payment must never modify order item quantities.

### BR-PAY-002

Payment must never silently change historical bill price.

### BR-PAY-003

Payment changes debt/payment status, not product pricing.

### BR-PAY-004

Overpayment becomes unapplied credit.

### BR-PAY-005

Payment allocation must be traceable per bill.

### BR-PAY-006

Cancel payment must reverse allocations with audit trail.

### BR-PAY-007

V70 moves payment update toward cancel-and-create-new.

### BR-PAY-008

CUSTOMER may create payments only inside own customer tree if business policy allows.

### BR-PAY-009

Cash and bank payment amounts must remain separately traceable.

### BR-PAY-010

Payment idempotency must be enforced for retry-safe operations.

### BR-SCOPE-001

Role is not enough; scope is mandatory.

### BR-SCOPE-002

ADMIN sees all company data.

### BR-SCOPE-003

STAFF sees data allowed by company policy.

### BR-SCOPE-004

CUSTOMER sees only own customer tree.

### BR-SCOPE-005

CUSTOMER may have child customers.

### BR-SCOPE-006

Customer scope must be enforced server-side.

### BR-SCOPE-007

Never trust customer_id from request body without scope verification.

### BR-SCOPE-008

A CUSTOMER must never see another customer tree.

### BR-SCOPE-009

Child customer creation by CUSTOMER must attach to their own tree.

### BR-SCOPE-010

Product/catalog writes by CUSTOMER are forbidden until scoped catalog design exists.

### BR-INVENTORY-001

Inventory must be traceable.

### BR-INVENTORY-002

Stock movement must create ledger transaction.

### BR-INVENTORY-003

Stock transaction ledger is append-only.

### BR-INVENTORY-004

Direct stock update is a legacy shortcut and must be phased out.

### BR-INVENTORY-005

Inventory snapshot may be derived from ledger.

### BR-INVENTORY-006

NON_STOCK products skip stock enforcement.

### BR-INVENTORY-007

CARCASS_PART has special inventory behavior.

### BR-INVENTORY-008

Inventory race conditions must be fixed before high-volume production.

### BR-INVENTORY-009

Purchase lot must be linked to supplier and cost basis when used for profit.

### BR-INVENTORY-010

Stock adjustment requires reason and audit.

### BR-AI-001

AI must not invent customer names.

### BR-AI-002

AI must not invent products.

### BR-AI-003

AI must not invent prices.

### BR-AI-004

AI must query database or use deterministic parser before money action.

### BR-AI-005

Money-affecting AI output must use draft-confirm flow.

### BR-AI-006

Payment actions require explicit human confirmation.

### BR-AI-007

AI confidence below threshold must ask clarification.

### BR-AI-008

AI must explain uncertainty when data is missing.

### BR-AI-009

Prompt injection must not override MeatBiz rules.

### BR-AI-010

AI must not bypass backend validation.

### BR-SEC-001

JWT secret fallback is forbidden.

### BR-SEC-002

CORS must use explicit allowlist.

### BR-SEC-003

Login and OTP endpoints require rate limiting.

### BR-SEC-004

Production secrets must never be committed.

### BR-SEC-005

Service account JSON must never exist in frontend.

### BR-SEC-006

ALLOW_PLAIN_PASSWORD must not be enabled in production.

### BR-SEC-007

Customer scope is a security boundary.

### BR-SEC-008

Sensitive operations require audit logs.

### BR-SEC-009

Delete operations require role and scope checks.

### BR-SEC-010

Fail closed when security config is missing.


## Clarifications Added After Claude Review

### Payment Update Roadmap
- V66/V67: legacy update may exist.
- V70: prefer cancel-and-create-new for payment corrections.
- V72: remove dangerous payment update paths after migration.

### Customer Scope Policy
CUSTOMER role is not read-only. CUSTOMER may operate inside their own customer tree when feature policy allows. A CUSTOMER must never operate outside their tree.

### Scoped Catalog Policy
Until scoped catalog exists, CUSTOMER cannot write global catalog. Future design must separate:
- Global Product Catalog
- Customer Product Catalog
- Customer Private Product
- Product Alias / OCR Alias

### Legacy Price Migration
- V66: `customer_product_prices` may be read/write legacy.
- V70: read-only fallback.
- V72: migrate to PriceBook and remove writes.
- V80+: archive or drop legacy table only after full validation.

### Inventory Volume Threshold
High-volume means any of:
- More than 1,000 inventory transactions per day
- More than 20 concurrent POS operators
- More than 100 bills per hour
At this level, direct stock updates must be replaced by transaction + locking/snapshot design.
