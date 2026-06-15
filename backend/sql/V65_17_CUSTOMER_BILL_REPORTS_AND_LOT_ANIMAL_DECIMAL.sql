-- MeatBiz V65.17 - Customer bill reports + supplier animal quantity decimal fix
-- Cho phép nhập số lượng bò 2.5 con, không bị làm tròn thành 3.

ALTER TABLE purchase_lots
  MODIFY COLUMN total_animals DECIMAL(15,1) NOT NULL DEFAULT 0,
  MODIFY COLUMN male_animals DECIMAL(15,1) NOT NULL DEFAULT 0,
  MODIFY COLUMN female_animals DECIMAL(15,1) NOT NULL DEFAULT 0;
