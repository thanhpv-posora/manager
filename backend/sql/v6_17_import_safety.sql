USE meat_business_db;

CREATE TABLE IF NOT EXISTS import_audit_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  source_type VARCHAR(50) NOT NULL,
  raw_text LONGTEXT,
  result_json LONGTEXT,
  warning_count INT NOT NULL DEFAULT 0,
  created_by BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
