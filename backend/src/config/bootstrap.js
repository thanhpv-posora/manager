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

async function hasIndex(conn, table, indexName) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) cnt FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=?`,
    [table, indexName]
  );
  return Number(rows[0].cnt) > 0;
}

async function safeDropIndex(conn, table, indexName) {
  if (!(await hasIndex(conn, table, indexName))) return;
  try {
    await conn.query(`ALTER TABLE ${table} DROP INDEX ${indexName}`);
  } catch (e) {
    // 1091 = ER_CANT_DROP_FIELD_OR_KEY: information_schema.STATISTICS can be stale
    // within the same session when many DDL statements fire in rapid succession.
    // If the index is genuinely gone by the time we reach the DROP, treat it as success.
    // All other errors (syntax, privilege, FK-protected index, etc.) are re-thrown.
    if (e.errno === 1091 || e.code === 'ER_CANT_DROP_FIELD_OR_KEY') return;
    throw e;
  }
}

async function safeAddIndex(conn, table, indexName, ddl) {
  if (!(await hasIndex(conn, table, indexName))) await conn.query(`ALTER TABLE ${table} ADD ${ddl}`);
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
  billing_calendar_type VARCHAR(10) NOT NULL DEFAULT 'SOLAR',
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

CREATE TABLE IF NOT EXISTS user_login_otps (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  phone VARCHAR(50) NOT NULL,
  code_hash VARCHAR(255) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_phone_status(phone,status),
  KEY idx_user_status(user_id,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS password_reset_requests (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  identifier VARCHAR(255) NOT NULL,
  channel VARCHAR(30) NOT NULL,
  code_hash VARCHAR(255) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_identifier_status(identifier,status),
  KEY idx_user_status(user_id,status)
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
  billing_calendar_type VARCHAR(10) NOT NULL DEFAULT 'SOLAR',
  male_price DECIMAL(15,2) NOT NULL DEFAULT 0,
  female_price DECIMAL(15,2) NOT NULL DEFAULT 0,
  fragment_price DECIMAL(15,2) NOT NULL DEFAULT 0,
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
  damage_weight DECIMAL(15,3) NOT NULL DEFAULT 0,
  fat_weight DECIMAL(15,3) NOT NULL DEFAULT 0,
  fragment_weight DECIMAL(15,3) NOT NULL DEFAULT 0,
  fragment_price DECIMAL(15,2) NOT NULL DEFAULT 0,
  fragment_cost DECIMAL(15,2) NOT NULL DEFAULT 0,
  other_deduct_weight DECIMAL(15,3) NOT NULL DEFAULT 0,
  total_animals DECIMAL(15,1) NOT NULL DEFAULT 0,
  male_animals DECIMAL(15,1) NOT NULL DEFAULT 0,
  female_animals DECIMAL(15,1) NOT NULL DEFAULT 0,
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
  price_type ENUM('COMMON_PRICE','PRIVATE_PRICE','MANUAL_PRICE','PRICE_BOOK') NOT NULL DEFAULT 'COMMON_PRICE',
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
  cash_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  bank_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  current_bill_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  installment_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
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
  reference_type ENUM('LOT','SALE','MANUAL','RECEIVE_VOUCHER','OPENING_BALANCE') NOT NULL,
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

CREATE TABLE IF NOT EXISTS debt_monthly_installments (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  customer_id BIGINT NOT NULL,
  installment_day INT NOT NULL DEFAULT 1,
  installment_month INT NOT NULL,
  installment_year INT NOT NULL,
  calendar_type VARCHAR(20) NOT NULL DEFAULT 'SOLAR',
  config_date DATE NULL,
  lunar_date_text VARCHAR(50) NULL,
  installment_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  status VARCHAR(30) DEFAULT 'ACTIVE',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_customer_apply_day(customer_id,installment_day,installment_month,installment_year,calendar_type),
  INDEX idx_debt_monthly_lookup(customer_id,installment_month,installment_year,calendar_type,status),
  INDEX idx_debt_monthly_effective(customer_id,installment_month,installment_year,calendar_type,installment_day,status)
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



CREATE TABLE IF NOT EXISTS ai_chat_sessions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id VARCHAR(100) NOT NULL,
  customer_id BIGINT NULL,
  draft_json LONGTEXT NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'DRAFT',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_ai_chat_session_status(session_id,status,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS product_supplier_links (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT NOT NULL,
  supplier_id BIGINT NOT NULL,
  purchase_price DECIMAL(15,2) NOT NULL DEFAULT 0,
  min_order_qty DECIMAL(15,3) NOT NULL DEFAULT 0,
  order_multiple_qty DECIMAL(15,3) NOT NULL DEFAULT 0,
  lead_time_days INT NOT NULL DEFAULT 0,
  is_default TINYINT(1) NOT NULL DEFAULT 1,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  note TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_product_supplier(product_id,supplier_id),
  INDEX idx_product_supplier_default(product_id,is_default,is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS purchase_orders (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_code VARCHAR(50) NOT NULL UNIQUE,
  supplier_id BIGINT NOT NULL,
  order_date DATE NOT NULL,
  expected_date DATE NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'DRAFT',
  source VARCHAR(50) NOT NULL DEFAULT 'MANUAL',
  total_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  note TEXT NULL,
  created_by BIGINT NULL,
  del_flg TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_purchase_orders_supplier_date(supplier_id,order_date,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  purchase_order_id BIGINT NOT NULL,
  product_id BIGINT NOT NULL,
  product_name VARCHAR(255) NOT NULL,
  unit VARCHAR(50) NOT NULL DEFAULT 'kg',
  quantity DECIMAL(15,3) NOT NULL DEFAULT 0,
  purchase_price DECIMAL(15,2) NOT NULL DEFAULT 0,
  total_price DECIMAL(15,2) NOT NULL DEFAULT 0,
  received_quantity DECIMAL(15,3) NOT NULL DEFAULT 0,
  note TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_purchase_order_items_order(purchase_order_id),
  INDEX idx_purchase_order_items_product(product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS inventory_receives (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  receive_code VARCHAR(50) NOT NULL UNIQUE,
  purchase_order_id BIGINT NOT NULL,
  receive_date DATE NOT NULL,
  supplier_id BIGINT NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
  note TEXT NULL,
  created_by BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_inventory_receives_po(purchase_order_id),
  INDEX idx_inventory_receives_supplier_date(supplier_id, receive_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS inventory_receive_items (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  receive_id BIGINT NOT NULL,
  product_id BIGINT NOT NULL,
  received_quantity DECIMAL(15,3) NOT NULL DEFAULT 0,
  purchase_price DECIMAL(15,2) NOT NULL DEFAULT 0,
  INDEX idx_inventory_receive_items_receive(receive_id),
  INDEX idx_inventory_receive_items_product(product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- S4.1-A: Warehouse — minimal, future-proof master data. Single default row today;
-- full warehouse CRUD/multi-location support is out of S4.1 scope.
CREATE TABLE IF NOT EXISTS warehouses (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP
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

CREATE TABLE IF NOT EXISTS units (
  id         BIGINT       AUTO_INCREMENT PRIMARY KEY,
  code       VARCHAR(30)  NOT NULL UNIQUE,
  name       VARCHAR(100) NOT NULL,
  is_active  TINYINT(1)   NOT NULL DEFAULT 1,
  sort_order INT          NOT NULL DEFAULT 0,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS supplier_purchase_options (
  id                      BIGINT        AUTO_INCREMENT PRIMARY KEY,
  supplier_id             BIGINT        NOT NULL,
  product_id              BIGINT        NOT NULL,
  unit_id                 BIGINT        NOT NULL,
  default_conversion_qty  DECIMAL(15,4) NOT NULL DEFAULT 1.0000,
  requires_actual_weight  TINYINT(1)    NOT NULL DEFAULT 0,
  display_order           INT           NOT NULL DEFAULT 0,
  is_active               TINYINT(1)    NOT NULL DEFAULT 1,
  created_at              DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              DATETIME      NULL ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_spo_supplier_product(supplier_id, product_id),
  INDEX idx_spo_supplier(supplier_id),
  INDEX idx_spo_product(product_id),
  INDEX idx_spo_unit(unit_id),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  FOREIGN KEY (product_id)  REFERENCES products(id),
  FOREIGN KEY (unit_id)     REFERENCES units(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS purchase_lot_items (
  id                          BIGINT        AUTO_INCREMENT PRIMARY KEY,
  lot_id                      BIGINT        NOT NULL,
  product_id                  BIGINT        NOT NULL,
  supplier_purchase_option_id BIGINT        NULL,
  purchase_qty                DECIMAL(15,3) NOT NULL,
  expected_conversion_qty     DECIMAL(15,4) NOT NULL,
  expected_stock_qty_kg       DECIMAL(15,3) NOT NULL,
  actual_stock_qty_kg         DECIMAL(15,3) NULL,
  inventory_stock_qty_kg      DECIMAL(15,3) NOT NULL,
  purchase_unit_price         DECIMAL(15,2) NOT NULL,
  total_cost                  DECIMAL(15,2) NOT NULL,
  cost_per_kg                 DECIMAL(15,4) NOT NULL,
  note                        TEXT          NULL,
  created_at                  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_lot(lot_id),
  INDEX idx_product(product_id),
  INDEX idx_supplier_purchase_option(supplier_purchase_option_id),
  FOREIGN KEY (lot_id)                      REFERENCES purchase_lots(id),
  FOREIGN KEY (product_id)                  REFERENCES products(id),
  FOREIGN KEY (supplier_purchase_option_id) REFERENCES supplier_purchase_options(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS supplier_partner_map (
  id          BIGINT   AUTO_INCREMENT PRIMARY KEY,
  supplier_id BIGINT   NOT NULL,
  partner_id  BIGINT   NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_spm_supplier (supplier_id),
  INDEX      idx_spm_partner (partner_id),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  FOREIGN KEY (partner_id)  REFERENCES customers(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS retail_daily_summary (
  id                BIGINT       AUTO_INCREMENT PRIMARY KEY,
  business_date     DATE         NOT NULL,
  calendar_type     VARCHAR(10)  NOT NULL DEFAULT 'SOLAR',
  lunar_date_text   VARCHAR(50)  NULL,
  amount            DECIMAL(15,2) NOT NULL DEFAULT 0,
  note              TEXT         NULL,
  status            VARCHAR(20)  NOT NULL DEFAULT 'OPEN',
  created_by        BIGINT       NULL,
  updated_by        BIGINT       NULL,
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_retail_date_cal (business_date, calendar_type),
  INDEX idx_retail_date (business_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS app_menus (
  id                 BIGINT       AUTO_INCREMENT PRIMARY KEY,
  menu_key           VARCHAR(100) NOT NULL,
  title              VARCHAR(200) NOT NULL,
  subtitle           TEXT         NULL,
  route              VARCHAR(200) NULL,
  page_component     VARCHAR(200) NULL,
  icon_key           VARCHAR(100) NOT NULL DEFAULT 'Circle',
  group_key          VARCHAR(100) NOT NULL DEFAULT 'other',
  parent_menu_key    VARCHAR(100) NULL,
  menu_type          VARCHAR(50)  NOT NULL DEFAULT 'page',
  sort_order         INT          NOT NULL DEFAULT 99,
  is_system          TINYINT(1)   NOT NULL DEFAULT 0,
  is_active          TINYINT(1)   NOT NULL DEFAULT 1,
  visible_in_sidebar TINYINT(1)   NOT NULL DEFAULT 1,
  created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME     NULL     ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_app_menus_key (menu_key),
  INDEX idx_app_menus_sort (group_key, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_menu_preferences (
  id         BIGINT    AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT    NOT NULL,
  menu_id    BIGINT    NOT NULL,
  sort_order INT       NOT NULL DEFAULT 99,
  is_pinned  TINYINT(1) NOT NULL DEFAULT 0,
  is_hidden  TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME  NULL     ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ump_user_menu (user_id, menu_id),
  INDEX idx_ump_user (user_id),
  FOREIGN KEY (menu_id) REFERENCES app_menus(id) ON DELETE CASCADE
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

    // STAB-009: Auth schema columns moved from auth.js ensureAuthSchema to bootstrap.
    // Previously created per-request via INFORMATION_SCHEMA checks on every login/OTP call.
    await safeAddColumn(conn, 'users', 'failed_login_count', 'failed_login_count INT NOT NULL DEFAULT 0');
    await safeAddColumn(conn, 'users', 'locked_until', 'locked_until DATETIME NULL');
    await safeAddColumn(conn, 'users', 'last_failed_login', 'last_failed_login DATETIME NULL');

    await safeAddColumn(conn, 'products', 'inventory_mode', "inventory_mode ENUM('NON_STOCK','TRACK_STOCK','CARCASS_PART') NOT NULL DEFAULT 'NON_STOCK'");
    await safeAddColumn(conn, 'products', 'parent_product_id', 'parent_product_id BIGINT NULL');
    await safeAddColumn(conn, 'products', 'carcass_group', 'carcass_group VARCHAR(100) NULL');
    await safeAddColumn(conn, 'products', 'allow_negative_stock', 'allow_negative_stock TINYINT(1) NOT NULL DEFAULT 0');
    await safeAddColumn(conn, 'products', 'default_supplier_id', 'default_supplier_id BIGINT NULL');
    await safeAddColumn(conn, 'suppliers', 'billing_calendar_type', "billing_calendar_type VARCHAR(10) NOT NULL DEFAULT 'SOLAR'");
    await safeAddColumn(conn, 'suppliers', 'male_price', 'male_price DECIMAL(15,2) NOT NULL DEFAULT 0');
    await safeAddColumn(conn, 'suppliers', 'female_price', 'female_price DECIMAL(15,2) NOT NULL DEFAULT 0');
    await safeAddColumn(conn, 'suppliers', 'fragment_price', 'fragment_price DECIMAL(15,2) NOT NULL DEFAULT 0');

    await safeAddColumn(conn, 'purchase_orders', 'source', "source VARCHAR(50) NOT NULL DEFAULT 'MANUAL'");
    await safeAddColumn(conn, 'purchase_orders', 'del_flg', 'del_flg TINYINT(1) NOT NULL DEFAULT 0');
    await safeAddColumn(conn, 'purchase_orders', 'reference_no', 'reference_no VARCHAR(100) NULL');

    // STAB-001A: Purchase domain column naming — schema-aware migration.
    // Databases may have order_code/order_date (old), purchase_code/purchase_date (new), both, or neither.
    // No SQL may reference a column that has not been verified to exist first.
    {
      const hasOrderCode    = await hasColumn(conn, 'purchase_orders', 'order_code');
      const hasPurchaseCode = await hasColumn(conn, 'purchase_orders', 'purchase_code');
      if (hasOrderCode) {
        // Case A (old DB) or Case C (partially migrated): src exists — ensure dst and backfill.
        await safeAddColumn(conn, 'purchase_orders', 'purchase_code',
          'purchase_code VARCHAR(50) NULL');
        await conn.query(
          `UPDATE purchase_orders SET purchase_code = order_code WHERE purchase_code IS NULL AND order_code IS NOT NULL`
        );
      } else if (!hasPurchaseCode) {
        // Case D: neither column exists — log and continue; do not crash startup.
        console.warn('[STAB-001A] purchase_orders: neither order_code nor purchase_code found — skipping purchase_code migration');
      }
      // Case B (purchase_code exists, order_code missing): already correct, nothing to do.
      if (hasOrderCode || hasPurchaseCode) {
        await safeAddIndex(conn, 'purchase_orders', 'uq_purchase_orders_purchase_code',
          'UNIQUE INDEX uq_purchase_orders_purchase_code (purchase_code)');
      }
    }
    {
      const hasOrderDate    = await hasColumn(conn, 'purchase_orders', 'order_date');
      const hasPurchaseDate = await hasColumn(conn, 'purchase_orders', 'purchase_date');
      if (hasOrderDate) {
        // Case A or C: src exists — ensure dst and backfill.
        await safeAddColumn(conn, 'purchase_orders', 'purchase_date',
          'purchase_date DATE NULL');
        await conn.query(
          `UPDATE purchase_orders SET purchase_date = order_date WHERE purchase_date IS NULL AND order_date IS NOT NULL`
        );
      } else if (!hasPurchaseDate) {
        // Case D: neither column exists.
        console.warn('[STAB-001A] purchase_orders: neither order_date nor purchase_date found — skipping purchase_date migration');
      }
      // Case B: purchase_date exists, order_date missing — already correct.
      if (hasOrderDate || hasPurchaseDate) {
        await safeAddIndex(conn, 'purchase_orders', 'idx_purchase_orders_purchase_date',
          'INDEX idx_purchase_orders_purchase_date (purchase_date)');
      }
    }

    await safeAddColumn(conn, 'purchase_order_items', 'received_quantity', 'received_quantity DECIMAL(15,3) NOT NULL DEFAULT 0');

    // S4-002B: Domain B — Inventory Purchase workflow (purchase_orders + purchase_order_items).
    // purchase_order_items stores snapshot values captured at order creation time.
    // PurchaseEngine must use purchase_order_items snapshot fields only.
    // Do not read supplier_purchase_options or units for calculation after order creation.
    await safeAddColumn(conn, 'purchase_order_items', 'supplier_purchase_option_id', 'supplier_purchase_option_id BIGINT NULL');
    await safeAddColumn(conn, 'purchase_order_items', 'expected_conversion_qty', 'expected_conversion_qty DECIMAL(15,4) NOT NULL DEFAULT 1.0000');
    await safeAddColumn(conn, 'purchase_order_items', 'expected_stock_qty', 'expected_stock_qty DECIMAL(15,3) NOT NULL DEFAULT 0');
    await safeAddColumn(conn, 'purchase_order_items', 'actual_stock_qty', 'actual_stock_qty DECIMAL(15,3) NULL');
    await safeAddColumn(conn, 'purchase_order_items', 'inventory_stock_qty', 'inventory_stock_qty DECIMAL(15,3) NOT NULL DEFAULT 0');
    await safeAddColumn(conn, 'purchase_order_items', 'cost_per_stock_unit', 'cost_per_stock_unit DECIMAL(15,4) NOT NULL DEFAULT 0');
    await safeAddColumn(conn, 'purchase_order_items', 'inventory_status', "inventory_status VARCHAR(20) NOT NULL DEFAULT 'PENDING'");
    await safeAddColumn(conn, 'purchase_order_items', 'requires_actual_weight', 'requires_actual_weight TINYINT(1) NOT NULL DEFAULT 0');
    await safeAddIndex(conn, 'purchase_order_items', 'idx_poi_spo', 'INDEX idx_poi_spo(supplier_purchase_option_id)');

    await safeAddColumn(conn, 'purchase_lots', 'raw_weight', 'raw_weight DECIMAL(15,3) NOT NULL DEFAULT 0 AFTER purchase_date');
    await safeAddColumn(conn, 'purchase_lots', 'bone_weight', 'bone_weight DECIMAL(15,3) NOT NULL DEFAULT 0 AFTER raw_weight');
    await safeAddColumn(conn, 'purchase_lots', 'deducted_weight', 'deducted_weight DECIMAL(15,3) NOT NULL DEFAULT 0 AFTER bone_weight');
    await safeAddColumn(conn, 'purchase_lots', 'calendar_type', "ENUM('SOLAR','LUNAR') NOT NULL DEFAULT 'SOLAR' AFTER purchase_date");
    await safeAddColumn(conn, 'purchase_lots', 'lunar_date_text', 'VARCHAR(50) NULL AFTER calendar_type');

    await safeAddColumn(conn, 'purchase_lots', 'raw_weight_expr', 'raw_weight_expr TEXT NULL');
    await safeAddColumn(conn, 'purchase_lots', 'bone_weight_expr', 'bone_weight_expr TEXT NULL');
    await safeAddColumn(conn, 'purchase_lots', 'deducted_weight_expr', 'deducted_weight_expr TEXT NULL');
    await safeAddColumn(conn, 'purchase_lots', 'damage_weight', 'damage_weight DECIMAL(15,3) NOT NULL DEFAULT 0');
    await safeAddColumn(conn, 'purchase_lots', 'fat_weight', 'fat_weight DECIMAL(15,3) NOT NULL DEFAULT 0');
    await safeAddColumn(conn, 'purchase_lots', 'fragment_weight', 'fragment_weight DECIMAL(15,3) NOT NULL DEFAULT 0');
    await safeAddColumn(conn, 'purchase_lots', 'fragment_price', 'fragment_price DECIMAL(15,2) NOT NULL DEFAULT 0');
    await safeAddColumn(conn, 'purchase_lots', 'fragment_cost', 'fragment_cost DECIMAL(15,2) NOT NULL DEFAULT 0');
    await safeAddColumn(conn, 'purchase_lots', 'other_deduct_weight', 'other_deduct_weight DECIMAL(15,3) NOT NULL DEFAULT 0');
    await safeAddColumn(conn, 'purchase_lots', 'deduct_note', 'deduct_note TEXT NULL');
  await safeAddColumn(conn, 'purchase_lots', 'total_animals', 'total_animals DECIMAL(15,1) NOT NULL DEFAULT 0');
  await safeAddColumn(conn, 'purchase_lots', 'male_animals', 'male_animals DECIMAL(15,1) NOT NULL DEFAULT 0');
  await safeAddColumn(conn, 'purchase_lots', 'female_animals', 'female_animals DECIMAL(15,1) NOT NULL DEFAULT 0');
  try{ await conn.query("ALTER TABLE purchase_lots MODIFY total_animals DECIMAL(15,1) NOT NULL DEFAULT 0, MODIFY male_animals DECIMAL(15,1) NOT NULL DEFAULT 0, MODIFY female_animals DECIMAL(15,1) NOT NULL DEFAULT 0"); }catch(e){}
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

    if (await hasTable(conn, 'customers')) {
      await safeAddColumn(conn, 'customers', 'billing_calendar_type', "billing_calendar_type VARCHAR(10) NOT NULL DEFAULT 'SOLAR'");
      await safeAddColumn(conn, 'customers', 'parent_customer_id', 'parent_customer_id BIGINT NULL');
    }
    if (await hasTable(conn, 'debt_installment_plans')) await safeAddColumn(conn, 'debt_installment_plans', 'target_debt_amount', 'target_debt_amount DECIMAL(15,2) NOT NULL DEFAULT 0');

    if (await hasTable(conn, 'debt_monthly_installments')) {
      await safeAddColumn(conn, 'debt_monthly_installments', 'installment_day', 'installment_day INT NOT NULL DEFAULT 1 AFTER customer_id');
      await safeAddColumn(conn, 'debt_monthly_installments', 'calendar_type', "calendar_type VARCHAR(20) NOT NULL DEFAULT 'SOLAR' AFTER installment_year");
      await safeAddColumn(conn, 'debt_monthly_installments', 'config_date', 'config_date DATE NULL AFTER calendar_type');
      await safeAddColumn(conn, 'debt_monthly_installments', 'lunar_date_text', 'lunar_date_text VARCHAR(50) NULL AFTER config_date');
      await safeAddColumn(conn, 'debt_monthly_installments', 'updated_at', 'updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP AFTER created_at');
      await safeDropIndex(conn, 'debt_monthly_installments', 'uq_customer_month_year');
      await safeDropIndex(conn, 'debt_monthly_installments', 'uq_customer_apply_day');
      await safeDropIndex(conn, 'debt_monthly_installments', 'idx_debt_monthly_lookup');
      await safeDropIndex(conn, 'debt_monthly_installments', 'idx_debt_monthly_day');
      await safeDropIndex(conn, 'debt_monthly_installments', 'idx_debt_monthly_effective');
      await safeAddIndex(conn, 'debt_monthly_installments', 'uq_customer_apply_day', 'UNIQUE KEY uq_customer_apply_day(customer_id,installment_day,installment_month,installment_year,calendar_type)');
      await safeAddIndex(conn, 'debt_monthly_installments', 'idx_debt_monthly_lookup', 'INDEX idx_debt_monthly_lookup(customer_id,installment_month,installment_year,calendar_type,status)');
      await safeAddIndex(conn, 'debt_monthly_installments', 'idx_debt_monthly_effective', 'INDEX idx_debt_monthly_effective(customer_id,installment_month,installment_year,calendar_type,installment_day,status)');
    }

    await safeAddColumn(conn, 'order_items', 'inventory_mode', "inventory_mode VARCHAR(50) NULL");
    await safeAddColumn(conn, 'order_items', 'stock_checked', 'stock_checked TINYINT(1) NOT NULL DEFAULT 1');

    // INV-002: inventory_receives.status was missing from initial CREATE TABLE (INV-001)
    await safeAddColumn(conn, 'inventory_receives', 'status', "status VARCHAR(30) NOT NULL DEFAULT 'PENDING'");

    // S4.1-A: Receive Header — supplier document reference, warehouse selection,
    // and received_by/received_at distinct from created_by/created_at (who posted
    // the voucher to stock vs who drafted it — see docs/00-project sprint S4.1 report).
    await safeAddColumn(conn, 'inventory_receives', 'supplier_document_no', 'supplier_document_no VARCHAR(255) NULL');
    await safeAddColumn(conn, 'inventory_receives', 'warehouse_id', 'warehouse_id BIGINT NULL');
    await safeAddColumn(conn, 'inventory_receives', 'received_by', 'received_by BIGINT NULL');
    await safeAddColumn(conn, 'inventory_receives', 'received_at', 'received_at DATETIME NULL');
    await safeAddIndex(conn, 'inventory_receives', 'idx_inventory_receives_warehouse', 'INDEX idx_inventory_receives_warehouse(warehouse_id)');
    // S4.1-A CEO review: widen supplier_document_no from VARCHAR(100) → VARCHAR(255).
    // safeAddColumn only fires on first creation, so DBs that already have the
    // VARCHAR(100) column need an explicit widen (same pattern as purchase_lots below).
    try { await conn.query(`ALTER TABLE inventory_receives MODIFY supplier_document_no VARCHAR(255) NULL`); } catch (e) {}

    // S4.1-A CEO review: future-proof warehouse type. Valid values: NORMAL, FREEZER,
    // TRANSIT. VARCHAR (not ENUM) to match the rest of this file's status-column
    // convention — no UI/CRUD to set it yet, lookup-only this sprint.
    await safeAddColumn(conn, 'warehouses', 'type', "type VARCHAR(20) NOT NULL DEFAULT 'NORMAL'");

    // S4.1-A: seed one default warehouse so existing/new receive vouchers always
    // have a warehouse to fall back to until multi-warehouse UI exists.
    await conn.query(
      `INSERT IGNORE INTO warehouses (code, name, type, is_default, is_active) VALUES ('MAIN', 'Kho chính', 'NORMAL', 1, 1)`
    );

    // S4.1-B: Receive Detail — replace the ambiguous inventory_receive_items.received_quantity
    // with an explicit Ordered / Expected / Actual quantity model (see sprint S4.1 report):
    //   ordered_qty         — snapshot of purchase_order_items.quantity (supplier purchase unit, e.g. crate)
    //   expected_stock_qty  — snapshot of purchase_order_items.expected_stock_qty (ordered × conversion, stock unit/kg)
    //   actual_stock_qty    — physically weighed/counted amount entered at receive time (stock unit/kg);
    //                         this is what gets posted to inventory (wired in S4.1-C), never expected_stock_qty.
    // purchase_order_item_id gives a direct FK to the specific PO line, resolving the
    // ambiguity of the old product_id-only join when a product appears on multiple PO lines.
    await safeAddColumn(conn, 'inventory_receive_items', 'purchase_order_item_id', 'purchase_order_item_id BIGINT NULL');
    await safeAddColumn(conn, 'inventory_receive_items', 'ordered_qty', 'ordered_qty DECIMAL(15,3) NOT NULL DEFAULT 0');
    await safeAddColumn(conn, 'inventory_receive_items', 'expected_stock_qty', 'expected_stock_qty DECIMAL(15,3) NOT NULL DEFAULT 0');
    await safeAddColumn(conn, 'inventory_receive_items', 'actual_stock_qty', 'actual_stock_qty DECIMAL(15,3) NOT NULL DEFAULT 0');
    await safeAddIndex(conn, 'inventory_receive_items', 'idx_iri_poi', 'INDEX idx_iri_poi(purchase_order_item_id)');

    // S4.1-B: migrate off received_quantity — feasible, no production data yet.
    // Legacy rows predate the ordered/expected snapshot linkage, so only actual_stock_qty
    // can be backfilled (it inherits whatever was actually posted to stock under the old
    // model); ordered_qty/expected_stock_qty stay 0 for those pre-existing rows.
    if (await hasColumn(conn, 'inventory_receive_items', 'received_quantity')) {
      await conn.query(
        `UPDATE inventory_receive_items SET actual_stock_qty = received_quantity WHERE actual_stock_qty = 0`
      );
      await conn.query(`ALTER TABLE inventory_receive_items DROP COLUMN received_quantity`);
    }

    // S4.1-B CEO review: purchase_order_items.received_quantity is purchase-unit
    // basis (paired with `quantity`) and must never be reused to accumulate a
    // stock-unit (kg) total — that was the unit-mixing bug flagged in review.
    // received_stock_qty is the explicit, kg-basis home for that concept.
    // S4.2-A: now the authoritative, maintained accumulator — incremented under
    // a row lock in InventoryReceiveService.receive() after each movement posts.
    // Remaining quantity = expected_stock_qty - received_stock_qty.
    await safeAddColumn(conn, 'purchase_order_items', 'received_stock_qty', 'received_stock_qty DECIMAL(15,3) NOT NULL DEFAULT 0');

    // S4.2-A CTO review: backfill received_stock_qty for receive history that
    // predates this sprint (posted before the accumulator existed, via the old
    // S4.1-B ledger-sum derivation). Idempotent by construction: only rows still
    // at the column's default 0 are touched, so re-running on every startup
    // never double-counts a row the app has since maintained for real (including
    // a genuinely-zero row — the JOIN simply won't match it either way).
    await conn.query(
      `UPDATE purchase_order_items poi
       JOIN (
         SELECT iri.purchase_order_item_id, SUM(iri.actual_stock_qty) qty
         FROM inventory_receive_items iri
         JOIN inventory_receives ir ON ir.id = iri.receive_id
         WHERE iri.purchase_order_item_id IS NOT NULL
           AND ir.status <> 'CANCELLED'
         GROUP BY iri.purchase_order_item_id
       ) x ON x.purchase_order_item_id = poi.id
       SET poi.received_stock_qty = x.qty
       WHERE poi.received_stock_qty = 0`
    );

    // S4.2-A: Short Close — schema only this sprint. purchase_orders.status
    // transitions (PARTIAL_RECEIVED/RECEIVED/SHORT_CLOSED) and the Short Close
    // route/logic itself are S4.2-B/S4.2-C.
    await safeAddColumn(conn, 'purchase_orders', 'short_close_reason', 'short_close_reason TEXT NULL');
    await safeAddColumn(conn, 'purchase_orders', 'short_closed_by', 'short_closed_by BIGINT NULL');
    await safeAddColumn(conn, 'purchase_orders', 'short_closed_at', 'short_closed_at DATETIME NULL');

    // S4.1-C: Inventory Movement Wiring — stock_transactions now records which
    // warehouse a movement affected. Nullable: only the Receive Voucher path
    // (InventoryReceiveService.receive(), passing inventory_receives.warehouse_id)
    // populates this in S4.1-C; other IN/OUT/ADJUSTMENT callers (initial product
    // stock, sales, manual adjustments) don't participate in warehouse tracking
    // yet and are left untouched — out of this sprint's scope.
    await safeAddColumn(conn, 'stock_transactions', 'warehouse_id', 'warehouse_id BIGINT NULL');
    await safeAddIndex(conn, 'stock_transactions', 'idx_stock_transactions_warehouse', 'INDEX idx_stock_transactions_warehouse(warehouse_id)');

    // INV-002: add RECEIVE_VOUCHER to stock_transactions.reference_type ENUM
    {
      const [[rtInfo]] = await conn.query(
        `SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stock_transactions' AND COLUMN_NAME = 'reference_type'`
      );
      if (rtInfo && !String(rtInfo.COLUMN_TYPE).includes('RECEIVE_VOUCHER')) {
        await conn.query(
          `ALTER TABLE stock_transactions MODIFY reference_type ENUM('LOT','SALE','MANUAL','RECEIVE_VOUCHER') NOT NULL`
        );
      }
    }

    // INV-005: add OPENING_BALANCE to stock_transactions.reference_type ENUM
    {
      const [[rtInfo]] = await conn.query(
        `SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stock_transactions' AND COLUMN_NAME = 'reference_type'`
      );
      if (rtInfo && !String(rtInfo.COLUMN_TYPE).includes('OPENING_BALANCE')) {
        await conn.query(
          `ALTER TABLE stock_transactions MODIFY reference_type ENUM('LOT','SALE','MANUAL','RECEIVE_VOUCHER','OPENING_BALANCE') NOT NULL`
        );
      }
    }

    // S5.1-C: Inventory Movement Idempotency IN — scoped dedup key so one
    // inventory_receives.id can post at most one IN movement per product_id.
    // Generated column evaluates to NULL for every row except
    // reference_type='RECEIVE_VOUCHER' AND type='IN' (and NULL whenever
    // reference_id is NULL); MySQL treats each NULL as distinct in a UNIQUE
    // index, so SALE/ADJUSTMENT/LOT/MANUAL/OPENING_BALANCE rows — which may
    // legitimately repeat the same (product_id, reference_id) tuple — are
    // completely unaffected. See docs/MEATBIZ_INVENTORY_BACKLOG.md S5.1-C.
    await safeAddColumn(
      conn,
      'stock_transactions',
      'receive_dedup_key',
      `receive_dedup_key VARCHAR(64) GENERATED ALWAYS AS
         (CASE WHEN reference_type = 'RECEIVE_VOUCHER' AND type = 'IN'
               THEN CONCAT(product_id, ':', reference_id) ELSE NULL END) STORED`
    );
    await safeAddIndex(
      conn,
      'stock_transactions',
      'uq_stock_transactions_receive_dedup',
      'UNIQUE KEY uq_stock_transactions_receive_dedup(receive_dedup_key)'
    );

    // S5.2-C: affect_stock — write-time truth for whether this specific
    // movement actually changed products.stock_quantity. CEO review rejected
    // deriving this at read time (StockLedgerAgent) from current product
    // mode/flags/note text, since an audit ledger must reflect the decision
    // made at movement creation time, not whatever the product looks like
    // today. InventoryMovementService now sets this explicitly on every
    // INSERT (see postIn/postOut/postAdjustmentIncrease/postAdjustmentDecrease/
    // postOpening) — this column is the only source of truth going forward.
    //
    // Backfill runs exactly once, only on the migration that introduces the
    // column (guarded by hadAffectStockColumn) — never on every boot, so a
    // later manual correction to a historical row's affect_stock is never
    // silently re-flipped by this heuristic. It is best-effort for
    // pre-migration history only:
    //   - note LIKE '%SKIP_STOCK_CHECK%' catches OUT rows postOut() already
    //     stamped at write time when it skipped the balance UPDATE.
    //   - IN rows have no equivalent write-time marker (postIn never
    //     annotated the note), so those are backfilled from the product's
    //     CURRENT inventory_mode — a best-effort approximation that cannot
    //     see a mode change that happened after the row was posted.
    //   - OPENING_BALANCE is excluded from the IN backfill because
    //     postOpening() always updates the balance unconditionally.
    const hadAffectStockColumn = await hasColumn(conn, 'stock_transactions', 'affect_stock');
    await safeAddColumn(conn, 'stock_transactions', 'affect_stock', 'affect_stock TINYINT(1) NOT NULL DEFAULT 1');
    if (!hadAffectStockColumn) {
      await conn.query(`UPDATE stock_transactions SET affect_stock = 0 WHERE note LIKE '%SKIP_STOCK_CHECK%'`);
      await conn.query(
        `UPDATE stock_transactions st
         JOIN products p ON p.id = st.product_id
         SET st.affect_stock = 0
         WHERE st.type = 'IN'
           AND st.reference_type <> 'OPENING_BALANCE'
           AND p.inventory_mode IN ('NON_STOCK','CARCASS_PART')`
      );
      console.log('[S5.2-C] Backfilled affect_stock for pre-existing stock_transactions rows (best-effort, history only — new rows are written explicitly by InventoryMovementService).');
    }

    const [catCount] = await conn.query(`SELECT COUNT(*) cnt FROM product_categories`);
    if (Number(catCount[0].cnt) === 0) {
      await conn.query(`INSERT INTO product_categories(name,sort_order) VALUES ('Thịt bò',1),('Thịt heo',2),('Thịt gà',3),('Chả các loại',4),('Bò xô / pha lóc',5)`);
    }

    const [prodCount] = await conn.query(`SELECT COUNT(*) cnt FROM products`);
    if (Number(prodCount[0].cnt) === 0) {
      await conn.query(`INSERT INTO products(category_id,product_code,name,unit,default_sale_price,stock_quantity,low_stock_threshold,inventory_mode,allow_negative_stock) VALUES
      (1,'BO_PHO','Bò phở','kg',220000,10,5,'TRACK_STOCK',0),
      (1,'BO_SUON','Sườn bò','kg',190000,10,5,'TRACK_STOCK',0),
      (1,'BO_BAP','Bắp bò','kg',260000,10,5,'TRACK_STOCK',0),
      (1,'BO_NAM','Nạm bò','kg',180000,10,5,'TRACK_STOCK',0),
      (2,'HEO_BA_CHI','Heo ba chỉ','kg',120000,20,5,'TRACK_STOCK',0),
      (3,'GA_TA','Gà ta','kg',95000,20,5,'TRACK_STOCK',0),
      (4,'CHA_LUA','Chả lụa','kg',140000,10,5,'TRACK_STOCK',0),
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

    // BP-006B: map beef bulk product names to standard price-resolver codes.
    // Uniqueness guard: skips any mapping where the target code already exists.
    // Never creates products; never changes IDs; only renames product_code.
    for (const { name, code } of [
      { name: 'Xô đực',  code: 'BEEF_BULK_MALE'   },
      { name: 'Xô cái',  code: 'BEEF_BULK_FEMALE'  },
      { name: 'Vụn xô',  code: 'BEEF_FRAGMENT'     }
    ]) {
      const [taken] = await conn.query(
        `SELECT id FROM products WHERE product_code = ? LIMIT 1`, [code]
      );
      if (taken.length) continue; // already migrated or code taken by another product
      await conn.query(
        `UPDATE products SET product_code = ?
         WHERE name = ? AND is_active = 1 AND del_flg = 0 AND unit = 'kg'`,
        [code, name]
      );
    }

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
        ('currency','VND'),
        ('quantity_decimal_places','2')`);
    }

    // QTY-DECIMAL-CONFIG-001: backfill quantity_decimal_places for existing installs —
    // INSERT IGNORE is a no-op if the key already exists (setting_key is UNIQUE), and only
    // seeds the '2' default if missing. Global quantity display formatting policy — see
    // frontend/src/utils/quantity.js and backend/src/services/PrintService.js.
    await conn.query(
      `INSERT IGNORE INTO business_settings(setting_key,setting_value) VALUES ('quantity_decimal_places','2')`
    );

    const [userCount] = await conn.query(`SELECT COUNT(*) cnt FROM users`);
    if (Number(userCount[0].cnt) === 0) {
      await conn.query(`INSERT INTO users(username,full_name,phone,password_hash,role,customer_id) VALUES
      ('admin','Chủ cửa hàng','0900000000','admin123','ADMIN',NULL),
      ('kh001','Quán A','0900000001','kh001123','CUSTOMER',1)`);
    }

    // MENU-SYSTEM-001-FINAL-FIX: new app_menus columns for existing installs
    await safeAddColumn(conn, 'app_menus', 'page_component',  'page_component VARCHAR(200) NULL');
    await safeAddColumn(conn, 'app_menus', 'parent_menu_key', 'parent_menu_key VARCHAR(100) NULL');
    await safeAddColumn(conn, 'app_menus', 'menu_type',       "menu_type VARCHAR(50) NOT NULL DEFAULT 'page'");

    // INVENTORY-SCHEMA-RUNTIME-FIX-001: units columns missing on older installs
    await safeAddColumn(conn, 'units', 'sort_order', 'sort_order INT NOT NULL DEFAULT 0');
    await safeAddColumn(conn, 'units', 'created_at', "created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP");
    await safeAddColumn(conn, 'units', 'updated_at', 'updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP');

    // V6.51 order payable split: today's bill + effective daily installment.
    await safeAddColumn(conn, 'orders', 'current_bill_amount', 'current_bill_amount DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER debt_amount');
    await safeAddColumn(conn, 'orders', 'installment_amount', 'installment_amount DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER current_bill_amount');
    await safeAddColumn(conn, 'orders', 'monthly_installment_id', 'monthly_installment_id BIGINT NULL AFTER installment_amount');

    // V6.50 payment one receipt cash/bank + installment columns
    await safeAddColumn(conn, 'payments', 'cash_amount', 'cash_amount DECIMAL(15,2) NOT NULL DEFAULT 0');
    await safeAddColumn(conn, 'payments', 'bank_amount', 'bank_amount DECIMAL(15,2) NOT NULL DEFAULT 0');
    await safeAddColumn(conn, 'payments', 'current_bill_amount', 'current_bill_amount DECIMAL(15,2) NOT NULL DEFAULT 0');
    await safeAddColumn(conn, 'payments', 'installment_amount', 'installment_amount DECIMAL(15,2) NOT NULL DEFAULT 0');
    await safeAddColumn(conn, 'payments', 'monthly_installment_id', 'monthly_installment_id BIGINT NULL AFTER installment_amount');
    if (await hasTable(conn, 'debt_installment_payments')) {
      await safeAddColumn(conn, 'debt_installment_payments', 'payment_id', 'payment_id BIGINT NULL');
      await safeAddColumn(conn, 'debt_installment_payments', 'cash_amount', 'cash_amount DECIMAL(15,2) NOT NULL DEFAULT 0');
      await safeAddColumn(conn, 'debt_installment_payments', 'bank_amount', 'bank_amount DECIMAL(15,2) NOT NULL DEFAULT 0');
    }

    // BP-001B: Partner Foundation
    // Adds partner_type to customers. Existing rows get DEFAULT 2 (Customer) automatically.
    await safeAddColumn(conn, 'customers', 'partner_type', 'partner_type INT NOT NULL DEFAULT 2');

    // BP-003: Domain B — add partner_id to supplier-side tables (dual-write, keep supplier_id for FK safety)
    await safeAddColumn(conn, 'supplier_purchase_options', 'partner_id', 'partner_id BIGINT NULL');
    await safeAddColumn(conn, 'purchase_orders', 'partner_id', 'partner_id BIGINT NULL');

    // BP-003: Backfill partner_id from supplier_partner_map (idempotent — only fills NULLs)
    if (await hasTable(conn, 'supplier_partner_map')) {
      await conn.query(
        `UPDATE supplier_purchase_options spo
         INNER JOIN supplier_partner_map m ON m.supplier_id = spo.supplier_id
         SET spo.partner_id = m.partner_id
         WHERE spo.partner_id IS NULL`
      );
      await conn.query(
        `UPDATE purchase_orders po
         INNER JOIN supplier_partner_map m ON m.supplier_id = po.supplier_id
         SET po.partner_id = m.partner_id
         WHERE po.partner_id IS NULL`
      );
    }

    // BP-001B: Supplier → Partner import (idempotent — checks supplier_partner_map before each insert)
    if (await hasTable(conn, 'supplier_partner_map')) {
      const [supplierRows] = await conn.query(
        `SELECT id, name, phone, address, note, is_active, billing_calendar_type
         FROM suppliers WHERE del_flg = 0`
      );
      for (const sup of supplierRows) {
        const [[already]] = await conn.query(
          `SELECT id FROM supplier_partner_map WHERE supplier_id = ?`, [sup.id]
        );
        if (already) continue;

        // Duplicate detection: phone match (most reliable)
        if (sup.phone) {
          const [[dup]] = await conn.query(
            `SELECT id, name FROM customers WHERE phone = ? AND del_flg = 0 LIMIT 1`, [sup.phone]
          );
          if (dup) {
            console.log(`[BP-001B] DUPLICATE — supplier "${sup.name}" (id=${sup.id}) phone matches customer "${dup.name}" (id=${dup.id}) — manual review required, not imported`);
            continue;
          }
        }

        const partnerCode = `NCC-${String(sup.id).padStart(3, '0')}`;
        const [[codeConflict]] = await conn.query(
          `SELECT id FROM customers WHERE customer_code = ?`, [partnerCode]
        );

        let partnerId;
        if (codeConflict) {
          partnerId = codeConflict.id;
        } else {
          const [ins] = await conn.query(
            `INSERT INTO customers
               (customer_code, name, phone, address, note, is_active,
                billing_calendar_type, partner_type, price_mode, debt_limit, payment_term_days)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'COMMON_PRICE', 0, 0)`,
            [partnerCode, sup.name, sup.phone || null, sup.address || null,
             sup.note || null, sup.is_active, sup.billing_calendar_type || null]
          );
          partnerId = ins.insertId;
          console.log(`[BP-001B] Imported supplier "${sup.name}" → partner ${partnerCode} (customer.id=${partnerId})`);
        }

        await conn.query(
          `INSERT IGNORE INTO supplier_partner_map (supplier_id, partner_id) VALUES (?, ?)`,
          [sup.id, partnerId]
        );
      }
    }

    // BP-009B: Partner → Supplier sync (idempotent — links customers.partner_type=1 that have no supplier_partner_map entry)
    if (await hasTable(conn, 'supplier_partner_map')) {
      const [partnerRows] = await conn.query(
        `SELECT c.id, c.name, c.phone, c.address, c.note, c.billing_calendar_type, c.is_active
         FROM customers c
         WHERE c.partner_type = 1 AND c.del_flg = 0
           AND NOT EXISTS (SELECT 1 FROM supplier_partner_map m WHERE m.partner_id = c.id)`
      );
      for (const p of partnerRows) {
        let supplierId = null;

        // Phone match against unmapped suppliers (preferred)
        if (p.phone) {
          const [[byPhone]] = await conn.query(
            `SELECT s.id FROM suppliers s
             WHERE s.phone = ? AND s.del_flg = 0
               AND NOT EXISTS (SELECT 1 FROM supplier_partner_map m WHERE m.supplier_id = s.id)
             LIMIT 1`,
            [p.phone]
          );
          if (byPhone) supplierId = byPhone.id;
        }

        // Name match against unmapped suppliers (fallback)
        if (!supplierId) {
          const [[byName]] = await conn.query(
            `SELECT s.id FROM suppliers s
             WHERE s.name = ? AND s.del_flg = 0
               AND NOT EXISTS (SELECT 1 FROM supplier_partner_map m WHERE m.supplier_id = s.id)
             LIMIT 1`,
            [p.name]
          );
          if (byName) supplierId = byName.id;
        }

        // No reusable supplier row — create one from customer data
        if (!supplierId) {
          const code = 'NCC' + Date.now() + '-' + p.id;
          const [ins] = await conn.query(
            `INSERT INTO suppliers(supplier_code, name, phone, address, note, billing_calendar_type, is_active, del_flg)
             VALUES(?, ?, ?, ?, ?, ?, ?, 0)`,
            [code, p.name, p.phone || '', p.address || '', p.note || '',
             p.billing_calendar_type || 'SOLAR', p.is_active]
          );
          supplierId = ins.insertId;
          console.log(`[BP-009B] Created suppliers row for partner "${p.name}" (customer.id=${p.id}) → supplier.id=${supplierId}`);
        } else {
          console.log(`[BP-009B] Linked partner "${p.name}" (customer.id=${p.id}) → existing supplier.id=${supplierId}`);
        }

        await conn.query(
          `INSERT IGNORE INTO supplier_partner_map(supplier_id, partner_id) VALUES(?, ?)`,
          [supplierId, p.id]
        );
      }
      if (!partnerRows.length) {
        console.log('[BP-009B] No unmapped supplier-partners found — already migrated or none exist.');
      }
    }

    // MENU-SYSTEM-001: Seed app_menus (INSERT IGNORE — idempotent, preserves admin edits)
    // [menu_key, title, subtitle, route, icon_key, group_key, sort_order, is_system, visible_in_sidebar, page_component]
    const appMenusSeed = [
      ['dashboard','AI Operating Center','Tổng quan điều hành, cảnh báo và hành động AI trong ngày.','dashboard','Home','sales',1,1,1,'Dashboard'],
      ['create-order','Tạo bill POS','Tạo bill nhanh, kiểm tồn, công nợ và hỗ trợ nhập bằng AI.','create-order','ShoppingCart','sales',2,1,1,'CreateOrder'],
      ['orders','Bill bán hàng','Theo dõi bill, in phiếu và trạng thái thanh toán.','orders','ClipboardList','sales',3,1,1,'Orders'],
      ['retail-daily-summary','Bán lẻ tổng hợp','Ghi nhận tổng tiền bán lẻ theo ngày kinh doanh (không liên kết đơn hàng).','retail-daily-summary','BarChart3','sales',4,0,1,'RetailDailySummary'],
      ['payments','Thu tiền','Ghi nhận tiền mặt, chuyển khoản và lịch sử thu.','payments','CreditCard','sales',5,1,1,'Payments'],
      ['installments','Góp bill','Quản lý góp bill theo khách hàng và lịch âm/dương.','installments','CalendarDays','sales',6,0,1,'Installments'],
      ['customers','Đối tác','Quản lý đối tác, khách hàng và nhà cung cấp.','customers','Users','sales',7,0,1,'Customers'],
      ['products','Mặt hàng','Quản lý sản phẩm, tồn kho, giá bán và chế độ kiểm tồn.','products','Package','catalog',1,0,1,'Products'],
      ['product-import','Import mặt hàng từ ảnh','Nhập danh mục nhanh từ hình ảnh hoặc file dữ liệu.','product-import','Package','catalog',2,0,1,'ProductImageImport'],
      ['ocr-providers','Cấu hình OCR nâng cao','Thiết lập nhận diện hình ảnh và alias sản phẩm.','ocr-providers','Bot','catalog',3,0,1,'OCRProviders'],
      ['price-matrix','Bảng giá riêng','Sắp xếp danh mục và bảng giá theo từng bạn hàng.','price-matrix','TableProperties','catalog',4,1,1,'PriceMatrix'],
      ['lots','Nhập xô','Quản lý nhập lô, trọng lượng, thanh toán và nhà cung cấp.','lots','Truck','purchase',1,0,1,'Lots'],
      ['units','Đơn vị tính','Quản lý đơn vị quy đổi dùng cho nhập hàng và tồn kho.','units','TableProperties','purchase',2,0,1,'Units'],
      ['supplier-purchase-options','Cấu hình quy cách nhập','Cấu hình đơn vị và quy đổi kg theo từng nhà cung cấp và sản phẩm.','supplier-purchase-options','Truck','purchase',3,0,1,'SupplierPurchaseOptions'],
      ['inventory-purchases','Phiếu mua hàng','Lập phiếu mua hàng theo nhà cung cấp, quy cách và tồn kho.','inventory-purchases','Package','purchase',4,0,1,'InventoryPurchases'],
      ['inventory-receives','Phiếu nhận hàng','Tạo và xác nhận phiếu nhận hàng từ phiếu mua hàng đã xác nhận.','inventory-receives','PackageCheck','purchase',5,0,1,'InventoryReceives'],
      ['stock-ledger','Sổ kho','Xem lịch sử nhập/xuất/điều chỉnh tồn kho theo từng dòng chứng từ (chỉ xem, không sửa).','stock-ledger','BookOpen','purchase',6,0,1,'StockLedger'],
      ['revenue','Doanh thu','Xem doanh thu, đã thu và công nợ theo thời gian.','revenue','BarChart3','report',1,0,1,'Revenue'],
      ['profit','Lợi nhuận','Thống kê lợi nhuận theo ngày/tháng/năm, giá vốn FIFO và ngày nhập NCC.','profit','BarChart3','report',2,0,1,'Profit'],
      ['agents','Agent AI','Các kỹ năng AI phục vụ vận hành bán sỉ.','agents','Bot','ai',1,0,1,'Agents'],
      ['portal','Trang thông tin / tài trợ','Quản lý nội dung giới thiệu và portal.','portal','Megaphone','ai',2,0,1,'BusinessPortal'],
      ['sponsor-videos','Video nhà tài trợ','Quản lý video và nội dung truyền thông.','sponsor-videos','Megaphone','ai',3,0,1,'SponsorVideos'],
      ['production-check','Kiểm tra production','Kiểm tra cấu hình, dữ liệu và trạng thái hệ thống.','production-check','Bot','ai',4,0,1,'ProductionCheck'],
      ['trash','Đã xóa / lịch sử','Theo dõi dữ liệu đã xóa mềm và audit.','trash','Trash2','system',1,0,1,'Trash'],
      ['settings','Cấu hình cửa hàng','Thông tin cửa hàng, in bill và thiết lập chung.','settings','Settings','system',2,0,1,'SettingsPage'],
      ['user-permissions','Phân quyền user','Thiết lập quyền truy cập chức năng theo user.','user-permissions','Settings','system',3,1,1,'UserPermissions'],
      ['registrations','Đăng ký khách hàng','Duyệt tài khoản đăng ký mới.','registrations','Settings','system',4,0,1,'Registrations'],
      ['user-mapping','Quản lý tài khoản','Tạo user nội bộ, quản lý khách hàng và duyệt đăng ký.','user-mapping','Settings','system',5,1,1,'UserCustomerMapping'],
      ['my-menu','Menu của tôi','Tuỳ chỉnh thứ tự và hiển thị menu cá nhân trên sidebar.','my-menu','Settings','system',99,0,1,'MyMenuPreferences'],
    ];
    for (const [menu_key,title,subtitle,route,icon_key,group_key,sort_order,is_system,visible_in_sidebar,page_component] of appMenusSeed) {
      await conn.query(
        `INSERT IGNORE INTO app_menus (menu_key,title,subtitle,route,icon_key,group_key,sort_order,is_system,visible_in_sidebar,page_component,menu_type)
         VALUES (?,?,?,?,?,?,?,?,?,?,'page')`,
        [menu_key,title,subtitle,route,icon_key,group_key,sort_order,is_system,visible_in_sidebar,page_component]
      );
      // Backfill new columns on existing rows (inserted before this schema version)
      await conn.query(
        `UPDATE app_menus SET page_component=?, menu_type='page' WHERE menu_key=? AND page_component IS NULL`,
        [page_component, menu_key]
      );
    }

    // INV-004 REVIEW → PURCHASE-NAMING-STD-001: rename purchase/receive menu labels —
    // idempotent UPDATE for existing installs. INSERT IGNORE above skips existing rows;
    // these UPDATEs patch already-seeded titles. Labels only — menu_key/route/permissions
    // untouched, so this is safe to re-run on every startup.
    await conn.query(
      `UPDATE app_menus SET title='Phiếu mua hàng', subtitle='Lập phiếu mua hàng theo nhà cung cấp, quy cách và tồn kho.'
       WHERE menu_key='inventory-purchases'`
    );
    await conn.query(
      `UPDATE app_menus SET title='Phiếu nhận hàng', subtitle='Tạo và xác nhận phiếu nhận hàng từ phiếu mua hàng đã xác nhận.'
       WHERE menu_key='inventory-receives'`
    );

    // LOTS-NAMING-STD-001: rename 'lots' menu label — same idempotent-rename pattern
    // as PURCHASE-NAMING-STD-001 above. Labels only — menu_key/route/permissions untouched.
    await conn.query(
      `UPDATE app_menus SET title='Nhập xô'
       WHERE menu_key='lots'`
    );

    // S4.2 — CATALOG-NAMING-STD-002: rename 'products' menu label to 'Mặt hàng'.
    // Audit concluded this screen is Product CRUD, not a Category management module —
    // Category is still just a lookup/master table with no standalone workflow, so a
    // catalog-grouping-framed label was misleading. Same idempotent-rename pattern as
    // PURCHASE-NAMING-STD-001/LOTS-NAMING-STD-001 above. Labels only — menu_key/route/
    // component/permissions untouched, safe to re-run on every startup.
    await conn.query(
      `UPDATE app_menus SET title='Mặt hàng', subtitle='Quản lý mặt hàng, mã hàng, danh mục, đơn vị và giá bán mặc định.'
       WHERE menu_key='products'`
    );

    // QTY-DECIMAL/MENU-CLEANUP-001 — CTO final audit: deactivate the stale 'product-categories'
    // menu row left over from an abandoned standalone Category-management module attempt.
    // That row's page_component ('ProductCategories') was never implemented in App.jsx, so
    // clicking it silently fell through to the default page (Dashboard / AI Operating Center) —
    // the reported "Danh mục hàng hóa opens AI Operating Center" defect. Category management now
    // lives inside Products.jsx (+ Thêm danh mục... / Quản lý danh mục...), not a separate menu.
    // is_active=0 is the project's existing menu-retirement convention — UserPermissionAgent's
    // menu/permission queries all gate on is_active=1, so this fully removes it from every
    // user's sidebar and from assignable permissions without deleting audit history. The row's
    // menu_key stays UNIQUE and reserved — do not reuse 'product-categories' for another module.
    // Idempotent: no-op once already inactive, safe to re-run on every startup.
    await conn.query(
      `UPDATE app_menus SET is_active=0, visible_in_sidebar=0 WHERE menu_key='product-categories'`
    );

    // MENU-MY-PREFERENCES-FINAL-FIX: place my-menu at the end of the system group — idempotent.
    // Fixes installs with group_key='personal' (002) and removes the hardcoded sort_order=6 (FINAL-FIX).
    // SELECT first to avoid MySQL's same-table subquery restriction in UPDATE.
    const [[myMenuPos]]=await conn.query(
      `SELECT COALESCE(MAX(sort_order),0)+1 AS next_order FROM app_menus WHERE group_key='system' AND menu_key<>'my-menu'`
    );
    await conn.query(
      `UPDATE app_menus SET group_key='system', sort_order=? WHERE menu_key='my-menu'`,
      [myMenuPos.next_order]
    );

    // MENU-PREFERENCES-MIGRATION-FIX-001: migrate existing installs where
    // user_menu_preferences was created with menu_key (old schema) instead of menu_id.
    // CREATE TABLE IF NOT EXISTS above is a no-op when table exists — this block repairs it.
    if (await hasTable(conn, 'user_menu_preferences') && !(await hasColumn(conn, 'user_menu_preferences', 'menu_id'))) {
      // Step 1: add nullable menu_id
      await conn.query(`ALTER TABLE user_menu_preferences ADD COLUMN menu_id BIGINT NULL`);
      // Step 2: backfill from app_menus (must run after app_menus seed above)
      if (await hasColumn(conn, 'user_menu_preferences', 'menu_key')) {
        await conn.query(
          `UPDATE user_menu_preferences ump
           JOIN app_menus am ON am.menu_key = ump.menu_key
           SET ump.menu_id = am.id
           WHERE ump.menu_id IS NULL`
        );
        // Step 3: drop orphan rows (menu_key no longer in app_menus)
        await conn.query(`DELETE FROM user_menu_preferences WHERE menu_id IS NULL`);
      }
      // Step 4: make NOT NULL now that orphans are removed
      await conn.query(`ALTER TABLE user_menu_preferences MODIFY COLUMN menu_id BIGINT NOT NULL`);
      // Step 5: replace old unique key (user_id, menu_key) with (user_id, menu_id)
      await safeDropIndex(conn, 'user_menu_preferences', 'uq_ump_user_menu');
      await safeAddIndex(conn, 'user_menu_preferences', 'uq_ump_user_menu', 'UNIQUE KEY uq_ump_user_menu(user_id, menu_id)');
      await safeAddIndex(conn, 'user_menu_preferences', 'idx_ump_user', 'INDEX idx_ump_user(user_id)');
      // Keep menu_key column — do NOT drop during this sprint
      console.log('[MENU-PREFERENCES-MIGRATION-FIX-001] Migrated user_menu_preferences to menu_id schema.');
    }

    // Validate parent_menu_key references — warn on orphans, do not crash
    const [orphanMenus]=await conn.query(
      `SELECT menu_key,parent_menu_key FROM app_menus
       WHERE parent_menu_key IS NOT NULL
         AND parent_menu_key NOT IN (SELECT menu_key FROM app_menus WHERE is_active=1)`
    );
    for(const row of orphanMenus){
      console.warn(`[MENU-SYSTEM] Invalid parent_menu_key: ${row.menu_key} -> ${row.parent_menu_key}`);
    }

    // Seed role defaults into role_menu_permissions (INSERT IGNORE — preserves existing customizations)
    await conn.query(
      `INSERT IGNORE INTO role_menu_permissions (role, menu_key, is_enabled)
       SELECT 'ADMIN', menu_key, 1 FROM app_menus WHERE is_active = 1`
    );
    for (const mk of ['create-order','orders','retail-daily-summary','payments','customers','products','product-import','ocr-providers','price-matrix','lots','revenue','profit','portal','my-menu','inventory-purchases','inventory-receives','stock-ledger']) {
      await conn.query(`INSERT IGNORE INTO role_menu_permissions (role, menu_key, is_enabled) VALUES ('STAFF', ?, 1)`, [mk]);
    }
    for (const mk of ['orders','payments','portal','customers','my-menu']) {
      await conn.query(`INSERT IGNORE INTO role_menu_permissions (role, menu_key, is_enabled) VALUES ('CUSTOMER', ?, 1)`, [mk]);
    }

    // ADMIN-MENU-PERMISSION-FIX-001: ADMIN always has all active menus.
    // Ensure role defaults are complete, then remove any is_enabled=0 overrides on ADMIN users.
    await conn.query(
      `INSERT IGNORE INTO role_menu_permissions (role, menu_key, is_enabled)
       SELECT 'ADMIN', menu_key, 1 FROM app_menus WHERE is_active = 1`
    );
    await conn.query(
      `DELETE ump FROM user_menu_permissions ump
       JOIN users u ON u.id = ump.user_id
       WHERE u.role = 'ADMIN' AND ump.is_enabled = 0`
    );

  } finally {
    conn.release();
  }
}

module.exports = { ensureSchema };
