# SalesPriceResolver — Sales Price Resolution Engine

**Version:** 1.0
**Status:** Approved Architecture — Pending Implementation (S2-001C)
**Scope:** Sales price resolution only. Supplier pricing, carcass cost, bò xô, and inventory cost are explicitly out of scope.

---

## Objective

Define a single, authoritative engine — `SalesPriceResolver` — that every entry point (AI, POS, Import, API) must use when resolving a customer-facing selling price. No entry point may determine a sale price on its own.

This document supersedes any implicit price logic in `order.service.js`, `OrderAgent.js`, or route handlers that existed prior to S2-001C.

---

## Business Rules

| ID | Rule |
|---|---|
| BR-PRICE-001 | All selling prices must be resolved through `SalesPriceResolver`. No entry point (AI, POS, Import, API) may compute or hardcode a sale price independently. |
| BR-PRICE-002 | `SalesPriceResolver` resolves in strict priority order: Price Book → Legacy Customer Price → Product Default. The first non-null, non-zero result wins. |
| BR-PRICE-003 | Price resolution uses the **bill's intended delivery/shipping date**, not the current server time. An order dated yesterday resolves at yesterday's active price, not today's. |
| BR-PRICE-004 | If no price can be resolved at any level, the call must throw a structured error. A sale price of zero is never silently accepted. |
| BR-PRICE-005 | Historical bills are immutable. A confirmed bill's `order_items.sale_price` and `price_type` must never be altered by later price changes. |
| BR-PRICE-006 | The `price_book_id` on each confirmed `order_items` row is a permanent audit record. It must be set at confirmation time and never nulled. |
| BR-PRICE-007 | LUNAR calendar customers resolve price against lunar price books. The `lunar_date_text` derived from the bill date governs which book entry is active. |
| BR-PRICE-008 | A manually spoken or typed price (voice POS, Excel override) is an input hint only. The resolver decides the authoritative price. If the hint differs, it may be stored as `source: 'MANUAL_OVERRIDE'` for audit, but the resolver result is what enters `order_items`. |
| BR-PRICE-009 | Supplier pricing, purchase cost, carcass cost (bò xô), and inventory valuation are governed by separate rules and separate engines. This resolver does not touch them. |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                         Callers                              │
│  AI Draft/Confirm  │  Manual POS  │  Excel Import  │  API   │
└──────────┬─────────┴──────┬───────┴───────┬────────┴──┬─────┘
           │                │               │           │
           └────────────────┴───────────────┴───────────┘
                                    │
                                    ▼
                        ┌───────────────────────┐
                        │   SalesPriceResolver   │  ← single entry point
                        │  (resolves, validates, │
                        │   returns audit shape) │
                        └──────────┬────────────┘
                                   │  calls in priority order
             ┌─────────────────────┼─────────────────────┐
             ▼                     ▼                     ▼
  ┌────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
  │  PriceBookProvider │  │ LegacyCustomerPrice  │  │ DefaultProductPrice  │
  │  (customer_price_  │  │ Provider             │  │ Provider             │
  │   books table,     │  │ (customer_product_   │  │ (products.           │
  │   versioned,       │  │  prices table,       │  │  default_sale_price) │
  │   SOLAR + LUNAR)   │  │  legacy flat price)  │  │                      │
  └────────────────────┘  └──────────────────────┘  └──────────────────────┘
             │                     │                     │
             └─────────────────────┴─────────────────────┘
                                    │
                              Database (MySQL 8)
