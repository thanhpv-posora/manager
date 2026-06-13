-- V48 Voice POS product alias cleanup
-- Mục tiêu: 1 alias chỉ map đúng 1 sản phẩm, tránh AI Voice POS nhận nhầm/lặp item.

-- Xoá alias test/dữ liệu demo dễ gây match nhầm
DELETE poa
FROM product_ocr_aliases poa
JOIN products p ON p.id = poa.product_id
WHERE p.name LIKE '%test%'
   OR p.name LIKE '%gần hết%'
   OR p.name LIKE '%còn nhiều%'
   OR p.name LIKE '%carcass%';

-- Xoá duplicate exact same alias/product/customer, giữ dòng id nhỏ nhất
DELETE t1
FROM product_ocr_aliases t1
JOIN product_ocr_aliases t2
  ON t1.id > t2.id
 AND COALESCE(t1.customer_id,0) = COALESCE(t2.customer_id,0)
 AND LOWER(TRIM(t1.alias_text)) = LOWER(TRIM(t2.alias_text))
 AND t1.product_id = t2.product_id;

-- Xoá alias nguy hiểm để insert lại chuẩn
DELETE FROM product_ocr_aliases
WHERE LOWER(TRIM(alias_text)) IN (
 'xg ong','xuong ong','xương ống','xg suon','xuong suon','xương sườn','xg nac','xuong nac','xương nạc',
 'huyet','huyết','luoi','lưỡi','gan','gan bo','gân','long','lòng','nam','nạm','nam mo','nầm','nap','nấp',
 'bon','bup','búp','bop','bóp','dui','đùi','suon','sườn','deo','đeo','lung','lưng','vun','vụn','bu','bù','ria','rìa',
 'gio','giò','xg uc','xuong uc','xương ức','xg duoi','xuong duoi','xương đuôi','gan phoi','gan phổi','gan pho','gân phô','gân phở',
 'mo','mỡ','xg cui gan','xuong cui gan','xương cùi gân','gau nac','gầu nạc','gàu nạc','gau mo','gầu mỡ','gàu mỡ',
 'dim','dìm','ti','tỉ','so','sọ','phi le','phi lê'
);

INSERT INTO product_ocr_aliases (customer_id, alias_text, product_id, source, hit_count, created_at, updated_at)
SELECT NULL, x.alias_text, p.id, 'VOICE_POS_CLEAN_V48', 1, NOW(), NOW()
FROM (
  SELECT 'xg ong' alias_text, 'Xg ống' product_name UNION ALL SELECT 'xuong ong','Xg ống' UNION ALL SELECT 'xương ống','Xg ống'
  UNION ALL SELECT 'xg suon','Xg Sườn' UNION ALL SELECT 'xuong suon','Xg Sườn' UNION ALL SELECT 'xương sườn','Xg Sườn'
  UNION ALL SELECT 'xg nac','Xg Nạc' UNION ALL SELECT 'xuong nac','Xg Nạc' UNION ALL SELECT 'xương nạc','Xg Nạc'
  UNION ALL SELECT 'huyet','Huyết' UNION ALL SELECT 'huyết','Huyết'
  UNION ALL SELECT 'luoi','Lưỡi' UNION ALL SELECT 'lưỡi','Lưỡi'
  UNION ALL SELECT 'gan','Gân' UNION ALL SELECT 'gan bo','Gân' UNION ALL SELECT 'gân','Gân'
  UNION ALL SELECT 'long','Lòng' UNION ALL SELECT 'lòng','Lòng'
  UNION ALL SELECT 'nam','Nạm' UNION ALL SELECT 'nạm','Nạm'
  UNION ALL SELECT 'nam mo','Nầm' UNION ALL SELECT 'nầm','Nầm'
  UNION ALL SELECT 'nap','Nấp' UNION ALL SELECT 'nấp','Nấp'
  UNION ALL SELECT 'bon','Bon'
  UNION ALL SELECT 'bup','Búp' UNION ALL SELECT 'búp','Búp' UNION ALL SELECT 'bop','Búp' UNION ALL SELECT 'bóp','Búp'
  UNION ALL SELECT 'dui','Đùi' UNION ALL SELECT 'đùi','Đùi'
  UNION ALL SELECT 'suon','Sườn' UNION ALL SELECT 'sườn','Sườn'
  UNION ALL SELECT 'deo','Đeo' UNION ALL SELECT 'đeo','Đeo'
  UNION ALL SELECT 'lung','Lưng' UNION ALL SELECT 'lưng','Lưng'
  UNION ALL SELECT 'vun','Vụn' UNION ALL SELECT 'vụn','Vụn'
  UNION ALL SELECT 'bu','Bù' UNION ALL SELECT 'bù','Bù'
  UNION ALL SELECT 'ria','Rìa' UNION ALL SELECT 'rìa','Rìa'
  UNION ALL SELECT 'gio','Giò' UNION ALL SELECT 'giò','Giò'
  UNION ALL SELECT 'xg uc','Xg ức' UNION ALL SELECT 'xuong uc','Xg ức' UNION ALL SELECT 'xương ức','Xg ức'
  UNION ALL SELECT 'xg duoi','Xg đuôi' UNION ALL SELECT 'xuong duoi','Xg đuôi' UNION ALL SELECT 'xương đuôi','Xg đuôi'
  UNION ALL SELECT 'gan phoi','Gan phổi' UNION ALL SELECT 'gan phổi','Gan phổi'
  UNION ALL SELECT 'gan pho','Gân phô' UNION ALL SELECT 'gân phô','Gân phô' UNION ALL SELECT 'gân phở','Gân phô'
  UNION ALL SELECT 'mo','Mỡ' UNION ALL SELECT 'mỡ','Mỡ'
  UNION ALL SELECT 'xg cui gan','Xg cùi gân' UNION ALL SELECT 'xuong cui gan','Xg cùi gân' UNION ALL SELECT 'xương cùi gân','Xg cùi gân'
  UNION ALL SELECT 'gau nac','Gàu nạc' UNION ALL SELECT 'gầu nạc','Gàu nạc' UNION ALL SELECT 'gàu nạc','Gàu nạc'
  UNION ALL SELECT 'gau mo','Gàu mỡ' UNION ALL SELECT 'gầu mỡ','Gàu mỡ' UNION ALL SELECT 'gàu mỡ','Gàu mỡ'
  UNION ALL SELECT 'dim','Dìm' UNION ALL SELECT 'dìm','Dìm'
  UNION ALL SELECT 'ti','Tỉ' UNION ALL SELECT 'tỉ','Tỉ'
  UNION ALL SELECT 'so','Sọ' UNION ALL SELECT 'sọ','Sọ'
  UNION ALL SELECT 'phi le','Phi lê' UNION ALL SELECT 'phi lê','Phi lê'
) x
JOIN products p ON LOWER(TRIM(p.name)) = LOWER(TRIM(x.product_name));

-- Kiểm tra sau khi chạy: query này phải trả 0 dòng
SELECT alias_text, GROUP_CONCAT(product_id ORDER BY product_id) product_ids, COUNT(DISTINCT product_id) cnt
FROM product_ocr_aliases
GROUP BY alias_text
HAVING COUNT(DISTINCT product_id) > 1;
