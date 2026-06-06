const pool = require('./db');

async function runSql(conn, sql) {
  const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
  for (const stmt of statements) await conn.query(stmt);
}

async function hasColumn(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?`,
    [table, column]
  );
  return Number(rows[0].cnt) > 0;
}

async function hasTable(conn, table) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) cnt FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?`,
    [table]
  );
  return Number(rows[0].cnt) > 0;
}

async function safeAddColumn(conn, table, column, ddl) {
  if (!(await hasColumn(conn, table, column))) await conn.query(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

async function ensureSchema() {
  const conn = await pool.getConnection();
  try {
    await runSql(conn, `
CREATE TABLE IF NOT EXISTS customers (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  customer_code VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
  address TEXT,
  price_mode ENUM('COMMON_PRICE','PRIVATE_PRICE') NOT NULL DEFAULT 'COMMON_PRICE',
  debt_limit DECIMAL(15,2) NOT NULL DEFAULT 0,
  payment_term_days INT NOT NULL DEFAULT 0,
  note TEXT,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(100) NOT NULL UNIQUE,
  full_name VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
  email VARCHAR(255),
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('ADMIN','STAFF','CUSTOMER') NOT NULL DEFAULT 'CUSTOMER',
  customer_id BIGINT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS product_categories (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS products (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  category_id BIGINT NULL,
  product_code VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  unit VARCHAR(50) NOT NULL DEFAULT 'kg',
  default_sale_price DECIMAL(15,2) NOT NULL DEFAULT 0,
  default_purchase_price DECIMAL(15,2) NOT NULL DEFAULT 0,
  stock_quantity DECIMAL(15,3) NOT NULL DEFAULT 0,
  low_stock_threshold DECIMAL(15,3) NOT NULL DEFAULT 5,
  note TEXT,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS customer_product_prices (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  customer_id BIGINT NOT NULL,
  product_id BIGINT NOT NULL,
  sale_price DECIMAL(15,2) NOT NULL,
  effective_from DATE NULL,
  effective_to DATE NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_cpp_lookup(customer_id,product_id,is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS suppliers (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  supplier_code VARCHAR(50) NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
  address TEXT,
  note TEXT,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS purchase_lots (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  lot_code VARCHAR(50) NOT NULL UNIQUE,
  lot_name VARCHAR(255) NOT NULL,
  supplier_id BIGINT NULL,
  purchase_date DATE NOT NULL,
  raw_weight DECIMAL(15,3) NOT NULL DEFAULT 0,
  bone_weight DECIMAL(15,3) NOT NULL DEFAULT 0,
  deducted_weight DECIMAL(15,3) NOT NULL DEFAULT 0,
  total_animals INT NOT NULL DEFAULT 0,
  male_animals INT NOT NULL DEFAULT 0,
  female_animals INT NOT NULL DEFAULT 0,
  deduct_mode VARCHAR(30) NOT NULL DEFAULT 'PER_ANIMAL',
  deduct_kg_per_animal DECIMAL(15,3) NOT NULL DEFAULT 0,
  male_price DECIMAL(15,2) NOT NULL DEFAULT 0,
  female_price DECIMAL(15,2) NOT NULL DEFAULT 0,
  male_weight DECIMAL(15,3) NOT NULL DEFAULT 0,
  female_weight DECIMAL(15,3) NOT NULL DEFAULT 0,
  total_weight DECIMAL(15,3) NOT NULL DEFAULT 0,
  purchase_price DECIMAL(15,2) NOT NULL DEFAULT 0,
  total_cost DECIMAL(15,2) NOT NULL DEFAULT 0,
  status ENUM('OPEN','CLOSED','CANCELLED') NOT NULL DEFAULT 'OPEN',
  note TEXT,
  target_debt_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  created_by BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS supplier_payments (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  lot_id BIGINT NOT NULL,
  payment_date DATE NOT NULL,
  amount DECIMAL(15,2) NOT NULL,
  type ENUM('ADVANCE','PAYMENT') NOT NULL DEFAULT 'PAYMENT',
  payment_method VARCHAR(50) NOT NULL DEFAULT 'CASH',
  note TEXT,
  target_debt_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  created_by BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_supplier_payments_lot(lot_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS orders (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_code VARCHAR(50) NOT NULL UNIQUE,
  customer_id BIGINT NOT NULL,
  order_date DATE NOT NULL,
  delivery_date DATE NULL,
  status ENUM('DRAFT','CONFIRMED','DELIVERED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
  payment_status ENUM('UNPAID','PARTIAL','PAID') NOT NULL DEFAULT 'UNPAID',
  total_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  paid_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  debt_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  private_token VARCHAR(100) NULL UNIQUE,
  note TEXT,
  target_debt_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  created_by BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_orders_customer_date(customer_id,order_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS order_items (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_id BIGINT NOT NULL,
  product_id BIGINT NOT NULL,
  product_name VARCHAR(255) NOT NULL,
  unit VARCHAR(50) NOT NULL DEFAULT 'kg',
  quantity DECIMAL(15,3) NOT NULL DEFAULT 0,
  sale_price DECIMAL(15,2) NOT NULL DEFAULT 0,
  total_price DECIMAL(15,2) NOT NULL DEFAULT 0,
  price_type ENUM('COMMON_PRICE','PRIVATE_PRICE','MANUAL_PRICE') NOT NULL DEFAULT 'COMMON_PRICE',
  note TEXT,
  INDEX idx_order_items_order(order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS payments (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  payment_code VARCHAR(50) NULL UNIQUE,
  customer_id BIGINT NOT NULL,
  order_id BIGINT NULL,
  payment_date DATE NOT NULL,
  amount DECIMAL(15,2) NOT NULL,
  payment_method VARCHAR(50) NOT NULL DEFAULT 'CASH',
  note TEXT,
  target_debt_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  created_by BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_payments_customer_date(customer_id,payment_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS debt_transactions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  customer_id BIGINT NOT NULL,
  order_id BIGINT NULL,
  payment_id BIGINT NULL,
  transaction_date DATE NOT NULL,
  type ENUM('SALE','PAYMENT','ADJUSTMENT_INCREASE','ADJUSTMENT_DECREASE') NOT NULL,
  amount DECIMAL(15,2) NOT NULL,
  note TEXT,
  target_debt_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  created_by BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_debt_customer_date(customer_id,transaction_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stock_transactions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT NOT NULL,
  transaction_date DATE NOT NULL,
  type ENUM('IN','OUT','ADJUSTMENT_INCREASE','ADJUSTMENT_DECREASE') NOT NULL,
  quantity DECIMAL(15,3) NOT NULL,
  reference_type ENUM('LOT','SALE','MANUAL') NOT NULL,
  reference_id BIGINT NULL,
  note TEXT,
  target_debt_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  created_by BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_stock_product_date(product_id,transaction_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NULL,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(100),
  entity_id BIGINT NULL,
  note TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


CREATE TABLE IF NOT EXISTS customer_product_catalogs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  customer_id BIGINT NOT NULL,
  product_id BIGINT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_default TINYINT(1) NOT NULL DEFAULT 1,
  note TEXT,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  del_flg TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_customer_product_catalog(customer_id,product_id),
  INDEX idx_customer_catalog_customer(customer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS price_change_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  customer_id BIGINT NOT NULL,
  product_id BIGINT NOT NULL,
  old_price DECIMAL(15,2) NULL,
  new_price DECIMAL(15,2) NOT NULL,
  reason TEXT,
  changed_by BIGINT NULL,
  changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_price_change_customer(customer_id, product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_menu_permissions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  menu_key VARCHAR(100) NOT NULL,
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  updated_by BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_user_menu_permission(user_id,menu_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS role_menu_permissions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  role VARCHAR(50) NOT NULL,
  menu_key VARCHAR(100) NOT NULL,
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  updated_by BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_role_menu_permission(role,menu_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_app_preferences (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  pref_key VARCHAR(100) NOT NULL,
  pref_value JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_user_pref(user_id,pref_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ocr_provider_configs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  module_key VARCHAR(100) NOT NULL,
  provider VARCHAR(50) NOT NULL DEFAULT 'TESSERACT',
  endpoint_url TEXT NULL,
  api_key TEXT NULL,
  project_id VARCHAR(255) NULL,
  processor_id VARCHAR(255) NULL,
  location_id VARCHAR(100) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  note TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_ocr_module_provider(module_key,provider)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ai_learning_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  agent_name VARCHAR(100) NOT NULL,
  module_name VARCHAR(100) NOT NULL,
  action_name VARCHAR(100) NOT NULL,
  input_text LONGTEXT,
  output_text LONGTEXT,
  feedback_text LONGTEXT,
  confidence DECIMAL(5,2) NULL,
  created_by BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ai_learning_agent(agent_name,module_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sponsor_ad_campaigns (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  sponsor_id BIGINT NULL,
  title VARCHAR(255) NOT NULL,
  script_text LONGTEXT,
  video_idea LONGTEXT,
  campaign_date DATE NOT NULL,
  status ENUM('DRAFT','READY','PUBLISHED') NOT NULL DEFAULT 'DRAFT',
  video_url TEXT NULL,
  thumbnail_url TEXT NULL,
  placement ENUM('HOME_HERO','SPONSOR_SECTION','ABOUT_SECTION','FOOTER_AD') NOT NULL DEFAULT 'SPONSOR_SECTION',
  is_public TINYINT(1) NOT NULL DEFAULT 0,
  del_flg TINYINT(1) NOT NULL DEFAULT 0,
  deleted_at DATETIME NULL,
  deleted_reason TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS product_ocr_aliases (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  customer_id BIGINT NULL,
  alias_text VARCHAR(255) NOT NULL,
  product_id BIGINT NOT NULL,
  source VARCHAR(50) NOT NULL DEFAULT 'HANDWRITING',
  hit_count INT NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_ocr_alias_customer(alias_text,customer_id,product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS business_portal_pages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  page_key VARCHAR(100) NOT NULL UNIQUE,
  title VARCHAR(255) NOT NULL,
  content LONGTEXT,
  is_public TINYINT(1) NOT NULL DEFAULT 1,
  updated_by BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sponsors (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  logo_url TEXT,
  website_url TEXT,
  description TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS debt_installment_plans (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  customer_id BIGINT NOT NULL,
  plan_name VARCHAR(255) NOT NULL,
  daily_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  start_date DATE NOT NULL,
  end_date DATE NULL,
  status ENUM('ACTIVE','PAUSED','DONE','CANCELLED') NOT NULL DEFAULT 'ACTIVE',
  note TEXT,
  target_debt_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  created_by BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_debt_installment_customer(customer_id,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS debt_installment_payments (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  plan_id BIGINT NOT NULL,
  customer_id BIGINT NOT NULL,
  payment_date DATE NOT NULL,
  amount DECIMAL(15,2) NOT NULL,
  payment_method VARCHAR(50) NOT NULL DEFAULT 'CASH',
  note TEXT,
  target_debt_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  created_by BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_installment_payment_customer(customer_id,payment_date),
  INDEX idx_installment_payment_plan(plan_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS import_audit_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  source_type VARCHAR(50) NOT NULL,
  raw_text LONGTEXT,
  result_json LONGTEXT,
  warning_count INT NOT NULL DEFAULT 0,
  created_by BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS business_settings (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  setting_key VARCHAR(100) NOT NULL UNIQUE,
  setting_value TEXT,
  updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS delete_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  entity_type VARCHAR(100) NOT NULL,
  entity_id BIGINT NOT NULL,
  entity_code VARCHAR(100),
  entity_name VARCHAR(255),
  reason TEXT,
  deleted_by BIGINT NULL,
  deleted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    for (const table of ['customers','products','product_categories','suppliers','purchase_lots','orders']) {
      if (await hasTable(conn, table)) {
        await safeAddColumn(conn, table, 'del_flg', 'del_flg TINYINT(1) NOT NULL DEFAULT 0');
        await safeAddColumn(conn, table, 'delete_reason', 'delete_reason TEXT NULL');
        await safeAddColumn(conn, table, 'deleted_at', 'deleted_at DATETIME NULL');
        await safeAddColumn(conn, table, 'deleted_by', 'deleted_by BIGINT NULL');
      }
    }

    await safeAddColumn(conn, 'products', 'inventory_mode', "inventory_mode ENUM('STOCK','NON_STOCK','CARCASS_PART') NOT NULL DEFAULT 'STOCK'");
    await safeAddColumn(conn, 'products', 'parent_product_id', 'parent_product_id BIGINT NULL');
    await safeAddColumn(conn, 'products', 'carcass_group', 'carcass_group VARCHAR(100) NULL');
    await safeAddColumn(conn, 'products', 'allow_negative_stock', 'allow_negative_stock TINYINT(1) NOT NULL DEFAULT 0');

    await safeAddColumn(conn, 'purchase_lots', 'raw_weight', 'raw_weight DECIMAL(15,3) NOT NULL DEFAULT 0 AFTER purchase_date');
    await safeAddColumn(conn, 'purchase_lots', 'bone_weight', 'bone_weight DECIMAL(15,3) NOT NULL DEFAULT 0 AFTER raw_weight');
    await safeAddColumn(conn, 'purchase_lots', 'deducted_weight', 'deducted_weight DECIMAL(15,3) NOT NULL DEFAULT 0 AFTER bone_weight');

    await safeAddColumn(conn, 'purchase_lots', 'raw_weight_expr', 'raw_weight_expr TEXT NULL');
    await safeAddColumn(conn, 'purchase_lots', 'bone_weight_expr', 'bone_weight_expr TEXT NULL');
    await safeAddColumn(conn, 'purchase_lots', 'deducted_weight_expr', 'deducted_weight_expr TEXT NULL');
    await safeAddColumn(conn, 'purchase_lots', 'damage_weight', 'damage_weight DECIMAL(15,3) NOT NULL DEFAULT 0');
    await safeAddColumn(conn, 'purchase_lots', 'fat_weight', 'fat_weight DECIMAL(15,3) NOT NULL DEFAULT 0');
    await safeAddColumn(conn, 'purchase_lots', 'other_deduct_weight', 'other_deduct_weight DECIMAL(15,3) NOT NULL DEFAULT 0');
    await safeAddColumn(conn, 'purchase_lots', 'deduct_note', 'deduct_note TEXT NULL');
  await safeAddColumn(conn, 'purchase_lots', 'total_animals', 'total_animals INT NOT NULL DEFAULT 0');
  await safeAddColumn(conn, 'purchase_lots', 'male_animals', 'male_animals INT NOT NULL DEFAULT 0');
  await safeAddColumn(conn, 'purchase_lots', 'female_animals', 'female_animals INT NOT NULL DEFAULT 0');
  await safeAddColumn(conn, 'purchase_lots', 'deduct_mode', "deduct_mode VARCHAR(30) NOT NULL DEFAULT 'PER_ANIMAL'");
  await safeAddColumn(conn, 'purchase_lots', 'deduct_kg_per_animal', 'deduct_kg_per_animal DECIMAL(15,3) NOT NULL DEFAULT 0');
  await safeAddColumn(conn, 'purchase_lots', 'male_price', 'male_price DECIMAL(15,2) NOT NULL DEFAULT 0');
  await safeAddColumn(conn, 'purchase_lots', 'female_price', 'female_price DECIMAL(15,2) NOT NULL DEFAULT 0');
  await safeAddColumn(conn, 'purchase_lots', 'male_weight', 'male_weight DECIMAL(15,3) NOT NULL DEFAULT 0');
  await safeAddColumn(conn, 'purchase_lots', 'female_weight', 'female_weight DECIMAL(15,3) NOT NULL DEFAULT 0');
    if (await hasTable(conn, 'orders')) {
      await safeAddColumn(conn, 'orders', 'calendar_type', "calendar_type ENUM('SOLAR','LUNAR') NOT NULL DEFAULT 'SOLAR'");
      await safeAddColumn(conn, 'orders', 'lunar_date_text', 'lunar_date_text VARCHAR(30) NULL');
    }

    if (await hasTable(conn, 'sponsor_ad_campaigns')) {
      await safeAddColumn(conn, 'sponsor_ad_campaigns', 'del_flg', 'del_flg TINYINT(1) NOT NULL DEFAULT 0');
      await safeAddColumn(conn, 'sponsor_ad_campaigns', 'deleted_at', 'deleted_at DATETIME NULL');
      await safeAddColumn(conn, 'sponsor_ad_campaigns', 'deleted_reason', 'deleted_reason TEXT NULL');
    }

    if (await hasTable(conn, 'sponsor_ad_campaigns')) {
      await safeAddColumn(conn, 'sponsor_ad_campaigns', 'video_url', 'video_url TEXT NULL');
      await safeAddColumn(conn, 'sponsor_ad_campaigns', 'thumbnail_url', 'thumbnail_url TEXT NULL');
      await safeAddColumn(conn, 'sponsor_ad_campaigns', 'placement', "placement ENUM('HOME_HERO','SPONSOR_SECTION','ABOUT_SECTION','FOOTER_AD') NOT NULL DEFAULT 'SPONSOR_SECTION'");
      await safeAddColumn(conn, 'sponsor_ad_campaigns', 'is_public', 'is_public TINYINT(1) NOT NULL DEFAULT 0');
    }

    if (await hasTable(conn, 'customers')) await safeAddColumn(conn, 'customers', 'parent_customer_id', 'parent_customer_id BIGINT NULL');
    if (await hasTable(conn, 'debt_installment_plans')) await safeAddColumn(conn, 'debt_installment_plans', 'target_debt_amount', 'target_debt_amount DECIMAL(15,2) NOT NULL DEFAULT 0');


    await safeAddColumn(conn, 'order_items', 'inventory_mode', "inventory_mode VARCHAR(50) NULL");
    await safeAddColumn(conn, 'order_items', 'stock_checked', 'stock_checked TINYINT(1) NOT NULL DEFAULT 1');

    const [catCount] = await conn.query(`SELECT COUNT(*) cnt FROM product_categories`);
    if (Number(catCount[0].cnt) === 0) {
      await conn.query(`INSERT INTO product_categories(name,sort_order) VALUES ('Thịt bò',1),('Thịt heo',2),('Thịt gà',3),('Chả các loại',4),('Bò xô / pha lóc',5)`);
    }

    const [prodCount] = await conn.query(`SELECT COUNT(*) cnt FROM products`);
    if (Number(prodCount[0].cnt) === 0) {
      await conn.query(`INSERT INTO products(category_id,product_code,name,unit,default_sale_price,stock_quantity,low_stock_threshold,inventory_mode,allow_negative_stock) VALUES
      (1,'BO_PHO','Bò phở','kg',220000,10,5,'STOCK',0),
      (1,'BO_SUON','Sườn bò','kg',190000,10,5,'STOCK',0),
      (1,'BO_BAP','Bắp bò','kg',260000,10,5,'STOCK',0),
      (1,'BO_NAM','Nạm bò','kg',180000,10,5,'STOCK',0),
      (2,'HEO_BA_CHI','Heo ba chỉ','kg',120000,20,5,'STOCK',0),
      (3,'GA_TA','Gà ta','kg',95000,20,5,'STOCK',0),
      (4,'CHA_LUA','Chả lụa','kg',140000,10,5,'STOCK',0),
      (5,'BO_XO','Bò xô nguyên con','kg',200000,0,0,'NON_STOCK',1),
      (5,'BO_DUI','Đùi bò pha lóc','kg',260000,0,0,'CARCASS_PART',1),
      (5,'BO_BUP','Búp bò pha lóc','kg',250000,0,0,'CARCASS_PART',1)`);
    }

    
    // V681 beef carcass safety: existing BO_* rows from older versions may still be STOCK and negative.
    await conn.query(`UPDATE products
      SET inventory_mode='CARCASS_PART', allow_negative_stock=1
      WHERE del_flg=0
        AND (
          product_code LIKE 'BO_%'
          OR name LIKE '%bò%'
          OR name LIKE '%Đùi%'
          OR name LIKE '%đùi%'
          OR name LIKE '%Búp%'
          OR name LIKE '%búp%'
          OR name LIKE '%Nạm%'
          OR name LIKE '%nạm%'
          OR name LIKE '%Sườn%'
          OR name LIKE '%sườn%'
          OR name LIKE '%Thăn%'
          OR name LIKE '%thăn%'
        )
        AND inventory_mode='STOCK'`);

    /* V681 beef carcass safety */

    const [customerCount] = await conn.query(`SELECT COUNT(*) cnt FROM customers`);
    if (Number(customerCount[0].cnt) === 0) {
      await conn.query(`INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,note) VALUES
      ('KH001','Quán A','0900000001','Đà Nẵng','PRIVATE_PRICE',30000000,7,'Khách sỉ giá riêng'),
      ('KH002','Quán B','0900000002','Đà Nẵng','COMMON_PRICE',10000000,0,'Khách dùng giá chung')`);
    }

    const [supplierCount] = await conn.query(`SELECT COUNT(*) cnt FROM suppliers`);
    if (Number(supplierCount[0].cnt) === 0) {
      await conn.query(`INSERT INTO suppliers(supplier_code,name,phone,address) VALUES
      ('NCC001','Lò bò Minh Tâm','0911111111','Đà Nẵng'),
      ('NCC002','Trại gà Hòa Vang','0922222222','Đà Nẵng')`);
    }

    
    // V6.9 customer catalog default: if empty, seed KH001/KH002 with active products.
    const [catalogCount] = await conn.query(`SELECT COUNT(*) cnt FROM customer_product_catalogs`);
    if (Number(catalogCount[0].cnt) === 0) {
      await conn.query(`INSERT IGNORE INTO customer_product_catalogs(customer_id,product_id,sort_order,is_default,is_active,del_flg)
        SELECT c.id, p.id, p.id, 1, 1, 0
        FROM customers c
        JOIN products p ON p.del_flg=0 AND p.is_active=1
        WHERE c.del_flg=0 AND c.is_active=1`);
    }

    
    const [portalCount] = await conn.query(`SELECT COUNT(*) cnt FROM business_portal_pages`);
    if (Number(portalCount[0].cnt) === 0) {
      await conn.query(`INSERT INTO business_portal_pages(page_key,title,content,is_public) VALUES
        ('owner','Thông tin chủ kinh doanh','Giới thiệu chủ kinh doanh, uy tín, kinh nghiệm, cam kết chất lượng.',1),
        ('partners','Thông tin đối tác','Danh sách đối tác, nhà cung cấp, khách hàng tiêu biểu.',1),
        ('about','Giới thiệu hệ thống','MeatBiz hỗ trợ bán hàng, công nợ, nhập lô, bảng giá riêng và in bill.',1)`);
    }
    const [settingCount] = await conn.query(`SELECT COUNT(*) cnt FROM business_settings`);
    if (Number(settingCount[0].cnt) === 0) {
      await conn.query(`INSERT INTO business_settings(setting_key,setting_value) VALUES
        ('shop_name','MEATBIZ FOOD'),
        ('shop_phone',''),
        ('shop_address',''),
        ('bill_footer','Cảm ơn quý khách!'),
        ('print_size','K80'),
        ('currency','VND')`);
    }

    const [userCount] = await conn.query(`SELECT COUNT(*) cnt FROM users`);
    if (Number(userCount[0].cnt) === 0) {
      await conn.query(`INSERT INTO users(username,full_name,phone,password_hash,role,customer_id) VALUES
      ('admin','Chủ cửa hàng','0900000000','admin123','ADMIN',NULL),
      ('kh001','Quán A','0900000001','kh001123','CUSTOMER',1)`);
    }
  } finally {
    conn.release();
  }
}

module.exports = { ensureSchema };
