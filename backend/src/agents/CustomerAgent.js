const pool=require('../config/db');
const { assertCustomerScope, customerScopeWhere }=require('../middleware/scope');

async function nextCustomerCode(){
  const [rows]=await pool.query(`SELECT customer_code FROM customers WHERE customer_code REGEXP '^KH[0-9]+$' ORDER BY CAST(SUBSTRING(customer_code,3) AS UNSIGNED) DESC LIMIT 1`);
  let nextNo=1;
  if(rows.length){
    const n=parseInt(String(rows[0].customer_code).replace('KH',''),10);
    if(!Number.isNaN(n)) nextNo=n+1;
  }
  return 'KH'+String(nextNo).padStart(3,'0');
}

function normalizePriceMode(mode){
  const m=String(mode||'').trim();
  if(['COMMON_PRICE','CUSTOM_PRICE','PRIVATE','PRIVATE_PRICE'].includes(m)) return m;
  if(m==='PRIVATE_PRICE') return 'CUSTOM_PRICE';
  return 'COMMON_PRICE';
}

function normalizeBillingCalendarType(type){
  return String(type||'SOLAR').toUpperCase()==='LUNAR' ? 'LUNAR' : 'SOLAR';
}

function cleanName(data){
  return String(data.name||data.customer_name||data.full_name||'').trim();
}

class CustomerAgent{
  constructor(){
    this.version='6.28.0';
    this.responsibility='Customer CRUD scoped by user/customer, child customers, validation';
  }

  // Ensures a suppliers row and supplier_partner_map entry exist for this partner.
  // Idempotent: safe to call multiple times. Used when partner_type becomes 1 (supplier).
  async _syncPartnerToSupplier(customerId){
    const [[partner]]=await pool.query(
      `SELECT id,name,phone,address,note,billing_calendar_type,is_active FROM customers WHERE id=? AND del_flg=0`,
      [customerId]
    );
    if(!partner) return null;

    // Already mapped — nothing to do
    const [[existing]]=await pool.query(
      `SELECT supplier_id FROM supplier_partner_map WHERE partner_id=?`,[customerId]
    );
    if(existing) return {partner_id:customerId,supplier_id:existing.supplier_id,message:'Đã liên kết trước đó'};

    // Find an unmapped supplier row: prefer phone match, then name match
    let supplierId=null;
    if(partner.phone){
      const [[byPhone]]=await pool.query(
        `SELECT s.id FROM suppliers s
         WHERE s.phone=? AND s.del_flg=0
         AND NOT EXISTS (SELECT 1 FROM supplier_partner_map m WHERE m.supplier_id=s.id)
         LIMIT 1`,
        [partner.phone]
      );
      if(byPhone) supplierId=byPhone.id;
    }
    if(!supplierId){
      const [[byName]]=await pool.query(
        `SELECT s.id FROM suppliers s
         WHERE s.name=? AND s.del_flg=0
         AND NOT EXISTS (SELECT 1 FROM supplier_partner_map m WHERE m.supplier_id=s.id)
         LIMIT 1`,
        [partner.name]
      );
      if(byName) supplierId=byName.id;
    }

    // No reusable supplier row — create one
    if(!supplierId){
      const code='NCC'+Date.now();
      const [ins]=await pool.query(
        `INSERT INTO suppliers(supplier_code,name,phone,address,note,billing_calendar_type,is_active,del_flg)
         VALUES(?,?,?,?,?,?,?,0)`,
        [code,partner.name,partner.phone||'',partner.address||'',partner.note||'',
         partner.billing_calendar_type||'SOLAR',partner.is_active]
      );
      supplierId=ins.insertId;
    }

    await pool.query(
      `INSERT IGNORE INTO supplier_partner_map(supplier_id,partner_id) VALUES(?,?)`,
      [supplierId,customerId]
    );
    return {partner_id:customerId,supplier_id:supplierId,message:'Đã liên kết nhà cung cấp'};
  }

  async list(user){
    const scope=await customerScopeWhere(user,'c.id');
    const where='WHERE c.del_flg=0'+(scope.clause?' AND '+scope.clause:'');
    const params=[...scope.params];
    const [rows]=await pool.query(
      `SELECT c.*,
        pc.name parent_customer_name,
        COALESCE(SUM(CASE
          WHEN dt.type IN ('SALE','ADJUSTMENT_INCREASE') THEN dt.amount
          WHEN dt.type IN ('PAYMENT','ADJUSTMENT_DECREASE') THEN -dt.amount
          ELSE 0 END),0) current_debt
       FROM customers c
       LEFT JOIN customers pc ON pc.id=c.parent_customer_id
       LEFT JOIN debt_transactions dt ON dt.customer_id=c.id
       ${where}
       GROUP BY c.id
       ORDER BY c.parent_customer_id IS NULL DESC,c.id DESC`,
      params
    );
    return rows;
  }

  async create(data,user){
    const name=cleanName(data);
    if(!name) throw new Error('Tên khách hàng không được để trống');

    const code=data.customer_code||await nextCustomerCode();
    const parentCustomerId=(user&&user.role==='CUSTOMER')?user.customer_id:(data.parent_customer_id||null);

    const partner_type = Number(data.partner_type) === 1 ? 1 : 2;
    const [ins]=await pool.query(
      `INSERT INTO customers(customer_code,name,phone,address,price_mode,billing_calendar_type,note,is_active,del_flg,parent_customer_id,partner_type)
       VALUES(?,?,?,?,?,?,?,1,0,?,?)`,
      [code,name,data.phone||'',data.address||'',normalizePriceMode(data.price_mode),normalizeBillingCalendarType(data.billing_calendar_type),data.note||'',parentCustomerId,partner_type]
    );
    const sync=partner_type===1?await this._syncPartnerToSupplier(ins.insertId):null;
    return {message:'Đã tạo đối tác',customer_code:code,...(sync||{})};
  }

  async update(id,data,user){
    const name=cleanName(data);
    if(!name) throw new Error('Tên khách hàng không được để trống');

    await assertCustomerScope(user,id);

    const partner_type = Number(data.partner_type) === 1 ? 1 : 2;
    await pool.query(
      `UPDATE customers SET name=?,phone=?,address=?,price_mode=?,billing_calendar_type=?,note=?,is_active=?,partner_type=? WHERE id=? AND del_flg=0`,
      [name,data.phone||'',data.address||'',normalizePriceMode(data.price_mode),normalizeBillingCalendarType(data.billing_calendar_type),data.note||'',data.is_active?1:0,partner_type,id]
    );
    const sync=partner_type===1?await this._syncPartnerToSupplier(id):null;
    return {message:'Đã cập nhật đối tác',...(sync||{})};
  }

  async remove(id,reason,user){
    if(user&&user.role==='CUSTOMER'){
      if(Number(id)===Number(user.customer_id)) throw new Error('Không thể xóa tài khoản chính của mình');
      await assertCustomerScope(user,id);
    }
    await pool.query(`UPDATE customers SET del_flg=1,note=CONCAT(COALESCE(note,''),'\nXóa: ',?) WHERE id=?`,[reason||'',id]);
    return {message:'Đã xóa mềm khách hàng'};
  }

  async nextCode(){
    return {customer_code:await nextCustomerCode()};
  }
}
module.exports=new CustomerAgent();
