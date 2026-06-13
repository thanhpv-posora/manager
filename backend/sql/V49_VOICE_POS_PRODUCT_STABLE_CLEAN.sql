
-- V49_VOICE_POS_PRODUCT_STABLE_CLEAN.sql
-- Mục tiêu:
-- 1) Xóa alias test/gần hết/còn nhiều gây lẫn vào POS.
-- 2) Xóa alias customer-specific do AI học sai trước đây cho các alias nguy hiểm.
-- 3) Ép mỗi alias quan trọng chỉ map đúng 1 sản phẩm.
-- 4) Sau khi chạy, query cuối phải trả 0 dòng.

START TRANSACTION;

-- 1. Xoá alias của sản phẩm test/demo
DELETE poa
FROM product_ocr_aliases poa
JOIN products p ON p.id = poa.product_id
WHERE LOWER(p.name) LIKE '%test%'
   OR LOWER(p.name) LIKE '%gần hết%'
   OR LOWER(p.name) LIKE '%gan het%'
   OR LOWER(p.name) LIKE '%còn nhiều%'
   OR LOWER(p.name) LIKE '%con nhieu%';

-- 2. Xoá duplicate exact row
DELETE t1
FROM product_ocr_aliases t1
JOIN product_ocr_aliases t2
  ON t1.id > t2.id
 AND COALESCE(t1.customer_id, 0) = COALESCE(t2.customer_id, 0)
 AND LOWER(TRIM(t1.alias_text)) = LOWER(TRIM(t2.alias_text))
 AND t1.product_id = t2.product_id;

-- 3. Không cho AI/customer-specific alias cũ làm nhiễu các alias ngắn/nguy hiểm
DELETE FROM product_ocr_aliases
WHERE customer_id IS NOT NULL
  AND LOWER(TRIM(alias_text)) IN (
    'nam','nạm','nam mo','nầm','nap','nấp',
    'gan','gân','gan pho','gân phô','gân phở','gan phoi','gan phổi',
    'gau','gầu','gàu','gau nac','gầu nạc','gàu nạc','gau mo','gầu mỡ','gàu mỡ',
    'bon','bup','búp','bop','bóp',
    'phi le','phi lê',
    'xg ong','xương ống','xuong ong'
  );

-- 4. Target product ids theo tên sản phẩm thật
SET @P_XG_ONG := (SELECT id FROM products WHERE LOWER(TRIM(name)) IN ('xg ống','xương ống','xuong ong') ORDER BY id LIMIT 1);
SET @P_XG_SUON := (SELECT id FROM products WHERE LOWER(TRIM(name)) IN ('xg sườn','xương sườn','xuong suon') ORDER BY id LIMIT 1);
SET @P_XG_NAC := (SELECT id FROM products WHERE LOWER(TRIM(name)) IN ('xg nạc','xương nạc','xuong nac') ORDER BY id LIMIT 1);
SET @P_HUYET := (SELECT id FROM products WHERE LOWER(TRIM(name)) IN ('huyết','huyet') ORDER BY id LIMIT 1);
SET @P_LUOI := (SELECT id FROM products WHERE LOWER(TRIM(name)) IN ('lưỡi','luoi') ORDER BY id LIMIT 1);
SET @P_GAN := (SELECT id FROM products WHERE LOWER(TRIM(name)) IN ('gân','gan') ORDER BY id LIMIT 1);
SET @P_LONG := (SELECT id FROM products WHERE LOWER(TRIM(name)) IN ('lòng','long') ORDER BY id LIMIT 1);
SET @P_NAM := (SELECT id FROM products WHERE LOWER(TRIM(name)) IN ('nạm','nam') ORDER BY id LIMIT 1);
SET @P_NAM_MO := (SELECT id FROM products WHERE LOWER(TRIM(name)) IN ('nầm','nam mo') ORDER BY id LIMIT 1);
SET @P_NAP := (SELECT id FROM products WHERE LOWER(TRIM(name)) IN ('nấp','nap') ORDER BY id LIMIT 1);
SET @P_BON := (SELECT id FROM products WHERE LOWER(TRIM(name)) = 'bon' ORDER BY id LIMIT 1);
SET @P_BUP := (SELECT id FROM products WHERE LOWER(TRIM(name)) IN ('búp','bup') ORDER BY id LIMIT 1);
SET @P_PHI_LE := (SELECT id FROM products WHERE LOWER(TRIM(name)) IN ('phi lê','phi le') ORDER BY id LIMIT 1);
SET @P_GAN_PHO := (SELECT id FROM products WHERE LOWER(TRIM(name)) IN ('gân phô','gân phở','gan pho') ORDER BY id LIMIT 1);
SET @P_GAN_PHOI := (SELECT id FROM products WHERE LOWER(TRIM(name)) IN ('gan phổi','gan phoi') ORDER BY id LIMIT 1);
SET @P_GAU_NAC := (SELECT id FROM products WHERE LOWER(TRIM(name)) IN ('gàu nạc','gầu nạc','gau nac') ORDER BY id LIMIT 1);
SET @P_GAU_MO := (SELECT id FROM products WHERE LOWER(TRIM(name)) IN ('gàu mỡ','gầu mỡ','gau mo') ORDER BY id LIMIT 1);