```

### Layer Responsibilities

| Layer | Responsibility | Must NOT Do |
|---|---|---|
| **Callers** (AI, POS, Import, API) | Pass `customerId`, `productId`, `billDate`, `calendarType`, `lunarDateText` to resolver | Compute price, query price tables directly |
| **SalesPriceResolver** | Orchestrate provider calls in priority order; validate result; return audit-shaped object | Contain business domain logic other than price resolution |
| **PriceBookProvider** | Query `customer_price_books` + `price_book_items` for active versioned entry at bill date | Fall back to other tables |
| **LegacyCustomerPriceProvider** | Query `customer_product_prices` for a flat legacy price | Invent prices or apply calendar logic |
| **DefaultProductPriceProvider** | Return `products.default_sale_price` | Modify the product record |

---

## Resolution Flow

```
SalesPriceResolver.resolve(context)
  │
  │  context = {
  │    customerId,
  │    productId,
  │    billDate,          ← YYYY-MM-DD, required
  │    calendarType,      ← 'SOLAR' | 'LUNAR'
  │    lunarDateText,     ← 'DD/MM/YYYY', required when calendarType='LUNAR'
  │    conn?              ← optional DB connection (for transaction reuse)
  │  }
  │
  ├─ Step 1: PriceBookProvider.get(context)
  │    SELECT FROM customer_price_books + price_book_items
  │    WHERE customer_id = customerId
  │      AND calendar_type = calendarType
  │      AND effective date <= billDate (SOLAR) or <= effective_lunar_sort (LUNAR)
  │    ORDER BY effective date DESC LIMIT 1
  │
  │    → If found: return { sale_price, price_type:'PRICE_BOOK', price_book_id, source:'PRICE_BOOK' }
  │
  ├─ Step 2 (if Step 1 null): LegacyCustomerPriceProvider.get(context)
  │    SELECT sale_price FROM customer_product_prices
  │    WHERE customer_id = customerId AND product_id = productId
  │
  │    → If found: return { sale_price, price_type:'PRIVATE_PRICE', price_book_id:null, source:'LEGACY' }
  │
  ├─ Step 3 (if Step 2 null): DefaultProductPriceProvider.get(context)
  │    SELECT default_sale_price FROM products WHERE id = productId
  │
  │    → If found: return { sale_price, price_type:'COMMON_PRICE', price_book_id:null, source:'DEFAULT' }
  │
  └─ Step 4 (if Step 3 null or zero):
       throw PriceNotFoundError({
         customerId, productId, billDate,
         message: 'Khách {name} chưa có giá cho sản phẩm {name}'
       })
