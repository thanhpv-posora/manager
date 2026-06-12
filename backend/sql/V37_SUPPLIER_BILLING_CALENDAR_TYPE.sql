
-- =========================================
-- V37_SUPPLIER_BILLING_CALENDAR_TYPE
-- Nhà cung cấp chọn lịch tính bill Âm/Dương.
-- Compatible with older MySQL versions.
-- =========================================

SET @exists_supplier_calendar := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'suppliers'
    AND COLUMN_NAME = 'billing_calendar_type'
);
SET @sql_supplier_calendar := IF(
  @exists_supplier_calendar = 0,
  "ALTER TABLE suppliers ADD COLUMN billing_calendar_type ENUM('SOLAR','LUNAR') NOT NULL DEFAULT 'SOLAR'",
  "SELECT 'suppliers.billing_calendar_type already exists'"
);
PREPARE stmt FROM @sql_supplier_calendar;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @exists_lot_calendar := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'purchase_lots'
    AND COLUMN_NAME = 'calendar_type'
);
SET @sql_lot_calendar := IF(
  @exists_lot_calendar = 0,
  "ALTER TABLE purchase_lots ADD COLUMN calendar_type ENUM('SOLAR','LUNAR') NOT NULL DEFAULT 'SOLAR' AFTER purchase_date",
  "SELECT 'purchase_lots.calendar_type already exists'"
);
PREPARE stmt FROM @sql_lot_calendar;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @exists_lot_lunar := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'purchase_lots'
    AND COLUMN_NAME = 'lunar_date_text'
);
SET @sql_lot_lunar := IF(
  @exists_lot_lunar = 0,
  "ALTER TABLE purchase_lots ADD COLUMN lunar_date_text VARCHAR(50) NULL AFTER calendar_type",
  "SELECT 'purchase_lots.lunar_date_text already exists'"
);
PREPARE stmt FROM @sql_lot_lunar;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE suppliers
SET billing_calendar_type='SOLAR'
WHERE billing_calendar_type IS NULL OR billing_calendar_type='';

SELECT 'V37_SUPPLIER_BILLING_CALENDAR_TYPE DONE' AS result;
