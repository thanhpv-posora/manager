# MeatBiz AI Skill System

This build adds an OpenClaw-style skill registry.

## Endpoints

```text
GET /api/ai/skills
GET /api/ai/manifest
```

## Current skills

- NluSkill
- OrderSkill
- PaymentSkill
- InsightSkill

## Architecture

```text
Voice/Text
  -> NLU
  -> Intent Router
  -> Skill
  -> Business Service
  -> MySQL Transaction
```

The LLM never writes to DB directly.

## Why this matters

This lets MeatBiz grow like an AI agent platform:
- add InventorySkill
- add SupplierSkill
- add PricingSkill
- add ReminderSkill
- add PrintSkill
- add Zalo/Telegram gateway
