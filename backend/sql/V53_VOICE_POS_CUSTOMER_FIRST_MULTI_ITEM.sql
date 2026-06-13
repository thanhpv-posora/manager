-- V53 Voice POS customer-first multi-item parser support
-- This migration is safe and idempotent. It ensures AI chat session table exists.

CREATE TABLE IF NOT EXISTS ai_chat_sessions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id VARCHAR(255) NOT NULL,
  customer_id BIGINT NULL,
  draft_json LONGTEXT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'DRAFT',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_ai_chat_sessions_session_status (session_id, status),
  INDEX idx_ai_chat_sessions_created_at (created_at)
);

-- Optional hygiene: make sure dangerous voice aliases do not point to multiple products.
-- Review result after running. It should return 0 rows.
SELECT alias_text,
       GROUP_CONCAT(DISTINCT product_id ORDER BY product_id) AS product_ids,
       COUNT(DISTINCT product_id) AS product_count
FROM product_ocr_aliases
GROUP BY alias_text
HAVING COUNT(DISTINCT product_id) > 1;
