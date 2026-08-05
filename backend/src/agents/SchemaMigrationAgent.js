const pool=require('../config/db');

class SchemaMigrationAgent{
  constructor(){
    this.version='6.32.0';
    this.responsibility='Automatic schema migration and production schema health checks';
  }

  async hasColumn(conn,table,column){
    const [rows]=await conn.query(
      `SELECT COUNT(*) cnt FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?`,
      [table,column]
    );
    return Number(rows[0].cnt)>0;
  }

  async hasTable(conn,table){
    const [rows]=await conn.query(
      `SELECT COUNT(*) cnt FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?`,
      [table]
    );
    return Number(rows[0].cnt)>0;
  }

  async hasIndex(conn,table,indexName){
    const [rows]=await conn.query(
      `SELECT COUNT(*) cnt FROM INFORMATION_SCHEMA.STATISTICS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=?`,
      [table,indexName]
    );
    return Number(rows[0].cnt)>0;
  }

  // params is optional (defaults to none) — every pre-existing call site in
  // this file passes fixed DDL/DML with no placeholders, so this stays fully
  // backward-compatible; mergeMenuKey() below is the first caller to pass
  // params, to keep its dynamic WHERE/SET values parameterized rather than
  // string-interpolated.
  async safeAlter(conn,sql,params=[]){
    try{ await conn.query(sql,params); return {sql,status:'OK'}; }
    catch(e){ return {sql,status:'ERROR',message:e.message}; }
  }

  // P1-02A follow-up (CTO review correction) — extracted from migrate() as
  // its own method so it can be exercised in isolation (unit-style, against
  // a minimal mock conn) without needing to also mock every other unrelated
  // statement migrate() issues. Merges a retired app_menus.menu_key into its
  // replacement, preserving role_menu_permissions/user_menu_permissions
  // grants. See migrate()'s call site below for the full case-by-case
  // reasoning (rename vs. merge-then-delete vs. no-op) — unchanged here,
  // just relocated. All statements parameterized (? placeholders) — oldKey/
  // newKey are always fixed literals from the call site today, but this
  // never string-interpolates them into SQL regardless.
  async mergeMenuKey(conn,oldKey,newKey){
    const logs=[];
    const [oldMenuRows]=await conn.query(`SELECT id FROM app_menus WHERE menu_key=?`,[oldKey]);
    const [newMenuRows]=await conn.query(`SELECT id FROM app_menus WHERE menu_key=?`,[newKey]);
    if(oldMenuRows.length && !newMenuRows.length){
      logs.push(await this.safeAlter(conn,`UPDATE app_menus SET menu_key=?, route=? WHERE menu_key=?`,[newKey,newKey,oldKey]));
      logs.push(await this.safeAlter(conn,`UPDATE role_menu_permissions SET menu_key=? WHERE menu_key=?`,[newKey,oldKey]));
      logs.push(await this.safeAlter(conn,`UPDATE user_menu_permissions SET menu_key=? WHERE menu_key=?`,[newKey,oldKey]));
    } else if(oldMenuRows.length && newMenuRows.length){
      logs.push(await this.safeAlter(conn,`
        INSERT IGNORE INTO role_menu_permissions (role, menu_key, is_enabled)
        SELECT role, ?, is_enabled FROM role_menu_permissions WHERE menu_key=?
      `,[newKey,oldKey]));
      logs.push(await this.safeAlter(conn,`
        INSERT IGNORE INTO user_menu_permissions (user_id, menu_key, is_enabled, updated_by)
        SELECT user_id, ?, is_enabled, updated_by FROM user_menu_permissions WHERE menu_key=?
      `,[newKey,oldKey]));
      logs.push(await this.safeAlter(conn,`DELETE FROM role_menu_permissions WHERE menu_key=?`,[oldKey]));
      logs.push(await this.safeAlter(conn,`DELETE FROM user_menu_permissions WHERE menu_key=?`,[oldKey]));
      logs.push(await this.safeAlter(conn,`DELETE FROM app_menus WHERE menu_key=?`,[oldKey]));
    }
    return logs;
  }

