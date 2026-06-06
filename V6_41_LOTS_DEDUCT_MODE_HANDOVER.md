# V6.41 Lots / Supplier Agent Handover

Scope locked to Nhập Lô / NCC only.

## Fixed
- Numeric inputs no longer force `0` while user is deleting text.
- Number inputs keep string/empty value in React state.
- Calculation converts empty value to 0 only at calculation time.

## Added deduction mode
`deduct_mode`:
- `PER_ANIMAL`: total deduction = total_animals * deduct_kg_per_animal
- `TOTAL_KG`: total deduction = deducted_weight_expr / deducted_weight manual total

## Added cattle split
- total_animals
- female_animals
- male_animals auto calculated
- male_price
- female_price
- male_weight
- female_weight

## Rib bone rule
- bone_weight / 2 is converted into meat weight and added to raw meat weight.

## Other deductions
- damage_weight
- fat_weight
- other_deduct_weight
- deduct_note

## Print
Print receipt now shows:
- deduction calculation mode
- rib conversion
- cattle split male/female
- different prices
- supplier payment summary
- note / description

## Files changed
- frontend/src/pages/Lots.jsx
- frontend/src/index.css
- backend/src/agents/SupplierAgent.js
- backend/src/services/PrintService.js
- backend/src/config/bootstrap.js
