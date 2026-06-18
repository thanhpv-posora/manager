# MeatBiz AI Native Operating System

MeatBiz is an AI-native operating system for meat wholesalers.

This repository must be governed by business correctness, auditability, scope-based security, and long-term maintainability.

## Golden Rules

1. Business correctness is more important than clean code.
2. Historical bills must never be silently rewritten.
3. Customer prices are time-based and historical prices are immutable.
4. Payment must never change historical bill prices or item quantities.
5. Inventory must move toward append-only transaction ledger and snapshot model.
6. CUSTOMER users may operate only inside their customer tree scope.
7. AI may suggest and draft, but must not commit money-affecting actions without human confirmation.
8. Production must fail closed when secrets are missing.
9. No destructive action without audit trail.
10. Claude, ChatGPT, Cursor, Copilot, and future AI tools must read this knowledge base before making changes.

## Start Here

Read:

- `docs/00-start-here/README.md`
- `docs/02-business/business_bible_v2.md`
- `docs/03-domain-model/domain_model_v1.md`
- `docs/07-ai/ai_constitution_v1.md`
- `.claude/CLAUDE.md`
