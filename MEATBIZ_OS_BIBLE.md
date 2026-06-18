# MeatBiz OS Bible V1

## Identity

MeatBiz is not a generic POS. MeatBiz is an AI-native operating system for meat wholesalers.

The system must protect money, bills, historical prices, debt, inventory, customer scope, and audit history before it protects code elegance.

## Prime Directive

Business correctness is more important than clean code.

No AI or engineer may simplify business logic unless the business owner approves the exact behavioral change.

## System Philosophy

1. Historical records are legal/accounting records.
2. Bills must preserve the price and quantity at the time of sale.
3. Payment never changes the original bill amount.
4. Price changes create new effective versions; they never rewrite history.
5. Inventory must become transaction-ledger based.
6. AI can assist, draft, classify, and suggest, but human confirmation is required for money-moving or stock-moving actions.
7. Customer data must be scoped. A customer must never see another customer's data.
8. Every destructive action must be reversible or auditable.
9. The database schema must be predictable, versioned, and recoverable.
10. Security defaults must fail closed, never fail open.

## Current Observed Architecture

Backend: Node.js + Express + MySQL 8. Route -> Agent -> Service -> DB pattern.

Frontend: React 18 + Vite SPA with a single Axios API client and page routing managed in App.jsx.

AI: deterministic parser plus OpenAI NLU fallback; AI draft-confirm lifecycle for orders and payments.

Database: bootstrap-driven schema creation with AutoMigrationAgent and inline DDL in some agents.

Deployment: Docker-style deployment, API on port 4000, frontend via Vite/dev or nginx/prod.

## Claude Report Validation

Claude's initial repository discovery was valuable and found correct P0 risks:

- JWT fallback `dev_secret`.
- Wildcard CORS.
- No rate limiting.
- CUSTOMER role over-permission risk.
- Mixed schema migration strategy.
- Plain-text seed password risk.
- Backend source mirrored inside frontend/src.
- Payment update revert/reapply risk.
- AI session lifecycle/TTL not defined.

These findings are accepted as part of MeatBiz OS Bible V1.

## Non-Negotiable Rules

- Never update historical order item prices because customer price changed.
- Never update order total during payment except through an explicitly approved legacy compatibility migration.
- Never direct-delete business records; use soft delete and audit logs.
- Never allow CUSTOMER role to operate outside its own customer scope.
- Never use fallback secrets in production.
- Never run destructive schema changes without backup and approval.
- Never allow AI to create confirmed orders/payments without user confirmation.

## Development Workflow

1. Business intent.
2. Architecture design.
3. Risk analysis.
4. Implementation plan.
5. Claude Code source review.
6. ChatGPT business validation.
7. Test and release checklist.
8. ADR update.
9. Technical debt update.

## Roles

- Product Owner/CEO: Phan Viết Thanh decides business policy.
- ChatGPT: Chief Software Architect; designs business, architecture, roadmap, and reviews AI suggestions.
- Claude Code: Senior Engineer/Reviewer; reads codebase, finds bugs, proposes patches, refactors only with approval.

## Required Reading for AI Agents

Before any review or code change, AI must read:

1. `MEATBIZ_OS_BIBLE.md`
2. `.claude/CLAUDE.md`
3. `business/core_business_rules.md`
4. `security/p0_security_rules.md`
5. Relevant module file under `business/`
6. Relevant prompt under `.claude/prompts/`