```

### Return Shape

Every successful resolution returns exactly this object:

```js
{
  sale_price:       Number,   // authoritative selling price (never 0, never null)
  price_type:       String,   // 'PRICE_BOOK' | 'PRIVATE_PRICE' | 'COMMON_PRICE' | 'MANUAL_OVERRIDE'
  price_book_id:    Number|null,  // book row ID; null when not from a price book
  source:           String,   // 'PRICE_BOOK' | 'LEGACY' | 'DEFAULT' | 'MANUAL_OVERRIDE'
  effective_date:   String,   // YYYY-MM-DD solar date the resolution was performed against
  calendar_type:    String,   // 'SOLAR' | 'LUNAR'
  lunar_date_text:  String|null,  // DD/MM/YYYY; null when SOLAR
  resolved_at:      String    // ISO 8601 timestamp of resolution (server time)
}
```

---

## Providers

### PriceBookProvider

- **Table:** `customer_price_books` (header) + `price_book_items` (lines)
- **Key column:** `effective_from` for SOLAR; `effective_lunar_sort` (`YYYY*10000+MM*100+DD`) for LUNAR
- **Selection:** Most recent book whose effective date ≤ bill date, scoped to `customer_id` and `calendar_type`
- **Returns:** `sale_price`, `price_book_id` from the matching line for `product_id`
- **Null when:** No active book exists for this customer + product + date

### LegacyCustomerPriceProvider

- **Table:** `customer_product_prices`
- **Selection:** Single flat price row for `(customer_id, product_id)`; no date filtering
- **Returns:** `sale_price` with `price_type = 'PRIVATE_PRICE'`, `price_book_id = null`
- **Null when:** No row exists for this customer + product
- **Note:** This provider is the migration bridge. As customers are migrated to price books, their rows in `customer_product_prices` become redundant. The table is retained for backward compatibility.

### DefaultProductPriceProvider

- **Table:** `products`
- **Column:** `default_sale_price`
- **Returns:** `sale_price` with `price_type = 'COMMON_PRICE'`, `price_book_id = null`
- **Null when:** `default_sale_price` IS NULL or = 0
- **Note:** This is the floor fallback. Every product should have a non-zero `default_sale_price` set by an admin. If even this is missing, `SalesPriceResolver` throws.

---

## AI Pricing Rules

These rules apply to the AI draft/confirm flow (`order.service.js`, `chat.service.js`).

| Rule | Detail |
|---|---|
| **AI-P-001** | AI may not compute price from NLU intent. If a user says "3 kg nạm giá 150k", the `150k` is a user hint — it must not be used as the bill price. |
| **AI-P-002** | AI draft creation must call `SalesPriceResolver.resolve()` for every item after product identity is confirmed. The resolved price is stored in the draft. |
| **AI-P-003** | AI draft confirmation must re-call `SalesPriceResolver.resolve()` inside the database transaction, at the bill's `bill_date`. The re-resolved price is what enters `order_items`. |
| **AI-P-004** | If the re-resolved price at confirmation differs from the draft price, the confirmation response must include a `price_warnings` array listing each changed item. The AI must surface this to the user. |
| **AI-P-005** | `price_type` in `order_items` must reflect the resolver's `price_type`. `'PRIVATE_PRICE'` is never hardcoded. |
| **AI-P-006** | `price_book_id` must be inserted into `order_items` at confirmation. NULL is only acceptable when `source = 'LEGACY'` or `source = 'DEFAULT'`. |
| **AI-P-007** | AI may not accept or pass a `bill_date` that is more than 90 days in the past or any date in the future. Validation occurs before calling the resolver. |
| **AI-P-008** | `createRepeatOrderDraft()` must call `SalesPriceResolver.resolve()` at the current date for each item — it must not copy prices from the original bill. |

---

## Manual POS Rules

These rules apply to the manual order creation flow (`OrderAgent.create()`, `CreateOrder.jsx`).

| Rule | Detail |
|---|---|
| **POS-P-001** | `OrderAgent.create()` already calls `PriceBookService.getEffectivePrice()`. After S2-001C, it must be updated to call `SalesPriceResolver.resolve()` instead, with the same parameters. |
| **POS-P-002** | A staff member may apply a manual discount or override in the POS UI. The override is recorded as `source: 'MANUAL_OVERRIDE'`, `price_type: 'MANUAL_PRICE'`, alongside the resolver's price for audit. |
| **POS-P-003** | Manual price overrides require an ADMIN or authorised STAFF role. A CUSTOMER-role user may never override a price. |
| **POS-P-004** | The POS screen must display the resolved price from the server. It must not compute price client-side. The frontend receives the resolver result; it does not call price tables directly. |

---

## Excel Import Rules

These rules apply to any future bulk import path.

| Rule | Detail |
|---|---|
| **IMP-P-001** | An Excel import row that contains a price column treats that value as a user hint only. The import pipeline must call `SalesPriceResolver.resolve()` for each row. |
| **IMP-P-002** | If the imported price differs from the resolved price, the row is flagged in the import report. The import does not silently accept the imported price. |
| **IMP-P-003** | An ADMIN-role import may accept `source: 'MANUAL_OVERRIDE'` for specific rows. This must be an explicit per-row flag, not a batch setting. |
| **IMP-P-004** | Import `bill_date` per row is respected. Resolution uses the row's `bill_date`, not the import run date. |

---

## Forbidden Patterns

The following patterns are forbidden in all new and modified code:

```js
// FORBIDDEN — hardcoded price_type
price_type: 'PRIVATE_PRICE'

// FORBIDDEN — price from user NLU input used directly as sale price
const price = item.price || product.price;

// FORBIDDEN — querying customer_product_prices directly for billing price
COALESCE(cpp.sale_price, p.default_sale_price, 0) AS price

// FORBIDDEN — missing price_book_id in order_items INSERT
INSERT INTO order_items (product_id, sale_price, price_type, ...)
// must include price_book_id

// FORBIDDEN — using server date instead of bill date for price lookup
const orderDate = todayYmd();
// must be: const orderDate = normalizeBillDate(payload.bill_date)

// FORBIDDEN — caller querying any price table directly
pool.query('SELECT sale_price FROM customer_product_prices WHERE ...')
// callers must go through SalesPriceResolver, not price tables