-- 5. Xoá alias đã map sai product
DELETE FROM product_ocr_aliases WHERE LOWER(TRIM(alias_text)) IN ('xg ong','xuong ong','xương ống') AND product_id <> @P_XG_ONG;
DELETE FROM product_ocr_aliases WHERE LOWER(TRIM(alias_text)) IN ('xg suon','xuong suon','xương sườn') AND product_id <> @P_XG_SUON;
DELETE FROM product_ocr_aliases WHERE LOWER(TRIM(alias_text)) IN ('xg nac','xuong nac','xương nạc') AND product_id <> @P_XG_NAC;
DELETE FROM product_ocr_aliases WHERE LOWER(TRIM(alias_text)) IN ('huyet','huyết') AND product_id <> @P_HUYET;
DELETE FROM product_ocr_aliases WHERE LOWER(TRIM(alias_text)) IN ('luoi','lưỡi') AND product_id <> @P_LUOI;
DELETE FROM product_ocr_aliases WHERE LOWER(TRIM(alias_text)) IN ('gan','gân','gan bo') AND product_id <> @P_GAN;
DELETE FROM product_ocr_aliases WHERE LOWER(TRIM(alias_text)) IN ('long','lòng') AND product_id <> @P_LONG;
DELETE FROM product_ocr_aliases WHERE LOWER(TRIM(alias_text)) IN ('nam','nạm') AND product_id <> @P_NAM;
DELETE FROM product_ocr_aliases WHERE LOWER(TRIM(alias_text)) IN ('nam mo','nầm') AND product_id <> @P_NAM_MO;
DELETE FROM product_ocr_aliases WHERE LOWER(TRIM(alias_text)) IN ('nap','nấp') AND product_id <> @P_NAP;
DELETE FROM product_ocr_aliases WHERE LOWER(TRIM(alias_text)) IN ('bon') AND product_id <> @P_BON;
DELETE FROM product_ocr_aliases WHERE LOWER(TRIM(alias_text)) IN ('bup','búp','bop','bóp') AND product_id <> @P_BUP;
DELETE FROM product_ocr_aliases WHERE LOWER(TRIM(alias_text)) IN ('phi le','phi lê') AND product_id <> @P_PHI_LE;
DELETE FROM product_ocr_aliases WHERE LOWER(TRIM(alias_text)) IN ('gan pho','gân phô','gân phở') AND product_id <> @P_GAN_PHO;
DELETE FROM product_ocr_aliases WHERE LOWER(TRIM(alias_text)) IN ('gan phoi','gan phổi') AND product_id <> @P_GAN_PHOI;
DELETE FROM product_ocr_aliases WHERE LOWER(TRIM(alias_text)) IN ('gau nac','gầu nạc','gàu nạc') AND product_id <> @P_GAU_NAC;
DELETE FROM product_ocr_aliases WHERE LOWER(TRIM(alias_text)) IN ('gau mo','gầu mỡ','gàu mỡ') AND product_id <> @P_GAU_MO;

-- 6. Insert alias chuẩn nếu target có tồn tại
INSERT INTO product_ocr_aliases (customer_id, alias_text, product_id, source, hit_count, created_at, updated_at)
SELECT NULL, v.alias_text, v.product_id, 'VOICE_POS_CLEAN_V49', 1, NOW(), NOW()
FROM (
  SELECT 'xg ong' alias_text, @P_XG_ONG product_id UNION ALL
  SELECT 'xuong ong', @P_XG_ONG UNION ALL
  SELECT 'xương ống', @P_XG_ONG UNION ALL
  SELECT 'nam', @P_NAM UNION ALL
  SELECT 'nạm', @P_NAM UNION ALL
  SELECT 'nam mo', @P_NAM_MO UNION ALL
  SELECT 'nầm', @P_NAM_MO UNION ALL
  SELECT 'nap', @P_NAP UNION ALL
  SELECT 'nấp', @P_NAP UNION ALL
  SELECT 'bon', @P_BON UNION ALL
  SELECT 'bup', @P_BUP UNION ALL
  SELECT 'búp', @P_BUP UNION ALL
  SELECT 'bop', @P_BUP UNION ALL
  SELECT 'bóp', @P_BUP UNION ALL
  SELECT 'gan pho', @P_GAN_PHO UNION ALL
  SELECT 'gân phô', @P_GAN_PHO UNION ALL
  SELECT 'gân phở', @P_GAN_PHO UNION ALL
  SELECT 'phi le', @P_PHI_LE UNION ALL
  SELECT 'phi lê', @P_PHI_LE UNION ALL
  SELECT 'gau nac', @P_GAU_NAC UNION ALL
  SELECT 'gầu nạc', @P_GAU_NAC UNION ALL
  SELECT 'gàu nạc', @P_GAU_NAC UNION ALL
  SELECT 'gau mo', @P_GAU_MO UNION ALL
  SELECT 'gầu mỡ', @P_GAU_MO UNION ALL
  SELECT 'gàu mỡ', @P_GAU_MO
) v
WHERE v.product_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM product_ocr_aliases a
    WHERE a.customer_id IS NULL
      AND LOWER(TRIM(a.alias_text)) = LOWER(TRIM(v.alias_text))
      AND a.product_id = v.product_id
  );

COMMIT;

-- 7. Kiểm tra sau khi chạy: query này phải trả 0 dòng.
SELECT alias_text,
       GROUP_CONCAT(product_id ORDER BY product_id) product_ids,
       COUNT(DISTINCT product_id) cnt
FROM product_ocr_aliases
GROUP BY alias_text
HAVING COUNT(DISTINCT product_id) > 1;
