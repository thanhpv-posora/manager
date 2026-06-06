const pool=require('../config/db');

class AutoMigrationAgent{
  constructor(){
    this.version='6.36.4';
    this.responsibility='Automatically create missing tables/columns at backend startup';
  }

  async tableExists(conn,table){
    const [rows]=await conn.query(
      `SELECT COUNT(*) cnt FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?`,
      [table]
    );
    return Number(rows[0].cnt)>0;
  }

  async columnExists(conn,table,column){
    const [rows]=await conn.query(
      `SELECT COUNT(*) cnt FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?`,
      [table,column]
    );
    return Number(rows[0].cnt)>0;
  }

  async exec(conn,sql,key){
    try{
      await conn.query(sql);
      return {key, status:'OK', sql};
    }catch(e){
      return {key, status:'ERROR', message:e.message, sql};
    }
  }

  async ensureMigrationHistory(conn){
    await conn.query(`CREATE TABLE IF NOT EXISTS migration_history (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      migration_key VARCHAR(255) NOT NULL UNIQUE,
      status VARCHAR(30) NOT NULL DEFAULT 'APPLIED',
      message TEXT NULL,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }

  async log(conn,key,status,message){
    await conn.query(
      `INSERT INTO migration_history(migration_key,status,message)
       VALUES(?,?,?)
       ON DUPLICATE KEY UPDATE status=VALUES(status),message=VALUES(message),applied_at=NOW()`,
      [key,status,message||'']
    );
  }

  async ensureTable(conn,table,createSql){
    if(await this.tableExists(conn,table)) return {key:`table:${table}`,status:'EXISTS'};
    const r=await this.exec(conn,createSql,`table:${table}`);
    await this.log(conn,`table:${table}`,r.status,r.message||'created');
    return r;
  }

  async ensureColumn(conn,table,column,definition){
    if(!(await this.tableExists(conn,table))) return {key:`column:${table}.${column}`,status:'SKIP_TABLE_MISSING'};
    if(await this.columnExists(conn,table,column)) return {key:`column:${table}.${column}`,status:'EXISTS'};
    const sql=`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`;
    const r=await this.exec(conn,sql,`column:${table}.${column}`);
    await this.log(conn,`column:${table}.${column}`,r.status,r.message||'created');
    return r;
  }

  async run(){
    const conn=await pool.getConnection();
    const logs=[];
    try{
      await this.ensureMigrationHistory(conn);

      logs.push(await this.ensureTable(conn,'user_app_preferences',`CREATE TABLE user_app_preferences (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT NOT NULL,
        pref_key VARCHAR(100) NOT NULL,
        pref_value JSON NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_user_pref(user_id,pref_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`));

      logs.push(await this.ensureTable(conn,'ocr_provider_configs',`CREATE TABLE ocr_provider_configs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        module_key VARCHAR(100) NOT NULL,
        provider VARCHAR(50) NOT NULL DEFAULT 'TESSERACT',
        endpoint_url TEXT NULL,
        api_key TEXT NULL,
        project_id VARCHAR(255) NULL,
        processor_id VARCHAR(255) NULL,
        location_id VARCHAR(100) NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        note TEXT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_ocr_module_provider(module_key,provider)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`));

      logs.push(await this.ensureTable(conn,'ai_learning_logs',`CREATE TABLE ai_learning_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        agent_name VARCHAR(100) NOT NULL,
        module_name VARCHAR(100) NOT NULL,
        action_name VARCHAR(100) NOT NULL,
        input_text LONGTEXT,
        output_text LONGTEXT,
        feedback_text LONGTEXT,
        confidence DECIMAL(5,2) NULL,
        created_by BIGINT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_ai_learning_agent(agent_name,module_name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`));

      logs.push(await this.ensureColumn(conn,'orders','calendar_type',`ENUM('SOLAR','LUNAR') NOT NULL DEFAULT 'SOLAR'`));
      logs.push(await this.ensureColumn(conn,'orders','lunar_date_text',`VARCHAR(30) NULL`));

      logs.push(await this.ensureColumn(conn,'customers','parent_customer_id',`BIGINT NULL`));

      logs.push(await this.ensureColumn(conn,'products','sale_price',`DECIMAL(15,2) NOT NULL DEFAULT 0`));
      logs.push(await this.ensureColumn(conn,'products','cost_price',`DECIMAL(15,2) NOT NULL DEFAULT 0`));
      logs.push(await this.ensureColumn(conn,'products','inventory_mode',`VARCHAR(30) NOT NULL DEFAULT 'STOCK'`));
      logs.push(await this.ensureColumn(conn,'products','allow_negative_stock',`TINYINT(1) NOT NULL DEFAULT 0`));
      logs.push(await this.ensureColumn(conn,'products','category_id',`BIGINT NULL`));
      logs.push(await this.ensureColumn(conn,'products','is_active',`TINYINT(1) NOT NULL DEFAULT 1`));
      logs.push(await this.ensureColumn(conn,'products','del_flg',`TINYINT(1) NOT NULL DEFAULT 0`));

      logs.push(await this.ensureColumn(conn,'sponsor_ad_campaigns','video_url',`TEXT NULL`));
      logs.push(await this.ensureColumn(conn,'sponsor_ad_campaigns','thumbnail_url',`TEXT NULL`));
      logs.push(await this.ensureColumn(conn,'sponsor_ad_campaigns','del_flg',`TINYINT(1) NOT NULL DEFAULT 0`));
      logs.push(await this.ensureColumn(conn,'sponsor_ad_campaigns','deleted_at',`DATETIME NULL`));
      logs.push(await this.ensureColumn(conn,'sponsor_ad_campaigns','deleted_reason',`TEXT NULL`));

      const created=logs.filter(x=>x.status==='OK').length;
      const exists=logs.filter(x=>x.status==='EXISTS').length;
      const errors=logs.filter(x=>x.status==='ERROR');
      
      logs.push(await this.ensureTable(conn,'customer_account_registrations',`CREATE TABLE customer_account_registrations (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        full_name VARCHAR(255) NULL,
        business_name VARCHAR(255) NOT NULL,
        owner_name VARCHAR(255) NOT NULL,
        phone VARCHAR(50) NOT NULL,
        email VARCHAR(255) NULL,
        address TEXT NULL,
        username VARCHAR(100) NOT NULL,
        password_hash VARCHAR(255) NULL,
        service_plan VARCHAR(50) NOT NULL DEFAULT 'TRIAL',
        payment_method VARCHAR(50) NOT NULL DEFAULT 'NONE',
        transfer_note TEXT NULL,
        description TEXT NULL,
        status ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_registration_username(username)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`));

      logs.push(await this.ensureColumn(conn,'customer_account_registrations','full_name',`VARCHAR(255) NULL`));
      logs.push(await this.ensureColumn(conn,'customer_account_registrations','password_hash',`VARCHAR(255) NULL`));
      logs.push(await this.ensureColumn(conn,'customer_account_registrations','description',`TEXT NULL`));

      return {message:'Auto migration completed',created,exists,error_count:errors.length,logs};
    }finally{
      conn.release();
    }
  }

  async check(){
    const conn=await pool.getConnection();
    try{
      const checks=[
        ['orders','calendar_type'],
        ['orders','lunar_date_text'],
        ['user_app_preferences','pref_key'],
        ['ocr_provider_configs','provider'],
        ['ai_learning_logs','agent_name'],
        ['products','sale_price'],
        ['products','inventory_mode'],
        ['customers','parent_customer_id'],
        ['customer_account_registrations','password_hash']
      ];
      const result=[];
      for(const [table,column] of checks){
        const t=await this.tableExists(conn,table);
        const c=t?await this.columnExists(conn,table,column):false;
        result.push({table,column,status:t&&c?'OK':'MISSING'});
      }
      return result;
    }finally{
      conn.release();
    }
  }
}

module.exports=new AutoMigrationAgent();
