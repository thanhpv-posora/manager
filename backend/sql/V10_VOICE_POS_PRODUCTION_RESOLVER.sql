-- =========================================
-- V10 Voice POS Production Resolver helpers
-- Compatible with old MySQL versions
-- =========================================

-- 1) Ensure a walk-in customer exists for Voice POS.
INSERT INTO customers (customer_code, name, phone, is_active)
SELECT 'WALK_IN', 'Khách vãng lai', '', 1
WHERE NOT EXISTS (
  SELECT 1 FROM customers WHERE customer_code = 'WALK_IN' OR name = 'Khách vãng lai'
);

-- 2) Optional aliases for local spoken product names.
-- The backend V10 also has code-level alias resolver, so this script is only a helper.
-- If your product_ocr_aliases.customer_id does not allow NULL, skip this block and rely on code resolver.

SET @walk_in_customer_id := (
  SELECT id FROM customers
  WHERE customer_code = 'WALK_IN' OR name = 'Khách vãng lai'
  ORDER BY id ASC LIMIT 1
);

SET @bo_bap_id := (
  SELECT id FROM products
  WHERE del_flg = 0 AND is_active = 1
    AND (name LIKE '%bắp%' OR name LIKE '%bap%')
  ORDER BY id ASC LIMIT 1
);

SET @gau_id := (
  SELECT id FROM products
  WHERE del_flg = 0 AND is_active = 1
    AND (name LIKE '%gầu%' OR name LIKE '%gau%')
  ORDER BY id ASC LIMIT 1
);

SET @nam_id := (
  SELECT id FROM products
  WHERE del_flg = 0 AND is_active = 1
    AND (name LIKE '%nạm%' OR name LIKE '%nam%')
  ORDER BY id ASC LIMIT 1
);

INSERT INTO product_ocr_aliases (customer_id, alias_text, product_id, source, hit_count, created_at, updated_at)
SELECT @walk_in_customer_id, alias_text, product_id, 'AI_VOICE_POS_V10', 1, NOW(), NOW()
FROM (
  SELECT 'bup' alias_text, @bo_bap_id product_id UNION ALL
  SELECT 'búp', @bo_bap_id UNION ALL
  SELECT 'bap', @bo_bap_id UNION ALL
  SELECT 'bắp', @bo_bap_id UNION ALL
  SELECT 'gau', @gau_id UNION ALL
  SELECT 'gầu', @gau_id UNION ALL
  SELECT 'nam', @nam_id UNION ALL
  SELECT 'nạm', @nam_id
) x
WHERE x.product_id IS NOT NULL
  AND @walk_in_customer_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM product_ocr_aliases poa
    WHERE poa.customer_id = @walk_in_customer_id
      AND poa.alias_text = x.alias_text
      AND poa.product_id = x.product_id
  );

SELECT 'V10_VOICE_POS_PRODUCTION_RESOLVER DONE' AS result;
