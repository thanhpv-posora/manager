# MeatBiz AI Dynamic Resolver

This build removes hard-coded customer/product assumptions.

## What changed

- Customer resolver:
  - First uses SQL LIKE
  - Then uses dynamic accent-insensitive matching over all active customers

- Product resolver:
  - First uses product name/customer alias SQL LIKE
  - Then uses dynamic accent-insensitive matching over all active products and aliases

- Inventory resolver:
  - Searches all TRACK_STOCK/CARCASS_PART products dynamically
  - NON_STOCK products are intentionally excluded from stock checking

- NLU:
  - OpenAI receives live business context from DB:
    - latest customers
    - active products
  - LLM still never writes DB directly

## Principle

LLM understands intent.
Business services resolve customers/products/prices/inventory from MySQL.
