-- =========================================
-- V14 Registration + Forgot Password + Mail/SMS support
-- Compatible with older MySQL versions
-- =========================================

-- users.phone
SET @exists_col := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='phone'
);
SET @sql := IF(@exists_col=0, 'ALTER TABLE users ADD COLUMN phone VARCHAR(50) NULL', 'SELECT "users.phone already exists"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- users.email
SET @exists_col := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='email'
);
SET @sql := IF(@exists_col=0, 'ALTER TABLE users ADD COLUMN email VARCHAR(255) NULL', 'SELECT "users.email already exists"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- registration table safety columns
CREATE TABLE IF NOT EXISTS customer_account_registrations (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  full_name VARCHAR(255) NULL,
  business_name VARCHAR(255) NOT NULL,
  owner_name VARCHAR(255) NOT NULL,
  phone VARCHAR(50) NOT NULL,
  email VARCHAR(255) NULL,
  address TEXT NULL,
  username VARCHAR(100) NOT NULL,
  password_hash VARCHAR(255) NULL,
  service_plan VARCHAR(50) NOT NULL DEFAULT 'TRIAL',
  payment_method VARCHAR(50) NOT NULL DEFAULT 'NONE',
  transfer_note TEXT NULL,
  description TEXT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
  customer_id BIGINT NULL,
  user_id BIGINT NULL,
  approved_at DATETIME NULL,
  rejected_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_registration_username(username),
  KEY idx_registration_phone(phone),
  KEY idx_registration_email(email)
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

SELECT 'V14_REGISTRATION_FORGOT_PASSWORD_MAIL_PHONE DONE' AS result;
