-- V6.36.4 reference only.
-- You do NOT need to run this manually. AutoMigrationAgent runs on backend startup.

ALTER TABLE orders ADD COLUMN calendar_type ENUM('SOLAR','LUNAR') NOT NULL DEFAULT 'SOLAR';
ALTER TABLE orders ADD COLUMN lunar_date_text VARCHAR(30) NULL;

CREATE TABLE user_app_preferences (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  pref_key VARCHAR(100) NOT NULL,
  pref_value JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_user_pref(user_id,pref_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
