const pool = require('../config/db');

const ENTITY = {
  // S7.0/S7.1: refChecks completed against the S7.0 Business Guard Matrix audit —
  // customer/product/category/supplier previously missed Customer Price
  // Category/Price Book references entirely (no DB-level FK exists for any of
  // these tables, so this array is the only protection there is).
  customer: { table:'customers', code:'customer_code', name:'name', refChecks:[
    {table:'orders', column:'customer_id', label:'bill bán'},
    {table:'payments', column:'customer_id', label:'phiếu thu'},
    {table:'debt_transactions', column:'customer_id', label:'công nợ'},
    {table:'customer_price_books', column:'customer_id', label:'bảng giá riêng'},
    {table:'customer_price_categories', column:'customer_id', label:'danh mục giá khách hàng'},
    {table:'customer_product_catalogs', column:'customer_id', label:'danh mục mặt hàng khách hàng'},
    {table:'customer_product_prices', column:'customer_id', label:'giá riêng (cũ)'}
  ]},
  product: { table:'products', code:'product_code', name:'name', refChecks:[
    {table:'order_items', column:'product_id', label:'dòng bill'},
    {table:'stock_transactions', column:'product_id', label:'lịch sử kho'},
    {table:'customer_product_prices', column:'product_id', label:'giá riêng'},
    {table:'customer_price_book_items', column:'product_id', label:'bảng giá riêng khách hàng'}
  ]},
  category: { table:'product_categories', code:'id', name:'name', refChecks:[
    {table:'products', column:'category_id', label:'mặt hàng'},
    {table:'customer_price_categories', column:'category_id', label:'danh mục giá khách hàng'},
    {table:'customer_price_books', column:'category_id', label:'bảng giá riêng'}
  ]},
  supplier: { table:'suppliers', code:'supplier_code', name:'name', refChecks:[
    {table:'purchase_lots', column:'supplier_id', label:'lô nhập'},
    {table:'supplier_purchase_options', column:'supplier_id', label:'quy cách nhập hàng'},
    {table:'purchase_orders', column:'supplier_id', label:'phiếu mua hàng'},
    {table:'inventory_receives', column:'supplier_id', label:'phiếu nhận hàng'}
  ]},
  lot: { table:'purchase_lots', code:'lot_code', name:'lot_name', refChecks:[
    {table:'supplier_payments', column:'lot_id', label:'thanh toán NCC'}
  ]}
};

class SoftDeleteAgent {
  constructor(){this.version='6.8.0';this.responsibility='Soft delete with del_flg, dependency check, delete history and restore list';}

  config(entityType){
    const cfg=ENTITY[entityType];
    if(!cfg) throw new Error('Loại dữ liệu xóa không hợp lệ');
    return cfg;
  }

  async hasReferences(conn, cfg, id) {
    const found=[];
    for(const c of cfg.refChecks||[]) {
      const [rows]=await conn.query(`SELECT COUNT(*) cnt FROM ${c.table} WHERE ${c.column}=?`, [id]);
      if(Number(rows[0].cnt)>0) found.push(`${c.label}: ${rows[0].cnt}`);
    }
    return found;
  }

  async softDelete(entityType, id, reason, userId) {
    if(!reason) throw new Error('Cần nhập lý do xóa');
    const cfg=this.config(entityType);
    const conn=await pool.getConnection();
    try{
      await conn.beginTransaction();
      const refs=await this.hasReferences(conn,cfg,id);
      if(refs.length) {
        const msg=`Không thể xóa vì còn phát sinh: ${refs.join(', ')}`;
        throw new Error(msg);
      }
      const [rows]=await conn.query(`SELECT * FROM ${cfg.table} WHERE id=? AND del_flg=0`, [id]);
      if(!rows.length) throw new Error('Không tìm thấy dữ liệu hoặc đã xóa');
      const row=rows[0];
      await conn.query(`UPDATE ${cfg.table} SET del_flg=1,is_active=0,delete_reason=?,deleted_at=NOW(),deleted_by=? WHERE id=?`, [reason,userId||null,id]);
      await conn.query(
        `INSERT INTO delete_logs(entity_type,entity_id,entity_code,entity_name,reason,deleted_by) VALUES(?,?,?,?,?,?)`,
        [entityType,id,String(row[cfg.code]??id),String(row[cfg.name]??''),reason,userId||null]
      );
      await conn.commit();
      return {message:'Đã xóa mềm và lưu lịch sử'};
    } catch(e){ await conn.rollback(); throw e; } finally { conn.release(); }
  }

  async deletedList(entityType) {
    const cfg=this.config(entityType);
    const [rows]=await pool.query(`SELECT * FROM ${cfg.table} WHERE del_flg=1 ORDER BY deleted_at DESC`);
    return rows;
  }

  async logs() {
    const [rows]=await pool.query(`SELECT * FROM delete_logs ORDER BY deleted_at DESC LIMIT 200`);
    return rows;
  }
}

module.exports = new SoftDeleteAgent();
