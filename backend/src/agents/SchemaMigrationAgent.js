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

  async safeAlter(conn,sql){
    try{ await conn.query(sql); return {sql,status:'OK'}; }
    catch(e){ return {sql,status:'ERROR',message:e.message}; }
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
        ['customer_price_categories','default_slot']
      ];
      for(const [table,column] of required){
        const tableOk=await this.hasTable(conn,table);
        const colOk=tableOk?await this.hasColumn(conn,table,column):false;
        checks.push({table,column,status:tableOk&&colOk?'OK':'MISSING'});
      }
      return checks;
    }finally{
      conn.release();
    }
  }
}
module.exports=new SchemaMigrationAgent();