  async migrate(){
    const conn=await pool.getConnection();
    const logs=[];
    try{
      // customers.price_mode caused WARN_DATA_TRUNCATED when code sent PRIVATE.
      if(await this.hasTable(conn,'customers')){
        logs.push(await this.safeAlter(conn,
          `ALTER TABLE customers
           MODIFY COLUMN price_mode
           ENUM('COMMON_PRICE','CUSTOM_PRICE','PRIVATE','PRIVATE_PRICE')
           NOT NULL DEFAULT 'COMMON_PRICE'`
        ));
        logs.push(await this.safeAlter(conn,
          `UPDATE customers
           SET price_mode='COMMON_PRICE'
           WHERE price_mode IS NULL OR price_mode=''`
        ));
        if(!(await this.hasColumn(conn,'customers','parent_customer_id'))){
          logs.push(await this.safeAlter(conn,`ALTER TABLE customers ADD COLUMN parent_customer_id BIGINT NULL`));
        }
      }

      if(await this.hasTable(conn,'sponsor_ad_campaigns')){
        if(!(await this.hasColumn(conn,'sponsor_ad_campaigns','del_flg')))
          logs.push(await this.safeAlter(conn,`ALTER TABLE sponsor_ad_campaigns ADD COLUMN del_flg TINYINT(1) NOT NULL DEFAULT 0`));
        if(!(await this.hasColumn(conn,'sponsor_ad_campaigns','deleted_at')))
          logs.push(await this.safeAlter(conn,`ALTER TABLE sponsor_ad_campaigns ADD COLUMN deleted_at DATETIME NULL`));
        if(!(await this.hasColumn(conn,'sponsor_ad_campaigns','deleted_reason')))
          logs.push(await this.safeAlter(conn,`ALTER TABLE sponsor_ad_campaigns ADD COLUMN deleted_reason TEXT NULL`));
        if(!(await this.hasColumn(conn,'sponsor_ad_campaigns','video_url')))
          logs.push(await this.safeAlter(conn,`ALTER TABLE sponsor_ad_campaigns ADD COLUMN video_url TEXT NULL`));
        if(!(await this.hasColumn(conn,'sponsor_ad_campaigns','thumbnail_url')))
          logs.push(await this.safeAlter(conn,`ALTER TABLE sponsor_ad_campaigns ADD COLUMN thumbnail_url TEXT NULL`));
      }

      if(await this.hasTable(conn,'debt_installment_plans')){
        if(!(await this.hasColumn(conn,'debt_installment_plans','target_debt_amount')))
          logs.push(await this.safeAlter(conn,`ALTER TABLE debt_installment_plans ADD COLUMN target_debt_amount DECIMAL(15,2) NOT NULL DEFAULT 0`));
      }

      if(await this.hasTable(conn,'customer_price_books')){
        // S4.2: category-scoped price books — superseded the old 3-column key.
        if(!(await this.hasColumn(conn,'customer_price_books','category_id'))){
          logs.push(await this.safeAlter(conn,`ALTER TABLE customer_price_books ADD COLUMN category_id BIGINT NULL`));
        }
        if(await this.hasTable(conn,'customer_price_book_items')){
          logs.push(await this.safeAlter(conn,`
            UPDATE customer_price_books b
            JOIN (
              SELECT bi.price_book_id, MIN(p.category_id) only_category, COUNT(DISTINCT p.category_id) distinct_categories
              FROM customer_price_book_items bi
              JOIN products p ON p.id = bi.product_id
              GROUP BY bi.price_book_id
            ) x ON x.price_book_id = b.id
            SET b.category_id = x.only_category
            WHERE b.category_id IS NULL AND x.distinct_categories = 1
          `));
        }
        if(await this.hasIndex(conn,'customer_price_books','uq_cpb_customer_date_type')){
          logs.push(await this.safeAlter(conn,`ALTER TABLE customer_price_books DROP INDEX uq_cpb_customer_date_type`));
        }
        if(!(await this.hasIndex(conn,'customer_price_books','uq_cpb_customer_category_date_type'))){
          logs.push(await this.safeAlter(conn,
            `ALTER TABLE customer_price_books ADD UNIQUE KEY uq_cpb_customer_category_date_type (customer_id, category_id, effective_from, effective_calendar_type)`
          ));
        }
      }

      // S4.3: Customer Price Category domain model upgrade. Runs after the S4.2 block above,
      // which guarantees customer_price_books.category_id is backfilled first.
      // customer_id/category_id on customer_price_books are intentionally NOT dropped here —
      // deprecated in place (kept NOT NULL/populated on write, no longer read by app code)
      // until the cutover has been reviewed.
      if(!(await this.hasTable(conn,'customer_price_categories'))){
        logs.push(await this.safeAlter(conn,`
          CREATE TABLE customer_price_categories (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            customer_id BIGINT NOT NULL,
            category_id BIGINT NOT NULL,
            is_default TINYINT(1) NOT NULL DEFAULT 0,
            display_order INT NOT NULL DEFAULT 0,
            note VARCHAR(255) NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_cpc_customer_category (customer_id, category_id),
            INDEX idx_cpc_customer (customer_id)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `));
      }

      if(await this.hasTable(conn,'customer_price_categories') && await this.hasTable(conn,'customer_price_books')){
        // Backfill: one CustomerPriceCategory per distinct (customer_id, category_id) pair
        // ever used by a price book. INSERT IGNORE makes this idempotent.
        logs.push(await this.safeAlter(conn,`
          INSERT IGNORE INTO customer_price_categories (customer_id, category_id, is_default, display_order)
          SELECT DISTINCT customer_id, category_id, 0, 0
          FROM customer_price_books
          WHERE customer_id IS NOT NULL AND category_id IS NOT NULL
        `));

        // Single-category customers: unambiguous default. Multi-category customers are left
        // with is_default=0 on every row — no invented preference; POS/Price Matrix will
        // require an explicit selection for them (Case 3) until the user picks one.
        logs.push(await this.safeAlter(conn,`
          UPDATE customer_price_categories cpc
          JOIN (
            SELECT customer_id FROM customer_price_categories GROUP BY customer_id HAVING COUNT(*)=1
          ) single ON single.customer_id = cpc.customer_id
          SET cpc.is_default = 1
          WHERE cpc.is_default = 0
        `));

        // display_order: 1..N per customer, stable ordering by category_id. Guarded by
        // "WHERE display_order=0" so re-running the migration never re-numbers rows that
        // already have an order (including ones a user has since customized).
        logs.push(await this.safeAlter(conn,`
          UPDATE customer_price_categories cpc
          JOIN (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY category_id) rn
            FROM customer_price_categories
          ) x ON x.id = cpc.id
          SET cpc.display_order = x.rn
          WHERE cpc.display_order = 0
        `));

        // CTO S4.3 hardening: DB-level backstops on top of the app-level transactions in
        // PriceMatrixAgent. Safe to add now — the backfill above already guarantees at most
        // one is_default=1 and a unique 1..N display_order per customer, so neither ALTER
        // can fail against existing data.
        if(!(await this.hasColumn(conn,'customer_price_categories','default_slot'))){
          logs.push(await this.safeAlter(conn,
            `ALTER TABLE customer_price_categories ADD COLUMN default_slot BIGINT GENERATED ALWAYS AS (IF(is_default=1, customer_id, NULL)) STORED`
          ));
        }
        if(!(await this.hasIndex(conn,'customer_price_categories','uq_cpc_one_default_per_customer'))){
          logs.push(await this.safeAlter(conn,
            `ALTER TABLE customer_price_categories ADD UNIQUE KEY uq_cpc_one_default_per_customer (default_slot)`
          ));
        }
        if(!(await this.hasIndex(conn,'customer_price_categories','uq_cpc_customer_display_order'))){
          logs.push(await this.safeAlter(conn,
            `ALTER TABLE customer_price_categories ADD UNIQUE KEY uq_cpc_customer_display_order (customer_id, display_order)`
          ));
        }

        if(!(await this.hasColumn(conn,'customer_price_books','customer_price_category_id'))){
          logs.push(await this.safeAlter(conn,`ALTER TABLE customer_price_books ADD COLUMN customer_price_category_id BIGINT NULL`));
        }

        logs.push(await this.safeAlter(conn,`
          UPDATE customer_price_books b
          JOIN customer_price_categories cpc ON cpc.customer_id = b.customer_id AND cpc.category_id <=> b.category_id
          SET b.customer_price_category_id = cpc.id
          WHERE b.customer_price_category_id IS NULL
        `));

        if(!(await this.hasIndex(conn,'customer_price_books','idx_cpb_customer_price_category'))){
          logs.push(await this.safeAlter(conn,`ALTER TABLE customer_price_books ADD INDEX idx_cpb_customer_price_category (customer_price_category_id)`));
        }
        if(!(await this.hasIndex(conn,'customer_price_books','uq_cpb_category_date_type'))){
          logs.push(await this.safeAlter(conn,
            `ALTER TABLE customer_price_books ADD UNIQUE KEY uq_cpb_category_date_type (customer_price_category_id, effective_from, effective_calendar_type)`
          ));
        }
      }

      // P1-02A — audit_logs performance indexes for GET /api/audit-logs
      // (AuditLogAgent.js). Moved here from bootstrap.js's every-startup
      // ensureSchema(): these are purely additive, non-blocking performance
      // indexes, not something the app requires to boot, so they belong in
      // the deliberately-triggered migration path (this method, via
      // POST /api/schema/migrate) rather than automatic startup DDL — same
      // reasoning already applied to every other index in this file.
      //   - idx_audit_logs_created_at: ORDER BY created_at DESC (every
      //     request) and the from_date/to_date range filter.
      //   - idx_audit_logs_entity: composite (entity_type, entity_id) — the
      //     "show me everything on this one record" lookup.
      //   - idx_audit_logs_action: the action-code filter.
      //   - idx_audit_logs_user: the user_id filter.
      if(await this.hasTable(conn,'audit_logs')){
        if(!(await this.hasIndex(conn,'audit_logs','idx_audit_logs_created_at'))){
          logs.push(await this.safeAlter(conn,`ALTER TABLE audit_logs ADD INDEX idx_audit_logs_created_at (created_at)`));
        }
        if(!(await this.hasIndex(conn,'audit_logs','idx_audit_logs_entity'))){
          logs.push(await this.safeAlter(conn,`ALTER TABLE audit_logs ADD INDEX idx_audit_logs_entity (entity_type, entity_id)`));
        }
        if(!(await this.hasIndex(conn,'audit_logs','idx_audit_logs_action'))){
          logs.push(await this.safeAlter(conn,`ALTER TABLE audit_logs ADD INDEX idx_audit_logs_action (action)`));
        }
        if(!(await this.hasIndex(conn,'audit_logs','idx_audit_logs_user'))){
          logs.push(await this.safeAlter(conn,`ALTER TABLE audit_logs ADD INDEX idx_audit_logs_user (user_id)`));
        }
      }

      // P1-02A follow-up (CTO review correction) — merges the transient
      // duplicate 'audit-logs' app_menus row into the canonical 'system_audit'
      // key (mergeMenuKey() above). Live read-only audit against the shared
      // dev DB confirmed BOTH rows can coexist (the server booted against it
      // once on the pre-rename bootstrap.js seed, and again after) — "the
      // old key was never deployed" must never be assumed, it must be
      // checked. mergeMenuKey() is existence-guarded end to end, so this is
      // a no-op on every run after the first successful one.
      if(await this.hasTable(conn,'app_menus')){
        logs.push(...(await this.mergeMenuKey(conn,'audit-logs','system_audit')));
      }

      // P2-02 (production cleanup) — Inventory Receive Reversal's additive
      // schema, moved out of bootstrap.js's every-boot ensureSchema() into
      // this deliberately-triggered path, same reasoning as the P1-02A
      // audit_logs indexes above.
      //
      // 1) inventory_receives.cancelled_at/cancelled_by/cancel_reason — same
      //    three column names/types already used on orders. Covers both the
      //    pre-existing PENDING→CANCELLED path and the new
      //    RECEIVED→CANCELLED_REVERSAL path.
      if(await this.hasTable(conn,'inventory_receives')){
        if(!(await this.hasColumn(conn,'inventory_receives','cancelled_at')))
          logs.push(await this.safeAlter(conn,`ALTER TABLE inventory_receives ADD COLUMN cancelled_at DATETIME NULL`));
        if(!(await this.hasColumn(conn,'inventory_receives','cancelled_by')))
          logs.push(await this.safeAlter(conn,`ALTER TABLE inventory_receives ADD COLUMN cancelled_by BIGINT NULL`));
        if(!(await this.hasColumn(conn,'inventory_receives','cancel_reason')))
          logs.push(await this.safeAlter(conn,`ALTER TABLE inventory_receives ADD COLUMN cancel_reason TEXT NULL`));
      }

      // 2) stock_transactions.reversal_dedup_key — same generated-column +
      //    UNIQUE-index idempotency idiom this table's own receive_dedup_key
      //    already uses, just for the reversal's OUT side instead of the
      //    receive's IN side: NULL for every row except
      //    reference_type='RECEIVE_VOUCHER' AND type='OUT', so at most one
      //    compensating OUT can ever exist per (product_id, receive_id) — a
      //    genuine concurrent double-reversal is rejected atomically by
      //    MySQL. No ENUM change needed — 'RECEIVE_VOUCHER' and 'OUT' are
      //    both already valid values on their respective columns.
      if(await this.hasTable(conn,'stock_transactions')){
        if(!(await this.hasColumn(conn,'stock_transactions','reversal_dedup_key'))){
          logs.push(await this.safeAlter(conn,`
            ALTER TABLE stock_transactions ADD COLUMN reversal_dedup_key VARCHAR(64) GENERATED ALWAYS AS
              (CASE WHEN reference_type = 'RECEIVE_VOUCHER' AND type = 'OUT'
                    THEN CONCAT(product_id, ':', reference_id) ELSE NULL END) STORED
          `));
        }
        if(!(await this.hasIndex(conn,'stock_transactions','uq_stock_transactions_reversal_dedup'))){
          logs.push(await this.safeAlter(conn,
            `ALTER TABLE stock_transactions ADD UNIQUE KEY uq_stock_transactions_reversal_dedup (reversal_dedup_key)`
          ));
        }
      }

      // GO-LIVE cleanup — V65.47 (Order/Payment lock + reallocation) was only
      // ever applied by hand, via the standalone
      // backend/sql/V65_47_ORDER_PAYMENT_LOCK_AND_REALLOCATION.sql, never
      // onboarded into either ensureSchema() or this agent. A fresh deploy
      // with no operator having manually run that file is missing every
      // column below — OrderAgent.ensureOrderEditable()/lock() SELECT
      // is_locked/locked_at unconditionally (no missing-column fallback) and
      // hard-crash on any order edit/lock/cancel; PaymentAgent.cancel()
      // silently degrades (its ER_BAD_FIELD_ERROR fallback zeroes the amount
      // but never sets a status, so the payment reports success without ever
      // being marked CANCELLED). Also folds in V6.51.11's
      // payment_calendar_type/payment_lunar_date_text (same fate, same fix).
      if(await this.hasTable(conn,'orders')){
        if(!(await this.hasColumn(conn,'orders','is_locked')))
          logs.push(await this.safeAlter(conn,`ALTER TABLE orders ADD COLUMN is_locked TINYINT(1) NOT NULL DEFAULT 0`));
        if(!(await this.hasColumn(conn,'orders','locked_at')))
          logs.push(await this.safeAlter(conn,`ALTER TABLE orders ADD COLUMN locked_at DATETIME NULL`));
        if(!(await this.hasColumn(conn,'orders','locked_by')))
          logs.push(await this.safeAlter(conn,`ALTER TABLE orders ADD COLUMN locked_by BIGINT NULL`));
        if(!(await this.hasColumn(conn,'orders','lock_note')))
          logs.push(await this.safeAlter(conn,`ALTER TABLE orders ADD COLUMN lock_note VARCHAR(255) NULL`));
        if(!(await this.hasIndex(conn,'orders','idx_orders_lock')))
          logs.push(await this.safeAlter(conn,`CREATE INDEX idx_orders_lock ON orders(is_locked, locked_at)`));
      }

      if(await this.hasTable(conn,'payments')){
        if(!(await this.hasColumn(conn,'payments','status')))
          logs.push(await this.safeAlter(conn,`ALTER TABLE payments ADD COLUMN status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE'`));
        if(!(await this.hasColumn(conn,'payments','is_locked')))
          logs.push(await this.safeAlter(conn,`ALTER TABLE payments ADD COLUMN is_locked TINYINT(1) NOT NULL DEFAULT 0`));
        if(!(await this.hasColumn(conn,'payments','locked_at')))
          logs.push(await this.safeAlter(conn,`ALTER TABLE payments ADD COLUMN locked_at DATETIME NULL`));
        if(!(await this.hasColumn(conn,'payments','locked_by')))
          logs.push(await this.safeAlter(conn,`ALTER TABLE payments ADD COLUMN locked_by BIGINT NULL`));
        if(!(await this.hasColumn(conn,'payments','lock_note')))
          logs.push(await this.safeAlter(conn,`ALTER TABLE payments ADD COLUMN lock_note VARCHAR(255) NULL`));
        if(!(await this.hasColumn(conn,'payments','updated_at')))
          logs.push(await this.safeAlter(conn,`ALTER TABLE payments ADD COLUMN updated_at DATETIME NULL`));
        if(!(await this.hasColumn(conn,'payments','payment_calendar_type')))
          logs.push(await this.safeAlter(conn,`ALTER TABLE payments ADD COLUMN payment_calendar_type ENUM('SOLAR','LUNAR') NOT NULL DEFAULT 'SOLAR'`));
        if(!(await this.hasColumn(conn,'payments','payment_lunar_date_text')))
          logs.push(await this.safeAlter(conn,`ALTER TABLE payments ADD COLUMN payment_lunar_date_text VARCHAR(30) NULL`));
        if(!(await this.hasIndex(conn,'payments','idx_payments_lock')))
          logs.push(await this.safeAlter(conn,`CREATE INDEX idx_payments_lock ON payments(is_locked, locked_at, status)`));

        // GO-LIVE — Payment Cancel/Reversal gaps. cancel() previously zeroed
        // amount/cash_amount/bank_amount in place with no way to recover what
        // the payment was originally for, and had no cancelled_at/
        // cancelled_by/cancel_reason (unlike orders/inventory_receives, which
        // both already have this exact triad). original_* columns are
        // populated only by cancel() going forward; amount/cash_amount/
        // bank_amount continue to zero out unchanged, so every existing
        // SUM(amount)-style reporting query (PaymentAgent.summary()) is
        // unaffected — this is purely additive recoverability, not a
        // behavior change to any existing read path.
        if(!(await this.hasColumn(conn,'payments','original_amount')))
          logs.push(await this.safeAlter(conn,`ALTER TABLE payments ADD COLUMN original_amount DECIMAL(15,2) NULL`));
        if(!(await this.hasColumn(conn,'payments','original_cash_amount')))
          logs.push(await this.safeAlter(conn,`ALTER TABLE payments ADD COLUMN original_cash_amount DECIMAL(15,2) NULL`));
        if(!(await this.hasColumn(conn,'payments','original_bank_amount')))
          logs.push(await this.safeAlter(conn,`ALTER TABLE payments ADD COLUMN original_bank_amount DECIMAL(15,2) NULL`));
        if(!(await this.hasColumn(conn,'payments','cancelled_at')))
          logs.push(await this.safeAlter(conn,`ALTER TABLE payments ADD COLUMN cancelled_at DATETIME NULL`));
        if(!(await this.hasColumn(conn,'payments','cancelled_by')))
          logs.push(await this.safeAlter(conn,`ALTER TABLE payments ADD COLUMN cancelled_by BIGINT NULL`));
        if(!(await this.hasColumn(conn,'payments','cancel_reason')))
          logs.push(await this.safeAlter(conn,`ALTER TABLE payments ADD COLUMN cancel_reason TEXT NULL`));
      }

      // GO-LIVE — Supplier Payment cancel/reversal did not exist at all
      // (SupplierPayableAgent had createPayment() but no way to undo one).
      // Same cancel-metadata triad as every other domain in this file.
      if(await this.hasTable(conn,'supplier_purchase_payments')){
        if(!(await this.hasColumn(conn,'supplier_purchase_payments','status')))
          logs.push(await this.safeAlter(conn,`ALTER TABLE supplier_purchase_payments ADD COLUMN status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE'`));
        if(!(await this.hasColumn(conn,'supplier_purchase_payments','cancelled_at')))
          logs.push(await this.safeAlter(conn,`ALTER TABLE supplier_purchase_payments ADD COLUMN cancelled_at DATETIME NULL`));
        if(!(await this.hasColumn(conn,'supplier_purchase_payments','cancelled_by')))
          logs.push(await this.safeAlter(conn,`ALTER TABLE supplier_purchase_payments ADD COLUMN cancelled_by BIGINT NULL`));
        if(!(await this.hasColumn(conn,'supplier_purchase_payments','cancel_reason')))
          logs.push(await this.safeAlter(conn,`ALTER TABLE supplier_purchase_payments ADD COLUMN cancel_reason TEXT NULL`));
      }

      // Idempotency for the supplier payment reversal ledger row — same
      // insert-first + UNIQUE idiom as uq_supplier_payable_receive_purchase
      // above, scoped to supplier_payment_id instead of inventory_receive_id.
      // NULL supplier_payment_id rows (PURCHASE/receive-reversal rows, the
      // vast majority) are each distinct under MySQL's NULL-in-UNIQUE
      // semantics, so this only ever constrains the new payment-reversal path.
      if(await this.hasTable(conn,'supplier_payable_transactions')){
        if(!(await this.hasIndex(conn,'supplier_payable_transactions','uq_supplier_payable_payment_reversal'))){
          logs.push(await this.safeAlter(conn,
            `ALTER TABLE supplier_payable_transactions ADD UNIQUE KEY uq_supplier_payable_payment_reversal (supplier_payment_id, type)`
          ));
        }
      }

      // fix(partner): remove duplicate supplier management menu — the
      // standalone 'suppliers' app_menus row (P2-01, ea5ac47/5c655c4)
      // duplicated the Partner ('customers', "Đối tác") workflow and was
      // removed from bootstrap.js's seed. That seed is INSERT IGNORE, so an
      // already-migrated DB still has the row from a prior boot — deleting it
      // (and its role_menu_permissions/user_menu_permissions grants) is a
      // deliberately-triggered cleanup, same reasoning as mergeMenuKey()
      // above for the 'audit-logs' → 'system_audit' rename. Order matches the
      // task's own listed order: permission grants first, then the menu row
      // itself. Idempotent — every DELETE is a no-op once the rows are gone.
      // Never touches the suppliers TABLE (business data) or the 'customers'
      // (Đối tác) menu row.
      if(await this.hasTable(conn,'role_menu_permissions')){
        logs.push(await this.safeAlter(conn,`DELETE FROM role_menu_permissions WHERE menu_key='suppliers'`));
      }
      if(await this.hasTable(conn,'user_menu_permissions')){
        logs.push(await this.safeAlter(conn,`DELETE FROM user_menu_permissions WHERE menu_key='suppliers'`));
      }
      if(await this.hasTable(conn,'app_menus')){
        logs.push(await this.safeAlter(conn,`DELETE FROM app_menus WHERE menu_key='suppliers'`));
      }

      return {message:'Schema migration completed',logs};
    }finally{
      conn.release();
    }
  }

