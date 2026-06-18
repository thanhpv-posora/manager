# Core Business Rules

## BR-0001 Historical bill immutability
Confirmed bills are business records. Their historical item prices must never be overwritten by later price changes.

## BR-0002 PriceBook versioning
Customer prices are time-dependent. Price changes create new effective versions. They must not update old bills.

## BR-0003 Payment separation
Payment affects debt/payment status/history. Payment must never rewrite order item price or order business amount.

## BR-0004 Inventory audit trail
Inventory changes must be traceable. Direct stock mutation without transaction/audit trail is forbidden for future architecture.

## BR-0005 Customer hierarchy scope
CUSTOMER users may have their own customers. They may operate only inside their customer tree. Role alone is insufficient; every query/write needs scope validation.

## BR-0006 Global catalog vs scoped catalog
Global products belong to MeatBiz owner/admin. CUSTOMER write access to products is forbidden until scoped product catalog is implemented.

## BR-0007 AI draft confirmation
AI may create drafts and suggestions. Human confirmation is required before creating real bills or payments.