// FORBIDDEN — zero sale_price silently accepted
if (resolvedPrice === 0) { /* continue */ }
// must throw PriceNotFoundError
```

---

## Future Extension Points

The provider chain is designed for extension without modifying `SalesPriceResolver`.

| Extension | How | When |
|---|---|---|
| **Promotional pricing** | Add `PromotionPriceProvider` at priority 0 (before PriceBookProvider) | When promotion engine is built |
| **Group/tier pricing** | Add `CustomerGroupPriceProvider` between PriceBook and Legacy | When customer tier system is built |
| **Contract pricing** | Add `ContractPriceProvider` at priority 0 or 1 | When B2B contract module is built |
| **Floor price enforcement** | Add post-resolution validator in `SalesPriceResolver` | When minimum margin enforcement is required |
| **Currency support** | Extend resolver context with `currency_code`; providers return price in that currency | When multi-currency is needed |
| **Bundle/package pricing** | Resolver accepts array of items; providers can return bundle discount | When bundle pricing is built |

Adding a provider requires:
1. Create `<Name>Provider.js` in `backend/src/services/price-providers/`
2. Register it in `SalesPriceResolver` provider chain with explicit priority
3. Write isolated unit tests for the provider
4. No changes to callers

---

## Implementation Plan for S2-001C

**Target file changes:**
- `backend/src/services/SalesPriceResolver.js` — new file (the resolver)
- `backend/src/services/price-providers/PriceBookProvider.js` — new file (extracted from `PriceBookService`)
- `backend/src/services/price-providers/LegacyCustomerPriceProvider.js` — new file (extracted from `order.service.js`)
- `backend/src/services/price-providers/DefaultProductPriceProvider.js` — new file (new)
- `backend/src/services/order.service.js` — modified: replace inline price logic with `SalesPriceResolver.resolve()`
- `backend/src/agents/OrderAgent.js` — modified: replace `PriceBookService.getEffectivePrice()` call with `SalesPriceResolver.resolve()`
- `backend/scripts/verify-s2-001c.js` — new test script

**`PriceBookService.js` is NOT modified.** It continues to exist as-is for the `createOrReplaceBook()` and `resolveBillLookupContext()` utilities, which are write-path and date-normalisation concerns unrelated to price resolution.

### Step-by-Step Execution

```
Step 1: Create price-providers/ directory
Step 2: Write PriceBookProvider.js (extract read logic from PriceBookService)
Step 3: Write LegacyCustomerPriceProvider.js (extract from order.service.js findProductForCustomer SQL)
Step 4: Write DefaultProductPriceProvider.js (simple products.default_sale_price lookup)
Step 5: Write SalesPriceResolver.js (orchestrate providers, validate result, return audit shape)
Step 6: Write verify-s2-001c.js (all test cases — must fail at this point)
Step 7: Update order.service.js — createOrderDraft + confirmOrderDraft (tests now pass)
Step 8: Update OrderAgent.js — replace PriceBookService.getEffectivePrice call
Step 9: Run verify-s2-001c.js — all cases must pass
Step 10: Syntax check all modified files
Step 11: Report to CTO — do not commit until approval
```

### No-Change Guarantee

| Item | Change |
|---|---|
| Database schema | None |
| Frontend code | None |
| `customer_product_prices` table | None (still used by LegacyCustomerPriceProvider) |
| `PriceBookService.createOrReplaceBook()` | None |
| Supplier pricing / purchase cost flows | None |
| Carcass cost / bò xô flows | None |
| Inventory flows | None |

---

## Relation to Other Documents

| Document | Relation |
|---|---|
| `docs/02-business/core-business-rules.md` | BR-0001, BR-0002: price immutability and versioning — this engine enforces them |
| `docs/07-ai/ai_constitution_v1.md` | Article 1 (AI cannot invent prices), Article 3 (backend is authority) — this engine is how those articles are enforced for prices |
| `docs/06-security/` | Scope enforcement (BR-0005) applies to resolver callers — `assertCustomerScope` must be called before `SalesPriceResolver.resolve()` |
| `backend/src/services/PriceBookService.js` | PriceBookProvider wraps this service's read logic. PriceBookService continues to own write operations. |
| S1-002F (scope bypass fixes) | Prerequisite. Resolver assumes scope has already been enforced by the route/agent layer. |
| S2-001C | Implements this specification. |
