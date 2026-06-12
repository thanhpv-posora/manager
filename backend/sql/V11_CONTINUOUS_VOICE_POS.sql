-- =========================================
-- V11_CONTINUOUS_VOICE_POS
-- Seed alias dictionary for meat wholesale voice POS.
-- Compatible with old MySQL versions.
-- =========================================

-- NOTE:
-- product_ocr_aliases requires real product_id, so this script adds aliases by matching product names.
-- If a product name does not exist yet, the INSERT will skip it safely.

INSERT INTO product_ocr_aliases (customer_id, alias_text, product_id, source, hit_count, created_at, updated_at)
SELECT NULL, 'xg', p.id, 'VOICE_POS_V11', 1, NOW(), NOW()
FROM products p
WHERE p.del_flg = 0 AND p.is_active = 1 AND (p.name LIKE '%Xương%' OR p.name LIKE '%xương%')
LIMIT 1
ON DUPLICATE KEY UPDATE updated_at = NOW(), hit_count = COALESCE(hit_count,0) + 1;

INSERT INTO product_ocr_aliases (customer_id, alias_text, product_id, source, hit_count, created_at, updated_at)
SELECT NULL, 'xg ong', p.id, 'VOICE_POS_V11', 1, NOW(), NOW()
FROM products p
WHERE p.del_flg = 0 AND p.is_active = 1 AND (p.name LIKE '%ống%' OR p.name LIKE '%ong%')
LIMIT 1
ON DUPLICATE KEY UPDATE updated_at = NOW(), hit_count = COALESCE(hit_count,0) + 1;

INSERT INTO product_ocr_aliases (customer_id, alias_text, product_id, source, hit_count, created_at, updated_at)
SELECT NULL, 'xg suon', p.id, 'VOICE_POS_V11', 1, NOW(), NOW()
FROM products p
WHERE p.del_flg = 0 AND p.is_active = 1 AND (p.name LIKE '%sườn%' OR p.name LIKE '%suon%')
LIMIT 1
ON DUPLICATE KEY UPDATE updated_at = NOW(), hit_count = COALESCE(hit_count,0) + 1;

INSERT INTO product_ocr_aliases (customer_id, alias_text, product_id, source, hit_count, created_at, updated_at)
SELECT NULL, 'bup', p.id, 'VOICE_POS_V11', 1, NOW(), NOW()
FROM products p
WHERE p.del_flg = 0 AND p.is_active = 1 AND (p.name LIKE '%bắp%' OR p.name LIKE '%bap%')
LIMIT 1
ON DUPLICATE KEY UPDATE updated_at = NOW(), hit_count = COALESCE(hit_count,0) + 1;

INSERT INTO product_ocr_aliases (customer_id, alias_text, product_id, source, hit_count, created_at, updated_at)
SELECT NULL, 'gau', p.id, 'VOICE_POS_V11', 1, NOW(), NOW()
FROM products p
WHERE p.del_flg = 0 AND p.is_active = 1 AND (p.name LIKE '%gầu%' OR p.name LIKE '%gau%')
LIMIT 1
ON DUPLICATE KEY UPDATE updated_at = NOW(), hit_count = COALESCE(hit_count,0) + 1;

INSERT INTO product_ocr_aliases (customer_id, alias_text, product_id, source, hit_count, created_at, updated_at)
SELECT NULL, 'gan pho', p.id, 'VOICE_POS_V11', 1, NOW(), NOW()
FROM products p
WHERE p.del_flg = 0 AND p.is_active = 1 AND (p.name LIKE '%gân phở%' OR p.name LIKE '%gân phô%' OR p.name LIKE '%gan pho%')
LIMIT 1
ON DUPLICATE KEY UPDATE updated_at = NOW(), hit_count = COALESCE(hit_count,0) + 1;

SELECT 'V11_CONTINUOUS_VOICE_POS DONE' AS result;
