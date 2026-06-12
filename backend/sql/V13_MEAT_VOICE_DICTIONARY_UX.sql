-- =========================================
-- V13_MEAT_VOICE_DICTIONARY_UX
-- Voice POS alias dictionary for meat wholesaler language.
-- Compatible with old MySQL versions.
-- =========================================

-- This script safely inserts aliases only when a matching product exists.
-- If the alias already exists, it only refreshes updated_at/hit_count.

INSERT INTO product_ocr_aliases (customer_id, alias_text, product_id, source, hit_count, created_at, updated_at)
SELECT NULL, 'xg ong', p.id, 'VOICE_POS_V13', 1, NOW(), NOW()
FROM products p
WHERE COALESCE(p.del_flg,0)=0 AND COALESCE(p.is_active,1)=1 AND (p.name LIKE '%xương ống%' OR p.name LIKE '%Xg ống%' OR p.name LIKE '%ong%')
LIMIT 1
ON DUPLICATE KEY UPDATE updated_at=NOW(), hit_count=COALESCE(hit_count,0)+1;

INSERT INTO product_ocr_aliases (customer_id, alias_text, product_id, source, hit_count, created_at, updated_at)
SELECT NULL, 'xg suon', p.id, 'VOICE_POS_V13', 1, NOW(), NOW()
FROM products p
WHERE COALESCE(p.del_flg,0)=0 AND COALESCE(p.is_active,1)=1 AND (p.name LIKE '%xương sườn%' OR p.name LIKE '%Xg Sườn%' OR p.name LIKE '%suon%')
LIMIT 1
ON DUPLICATE KEY UPDATE updated_at=NOW(), hit_count=COALESCE(hit_count,0)+1;

INSERT INTO product_ocr_aliases (customer_id, alias_text, product_id, source, hit_count, created_at, updated_at)
SELECT NULL, 'xg nac', p.id, 'VOICE_POS_V13', 1, NOW(), NOW()
FROM products p
WHERE COALESCE(p.del_flg,0)=0 AND COALESCE(p.is_active,1)=1 AND (p.name LIKE '%xương nạc%' OR p.name LIKE '%Xg Nạc%' OR p.name LIKE '%nac%')
LIMIT 1
ON DUPLICATE KEY UPDATE updated_at=NOW(), hit_count=COALESCE(hit_count,0)+1;

INSERT INTO product_ocr_aliases (customer_id, alias_text, product_id, source, hit_count, created_at, updated_at)
SELECT NULL, 'xg uc', p.id, 'VOICE_POS_V13', 1, NOW(), NOW()
FROM products p
WHERE COALESCE(p.del_flg,0)=0 AND COALESCE(p.is_active,1)=1 AND (p.name LIKE '%xương ức%' OR p.name LIKE '%Xg ức%' OR p.name LIKE '%uc%')
LIMIT 1
ON DUPLICATE KEY UPDATE updated_at=NOW(), hit_count=COALESCE(hit_count,0)+1;

INSERT INTO product_ocr_aliases (customer_id, alias_text, product_id, source, hit_count, created_at, updated_at)
SELECT NULL, 'xg duoi', p.id, 'VOICE_POS_V13', 1, NOW(), NOW()
FROM products p
WHERE COALESCE(p.del_flg,0)=0 AND COALESCE(p.is_active,1)=1 AND (p.name LIKE '%xương đuôi%' OR p.name LIKE '%Xg đuôi%' OR p.name LIKE '%duoi%')
LIMIT 1
ON DUPLICATE KEY UPDATE updated_at=NOW(), hit_count=COALESCE(hit_count,0)+1;

INSERT INTO product_ocr_aliases (customer_id, alias_text, product_id, source, hit_count, created_at, updated_at)
SELECT NULL, 'xg cui gan', p.id, 'VOICE_POS_V13', 1, NOW(), NOW()
FROM products p
WHERE COALESCE(p.del_flg,0)=0 AND COALESCE(p.is_active,1)=1 AND (p.name LIKE '%cùi gân%' OR p.name LIKE '%cui gan%')
LIMIT 1
ON DUPLICATE KEY UPDATE updated_at=NOW(), hit_count=COALESCE(hit_count,0)+1;

INSERT INTO product_ocr_aliases (customer_id, alias_text, product_id, source, hit_count, created_at, updated_at)
SELECT NULL, a.alias_text, p.id, 'VOICE_POS_V13', 1, NOW(), NOW()
FROM products p
JOIN (
  SELECT 'bup' alias_text, '%bắp%' pattern1, '%bap%' pattern2 UNION ALL
  SELECT 'bop', '%bắp%', '%bap%' UNION ALL
  SELECT 'bon', '%bon%', '%nạm%' UNION ALL
  SELECT 'nam', '%nạm%', '%nam%' UNION ALL
  SELECT 'nam', '%nầm%', '%nam%' UNION ALL
  SELECT 'nap', '%nấp%', '%nap%' UNION ALL
  SELECT 'gau', '%gầu%', '%gau%' UNION ALL
  SELECT 'gau nac', '%gầu nạc%', '%gau nac%' UNION ALL
  SELECT 'gau mo', '%gầu mỡ%', '%gau mo%' UNION ALL
  SELECT 'gan pho', '%gân phở%', '%gan pho%' UNION ALL
  SELECT 'gan pho', '%gân phô%', '%gan pho%' UNION ALL
  SELECT 'gan phoi', '%gan phổi%', '%gan phoi%' UNION ALL
  SELECT 'huyet', '%huyết%', '%huyet%' UNION ALL
  SELECT 'luoi', '%lưỡi%', '%luoi%' UNION ALL
  SELECT 'long', '%lòng%', '%long%' UNION ALL
  SELECT 'mo', '%mỡ%', '%mo%' UNION ALL
  SELECT 'phi le', '%phi lê%', '%phi le%' UNION ALL
  SELECT 'so', '%sọ%', '%so%' UNION ALL
  SELECT 'gio', '%giò%', '%gio%' UNION ALL
  SELECT 'ria', '%rìa%', '%ria%' UNION ALL
  SELECT 'vun', '%vụn%', '%vun%'
) a ON (p.name LIKE a.pattern1 OR p.name LIKE a.pattern2)
WHERE COALESCE(p.del_flg,0)=0 AND COALESCE(p.is_active,1)=1
ON DUPLICATE KEY UPDATE updated_at=NOW(), hit_count=COALESCE(hit_count,0)+1;

SELECT 'V13_MEAT_VOICE_DICTIONARY_UX DONE' AS result;
