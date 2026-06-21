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
        if(!(await this.hasIndex(conn,'customer_price_books','uq_cpb_customer_date_type'))){
          logs.push(await this.safeAlter(conn,
            `ALTER TABLE customer_price_books ADD UNIQUE KEY uq_cpb_customer_date_type (customer_id, effective_from, effective_calendar_type)`
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
        ['ai_learning_logs','agent_name']
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
