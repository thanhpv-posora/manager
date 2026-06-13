-- V50 Voice POS Draft Replace Stable
-- Ensure AI chat session table exists for draft lifecycle.
CREATE TABLE IF NOT EXISTS ai_chat_sessions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id VARCHAR(100) NOT NULL,
  customer_id BIGINT NULL,
  draft_json LONGTEXT NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'DRAFT',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_ai_chat_sessions_session_status (session_id, status),
  INDEX idx_ai_chat_sessions_created_at (created_at)
);

-- Clean old duplicate same alias/product rows.
DELETE t1
FROM product_ocr_aliases t1
JOIN product_ocr_aliases t2
  ON t1.id > t2.id
 AND t1.alias_text = t2.alias_text
 AND t1.product_id = t2.product_id
 AND COALESCE(t1.customer_id, 0) = COALESCE(t2.customer_id, 0);

-- Cancel old open drafts to prevent old add_item cache leaking into new bill after deploy.
UPDATE ai_chat_sessions
SET status = 'CANCELLED'
WHERE status = 'DRAFT';

SELECT 'V50_VOICE_POS_DRAFT_REPLACE_STABLE DONE' AS result;
