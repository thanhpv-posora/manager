const pool=require('../config/db');

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

function cleanName(data){
  return String(data.name||data.customer_name||data.full_name||'').trim();
}

class CustomerAgent{
  constructor(){
    this.version='6.27.0';
    this.responsibility='Customer CRUD scoped by user/customer, child customers, validation';
  }

  async list(user){
    const params=[];
    let where='WHERE c.del_flg=0';
    if(user&&user.role==='CUSTOMER'){
      where+=' AND (c.id=? OR c.parent_customer_id=?)';
      params.push(user.customer_id,user.customer_id);
    }
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

    await pool.query(
      `INSERT INTO customers(customer_code,name,phone,address,price_mode,note,is_active,del_flg,parent_customer_id)
       VALUES(?,?,?,?,?,?,1,0,?)`,
      [code,name,data.phone||'',data.address||'',normalizePriceMode(data.price_mode),data.note||'',parentCustomerId]
    );
    return {message:'Đã tạo khách hàng',customer_code:code};
  }

  async update(id,data,user){
    const name=cleanName(data);
    if(!name) throw new Error('Tên khách hàng không được để trống');

    if(user&&user.role==='CUSTOMER'){
      const [check]=await pool.query(`SELECT id FROM customers WHERE id=? AND (id=? OR parent_customer_id=?) AND del_flg=0`,[id,user.customer_id,user.customer_id]);
      if(!check.length) throw new Error('Không có quyền sửa khách hàng này');
    }

    await pool.query(
      `UPDATE customers SET name=?,phone=?,address=?,price_mode=?,note=?,is_active=? WHERE id=? AND del_flg=0`,
      [name,data.phone||'',data.address||'',normalizePriceMode(data.price_mode),data.note||'',data.is_active?1:0,id]
    );
    return {message:'Đã cập nhật khách hàng'};
  }

  async remove(id,reason,user){
    if(user&&user.role==='CUSTOMER'){
      const [check]=await pool.query(`SELECT id FROM customers WHERE id=? AND parent_customer_id=? AND del_flg=0`,[id,user.customer_id]);
      if(!check.length) throw new Error('User khách chỉ được xóa khách con do mình tạo');
    }
    await pool.query(`UPDATE customers SET del_flg=1,note=CONCAT(COALESCE(note,''),'\nXóa: ',?) WHERE id=?`,[reason||'',id]);
    return {message:'Đã xóa mềm khách hàng'};
  }

  async nextCode(){
    return {customer_code:await nextCustomerCode()};
  }
}
module.exports=new CustomerAgent();
