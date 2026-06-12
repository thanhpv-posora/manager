-- V16 Email-only auth verification for MeatBiz
-- SMS/phone OTP is intentionally disabled. Use email verify and forgot password by email.

ALTER TABLE customer_account_registrations
  MODIFY email VARCHAR(255) NULL;

-- Keep these columns for compatibility, but V16 does not use SMS OTP in production.
-- phone_verified_at can stay NULL. Admin approval only requires email_verified_at when email exists.

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

SELECT 'V16_EMAIL_ONLY_AUTH_MAIL_SERVER_DONE' AS result;