  async check(){
    const conn=await pool.getConnection();
    try{
      const checks=[];
      const required=[
        ['customers','price_mode'],
        ['customers','parent_customer_id'],
        ['sponsor_ad_campaigns','video_url'],
        ['sponsor_ad_campaigns','del_flg'],
        ['debt_installment_plans','target_debt_amount'],
        ['user_menu_permissions','menu_key'],
        ['ai_learning_logs','agent_name'],
        ['customer_price_books','category_id'],
        ['customer_price_books','customer_price_category_id'],
        ['customer_price_categories','is_default'],
        ['customer_price_categories','default_slot'],
        // P2-02 (production cleanup)
        ['inventory_receives','cancelled_at'],
        ['inventory_receives','cancelled_by'],
        ['inventory_receives','cancel_reason'],
        ['stock_transactions','reversal_dedup_key'],
        // GO-LIVE cleanup — V65.47 lock/status parity
        ['orders','is_locked'],
        ['orders','locked_at'],
        ['orders','locked_by'],
        ['orders','lock_note'],
        ['payments','status'],
        ['payments','is_locked'],
        ['payments','locked_at'],
        ['payments','locked_by'],
        ['payments','lock_note'],
        ['payments','updated_at'],
        ['payments','payment_calendar_type'],
        ['payments','payment_lunar_date_text'],
        // GO-LIVE — Payment Cancel/Reversal gaps
        ['payments','original_amount'],
        ['payments','original_cash_amount'],
        ['payments','original_bank_amount'],
        ['payments','cancelled_at'],
        ['payments','cancelled_by'],
        ['payments','cancel_reason'],
        ['supplier_purchase_payments','status'],
        ['supplier_purchase_payments','cancelled_at'],
        ['supplier_purchase_payments','cancelled_by'],
        ['supplier_purchase_payments','cancel_reason']
      ];
      for(const [table,column] of required){
        const tableOk=await this.hasTable(conn,table);
        const colOk=tableOk?await this.hasColumn(conn,table,column):false;
        checks.push({table,column,status:tableOk&&colOk?'OK':'MISSING'});
      }

      // P1-02A — bootstrap.js intentionally does not create these (see
      // migrate() above); this is the sole "verify" surface for them. Row
      // shape preserves {table,column,status} so the Production Check page's
      // existing table (table/column/status columns only) renders these
      // unchanged — column holds "INDEX <name>" for a readable label there.
      // type/index_name are ADDITIVE fields (CTO review correction): a real
      // index-name lookup against INFORMATION_SCHEMA.STATISTICS via
      // this.hasIndex() decides status — never inferred from the column
      // merely existing, which would be a false positive (a column can exist
      // with zero indexes on it).
      const requiredIndexes=[
        ['audit_logs','idx_audit_logs_created_at'],
        ['audit_logs','idx_audit_logs_entity'],
        ['audit_logs','idx_audit_logs_action'],
        ['audit_logs','idx_audit_logs_user'],
        // P2-02 (production cleanup)
        ['stock_transactions','uq_stock_transactions_reversal_dedup'],
        // GO-LIVE cleanup — V65.47 lock/status parity
        ['orders','idx_orders_lock'],
        ['payments','idx_payments_lock'],
        ['supplier_payable_transactions','uq_supplier_payable_payment_reversal'],
      ];
      for(const [table,indexName] of requiredIndexes){
        const tableOk=await this.hasTable(conn,table);
        const idxOk=tableOk?await this.hasIndex(conn,table,indexName):false;
        checks.push({table,column:`INDEX ${indexName}`,type:'INDEX',index_name:indexName,status:tableOk&&idxOk?'OK':'MISSING'});
      }

      // P1-02A follow-up — reports the live menu-key merge state (see the
      // matching block in migrate() above) using the same row shape.
      {
        const [[oldMenu]]=await conn.query(`SELECT COUNT(*) cnt FROM app_menus WHERE menu_key='audit-logs'`);
        const [[newMenu]]=await conn.query(`SELECT COUNT(*) cnt FROM app_menus WHERE menu_key='system_audit'`);
        checks.push({table:'app_menus',column:"legacy 'audit-logs' row retired",status:Number(oldMenu.cnt)===0?'OK':'MISSING'});
        checks.push({table:'app_menus',column:"'system_audit' row present",status:Number(newMenu.cnt)>0?'OK':'MISSING'});
      }

      // fix(partner): reports the live cleanup state for the removed
      // standalone 'suppliers' menu (see the matching DELETE block in
      // migrate() above) using the same row shape. 'OK' means gone.
      {
        const [[menuRow]]=await conn.query(`SELECT COUNT(*) cnt FROM app_menus WHERE menu_key='suppliers'`);
        const [[roleRow]]=await conn.query(`SELECT COUNT(*) cnt FROM role_menu_permissions WHERE menu_key='suppliers'`);
        const [[userRow]]=await conn.query(`SELECT COUNT(*) cnt FROM user_menu_permissions WHERE menu_key='suppliers'`);
        checks.push({table:'app_menus',column:"obsolete 'suppliers' menu row retired",status:Number(menuRow.cnt)===0?'OK':'MISSING'});
        checks.push({table:'role_menu_permissions',column:"'suppliers' grants retired",status:Number(roleRow.cnt)===0?'OK':'MISSING'});
        checks.push({table:'user_menu_permissions',column:"'suppliers' grants retired",status:Number(userRow.cnt)===0?'OK':'MISSING'});
      }

      return checks;
    }finally{
      conn.release();
    }
  }
}
module.exports=new SchemaMigrationAgent();
