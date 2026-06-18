# MeatBiz Architecture Bible V1

## Architecture Style

Current: Node.js/Express + React + MySQL monolith.  
Target V70: Clean modular monolith.  
Target V80+: module boundaries ready for extraction.

## Layering Rule

UI → API Route → Agent/UseCase → Service → Repository/DB → Database

Controllers/routes must remain thin.

## Agent Role

Agents orchestrate business workflows and cross-service coordination.

## Service Role

Services hold domain functions and reusable business logic.

## Database Rule

Schema must move away from scattered inline migration toward ordered, auditable migrations.

## Frontend Rule

Frontend may assist input, but backend is authoritative for:
- Price
- Total
- Stock
- Debt
- Scope
- Permissions
