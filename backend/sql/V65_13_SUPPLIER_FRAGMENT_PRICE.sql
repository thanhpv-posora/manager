-- MeatBiz V65.13 - NCC price setup + fragment meat separate price
-- Thịt vụn tính tiền riêng, không trừ khỏi kg bò xô.

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS male_price DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS female_price DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fragment_price DECIMAL(15,2) NOT NULL DEFAULT 0;

ALTER TABLE purchase_lots
  ADD COLUMN IF NOT EXISTS fragment_price DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fragment_cost DECIMAL(15,2) NOT NULL DEFAULT 0;

-- Optional recalculation for old V65.12 lots that treated fragment as deduction.
-- Review before running on production if old bills were already finalized.
-- UPDATE purchase_lots
-- SET fragment_cost = fragment_weight * fragment_price,
--     total_cost = (male_weight * male_price) + (female_weight * female_price) + (fragment_weight * fragment_price)
-- WHERE del_flg = 0;
