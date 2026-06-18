# MeatBiz Knowledge Platform V1

This directory is the single source of truth for MeatBiz business, architecture, AI governance, security, and roadmap.

## Reading Order

1. `MEATBIZ.md`
2. `docs/01-vision/product_vision.md`
3. `docs/02-business/business_bible_v2.md`
4. `docs/03-domain-model/domain_model_v1.md`
5. `docs/04-architecture/architecture_bible_v1.md`
6. `docs/06-security/security_bible_v1.md`
7. `docs/07-ai/ai_constitution_v1.md`
8. `docs/10-roadmap/v70_to_v100_roadmap.md`
9. `docs/adr/`

## Governance

- Docs are not decoration. They are binding rules for implementation.
- Any code change that conflicts with these rules must be rejected or escalated.
- Business rules override generic coding style.
- Architecture Decision Records explain why important decisions were made.
- AI agents must never infer business rules from code alone when docs exist.
