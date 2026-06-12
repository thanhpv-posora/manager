-- =========================================
-- V15 Production Auth & Verification
-- Compatible with older MySQL versions
-- =========================================

CREATE TABLE IF NOT EXISTS auth_event_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  event_type VARCHAR(80) NOT NULL,
  actor_user_id BIGINT NULL,
  registration_id BIGINT NULL,
  identifier VARCHAR(255) NULL,
  ip VARCHAR(80) NULL,
  user_agent TEXT NULL,
  success_flg TINYINT(1) NOT NULL DEFAULT 1,
  message TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_event_type_created(event_type,created_at),
  KEY idx_identifier_created(identifier,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET @c := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customer_account_registrations' AND COLUMN_NAME='email_verified_at');
SET @s := IF(@c=0, 'ALTER TABLE customer_account_registrations ADD COLUMN email_verified_at DATETIME NULL', 'SELECT "email_verified_at exists"');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customer_account_registrations' AND COLUMN_NAME='phone_verified_at');
SET @s := IF(@c=0, 'ALTER TABLE customer_account_registrations ADD COLUMN phone_verified_at DATETIME NULL', 'SELECT "phone_verified_at exists"');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customer_account_registrations' AND COLUMN_NAME='email_verify_token_hash');
SET @s := IF(@c=0, 'ALTER TABLE customer_account_registrations ADD COLUMN email_verify_token_hash VARCHAR(128) NULL', 'SELECT "email_verify_token_hash exists"');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customer_account_registrations' AND COLUMN_NAME='email_verify_expires_at');
SET @s := IF(@c=0, 'ALTER TABLE customer_account_registrations ADD COLUMN email_verify_expires_at DATETIME NULL', 'SELECT "email_verify_expires_at exists"');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customer_account_registrations' AND COLUMN_NAME='phone_otp_hash');
SET @s := IF(@c=0, 'ALTER TABLE customer_account_registrations ADD COLUMN phone_otp_hash VARCHAR(255) NULL', 'SELECT "phone_otp_hash exists"');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customer_account_registrations' AND COLUMN_NAME='phone_otp_expires_at');
SET @s := IF(@c=0, 'ALTER TABLE customer_account_registrations ADD COLUMN phone_otp_expires_at DATETIME NULL', 'SELECT "phone_otp_expires_at exists"');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customer_account_registrations' AND COLUMN_NAME='phone_otp_sent_at');
SET @s := IF(@c=0, 'ALTER TABLE customer_account_registrations ADD COLUMN phone_otp_sent_at DATETIME NULL', 'SELECT "phone_otp_sent_at exists"');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customer_account_registrations' AND COLUMN_NAME='verification_status');
SET @s := IF(@c=0, 'ALTER TABLE customer_account_registrations ADD COLUMN verification_status VARCHAR(30) NOT NULL DEFAULT ''PENDING''', 'SELECT "verification_status exists"');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customer_account_registrations' AND COLUMN_NAME='approved_by');
SET @s := IF(@c=0, 'ALTER TABLE customer_account_registrations ADD COLUMN approved_by BIGINT NULL', 'SELECT "approved_by exists"');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customer_account_registrations' AND COLUMN_NAME='last_verify_error');
SET @s := IF(@c=0, 'ALTER TABLE customer_account_registrations ADD COLUMN last_verify_error TEXT NULL', 'SELECT "last_verify_error exists"');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

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

SELECT 'V15_PRODUCTION_AUTH_VERIFICATION DONE' AS result;
