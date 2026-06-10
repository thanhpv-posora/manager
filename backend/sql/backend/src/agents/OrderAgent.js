const pool = require('../config/db');
const { nanoid } = require('nanoid');
const { nextCode } = require('../utils/code');
const InventoryService = require('../services/InventoryService');
const PrintService = require('../services/PrintService');
const DebtMonthlyInstallmentAgent=require('./DebtMonthlyInstallmentAgent');

function customerScopeFilterV625(user, baseWhere, params) {
  if(user && user.role==='CUSTOMER') {
    return {where: baseWhere + ' AND o.customer_id=?', params:[...params, user.customer_id]};
  }
  return {where:baseWhere, params};
}


function parseLunarDateParts(text){
  const m=String(text||'').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if(!m)return null;
  return {day:Number(m[1]),month:Number(m[2]),year:Number(m[3])};
}

function solarDateParts(dateText){
  const m=String(dateText||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(m)return {day:Number(m[3]),month:Number(m[2]),year:Number(m[1])};
  const d=dateText?new Date(dateText):new Date();
  return {day:d.getDate(),month:d.getMonth()+1,year:d.getFullYear()};
}

async function monthlyInstallmentForOrder(order){
  const calendarType=String(order.calendar_type||'SOLAR').toUpperCase()==='LUNAR'?'LUNAR':'SOLAR';
  let period;
  if(calendarType==='LUNAR') period=parseLunarDateParts(order.lunar_date_text)||solarDateParts(order.order_date);
  else period=solarDateParts(order.order_date);
  const row=await DebtMonthlyInstallmentAgent.getActiveInstallment(order.customer_id,period.month,period.year,calendarType,period.day);
  return {...row, bill_day:period.day, installment_month:period.month, installment_year:period.year, calendar_type:calendarType};
}

class OrderAgent {
  constructor(){this.version='6.8.0';this.responsibility='Order POS, inventory-aware bill, QR, A4 print, thermal K80 print';}
  async list(user, query={}) {
    const where=[], params=[];
    if (user.role==='CUSTOMER') { where.push('o.customer_id=?'); params.push(user.customer_id); }
    if (query.from_date || query.from) { where.push('DATE(o.order_date)>=?'); params.push(String(query.from_date||query.from).slice(0,10)); }
    if (query.to_date || query.to) { where.push('DATE(o.order_date)<=?'); params.push(String(query.to_date||query.to).slice(0,10)); }
    if (query.customer_name || query.customer) { where.push('c.name LIKE ?'); params.push('%'+String(query.customer_name||query.customer).trim()+'%'); }
    const [rows] = await pool.query(
      `SELECT o.*,c.name customer_name FROM orders o JOIN customers c ON c.id=o.customer_id
       ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY o.order_date DESC,o.id DESC`,
      params
    );
    return rows;
  }

  async get(id,user) {
    const [orders] = await pool.query(
      `SELECT o.*,c.name customer_name,c.phone,c.address FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.id=?`,
      [id]
    );
    if (!orders.length) throw new Error('Không tìm thấy bill');
    const [items] = await pool.query(`SELECT * FROM order_items WHERE order_id=? ORDER BY id`, [id]);
    const order = orders[0];
    const [oldDebts] = await pool.query(
      `SELECT id,order_code,order_date,total_amount,paid_amount,debt_amount,calendar_type,lunar_date_text
       FROM orders
       WHERE customer_id=? AND status<>'CANCELLED' AND debt_amount>0
         AND (order_date < ? OR (order_date = ? AND id < ?))
       ORDER BY order_date ASC,id ASC`,
      [order.customer_id, order.order_date, order.order_date, order.id]
    );
    const [payRows]=await pool.query(`SELECT * FROM payments WHERE order_id=? ORDER BY id DESC LIMIT 1`,[id]);
    let monthly_installment=await monthlyInstallmentForOrder(order);
    if(payRows[0]?.monthly_installment_id){
      try{
        const [used]=await pool.query(`SELECT * FROM debt_monthly_installments WHERE id=? LIMIT 1`,[payRows[0].monthly_installment_id]);
        if(used[0]) monthly_installment=used[0];
      }catch(e){}
    }
    return {...order, items, old_debts:oldDebts, old_debt_total:oldDebts.reduce((s,x)=>s+Number(x.debt_amount||0),0), monthly_installment, payment:payRows[0]||null};
  }

  async getByToken(token) {
    const [orders] = await pool.query(
      `SELECT o.*,c.name customer_name,c.phone,c.address FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.private_token=? OR o.order_code=? LIMIT 1`,
      [token, token]
    );
    if (!orders.length) throw new Error('Không tìm thấy bill');
    const order = orders[0];
    const [items] = await pool.query(`SELECT * FROM order_items WHERE order_id=? ORDER BY id`, [order.id]);
    const [oldDebts] = await pool.query(
      `SELECT id,order_code,order_date,total_amount,paid_amount,debt_amount,calendar_type,lunar_date_text
       FROM orders
       WHERE customer_id=? AND status<>'CANCELLED' AND debt_amount>0
         AND (order_date < ? OR (order_date = ? AND id < ?))
       ORDER BY order_date ASC,id ASC`,
      [order.customer_id, order.order_date, order.order_date, order.id]
    );
    const [payRows]=await pool.query(`SELECT * FROM payments WHERE order_id=? ORDER BY id DESC LIMIT 1`,[order.id]);
    let monthly_installment=await monthlyInstallmentForOrder(order);
    if(payRows[0]?.monthly_installment_id){
      try{
        const [used]=await pool.query(`SELECT * FROM debt_monthly_installments WHERE id=? LIMIT 1`,[payRows[0].monthly_installment_id]);
        if(used[0]) monthly_installment=used[0];
      }catch(e){}
    }
    return {...order, items, old_debts:oldDebts, old_debt_total:oldDebts.reduce((s,x)=>s+Number(x.debt_amount||0),0), monthly_installment, payment:payRows[0]||null};
  }

  async create(data, user) {
    if (!data.items || !data.items.length) throw new Error('Bill phải có ít nhất 1 mặt hàng');
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const code = await nextCode(conn,'orders','order_code','BILL');
      const itemTotal = data.items.reduce((s,it)=>s+Number(it.quantity||0)*Number(it.sale_price||0),0);
      // V6.51 critical fix: order total must include the effective daily installment.
      // Otherwise a bill paid only for today's items is incorrectly marked PAID and the installment debt disappears.
      const installmentAmount = Number(data.monthly_installment_amount ?? data.installment_amount ?? 0);
      const total = itemTotal + installmentAmount;
      const paid = Number(data.paid_amount||0);
      const debt = Math.max(0,total-paid);
      const pstatus = paid<=0?'UNPAID':paid>=total?'PAID':'PARTIAL';
      const [r] = await conn.query(
        `INSERT INTO orders(order_code,customer_id,order_date,delivery_date,status,payment_status,total_amount,paid_amount,debt_amount,private_token,note,created_by)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        [code,data.customer_id,data.order_date,data.delivery_date||null,'DELIVERED',pstatus,total,paid,debt,nanoid(24),data.note||'',user.id]
      );
      
const orderId = r.insertId;
    // V6.51: persist bill calendar and installment fields so POS, payment, print, and reports use the same values.
    try{
      const safeCalendarType=data.calendar_type==='LUNAR'?'LUNAR':'SOLAR';
      const safeLunarDateText=safeCalendarType==='LUNAR'?(data.lunar_date_text||''):'';
      const monthlyInstallmentId=Number(data.monthly_installment_id||0)||null;
      await conn.query(
        `UPDATE orders SET calendar_type=?, lunar_date_text=?, current_bill_amount=?, installment_amount=?, monthly_installment_id=? WHERE id=?`,
        [safeCalendarType,safeLunarDateText,itemTotal,installmentAmount,monthlyInstallmentId,orderId]
      );
    }catch(e){
      // Ignore if DB has not migrated optional V6.51 columns yet.
    }
      for (const it of data.items) {
        const line = Number(it.quantity||0)*Number(it.sale_price||0);
        const inv = await InventoryService.out(conn,it.product_id,it.quantity,data.order_date,'SALE',orderId,`Xuất bill ${code}`,user.id);
        await conn.query(
          `INSERT INTO order_items(order_id,product_id,product_name,unit,quantity,sale_price,total_price,price_type,note,inventory_mode,stock_checked)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          [orderId,it.product_id,it.product_name,it.unit||'kg',it.quantity,it.sale_price,line,it.price_type||'MANUAL_PRICE',it.note||null,inv.inventory_mode,inv.stock_checked?1:0]
        );
      }
      if (debt > 0) {
        await conn.query(
          `INSERT INTO debt_transactions(customer_id,order_id,transaction_date,type,amount,note,created_by)
           VALUES(?,?,?,'SALE',?,?,?)`,
          [data.customer_id,orderId,data.order_date,debt,`Công nợ bill ${code}`,user.id]
        );
      }
      await conn.commit();
      return {message:'Đã tạo bill', order_id:orderId, order_code:code};
    } catch(e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }

  async updateItem(orderId, itemId, data) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [items] = await conn.query(`SELECT * FROM order_items WHERE id=? AND order_id=? FOR UPDATE`, [itemId,orderId]);
      if (!items.length) throw new Error('Không tìm thấy dòng bill');
      const old = items[0];
      const newQty = Number(data.quantity);
      const newPrice = Number(data.sale_price);
      const newTotal = newQty * newPrice;
      await conn.query(`UPDATE order_items SET quantity=?, sale_price=?, total_price=? WHERE id=?`, [newQty,newPrice,newTotal,itemId]);
      await InventoryService.adjustOrderItem(conn, old.product_id, Number(old.quantity), newQty);
      const [sumRows] = await conn.query(`SELECT COALESCE(SUM(total_price),0) total FROM order_items WHERE order_id=?`, [orderId]);
      const total = Number(sumRows[0].total);
      const [orderRows] = await conn.query(`SELECT paid_amount FROM orders WHERE id=?`, [orderId]);
      const paid = Number(orderRows[0].paid_amount||0);
      const debt = Math.max(0,total-paid);
      const status = paid<=0?'UNPAID':paid>=total?'PAID':'PARTIAL';
      await conn.query(`UPDATE orders SET total_amount=?,debt_amount=?,payment_status=? WHERE id=?`, [total,debt,status,orderId]);
      await conn.commit();
      return {message:'Đã sửa dòng bill'};
    } catch(e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }

  async printK80ByToken(token) {
    const order = await this.getByToken(token);
    const pad = (s,n)=>String(s).padEnd(n).slice(0,n);
    const money = n => Number(n||0).toLocaleString('vi-VN');
    const lines = [];
    lines.push('        MEATBIZ FOOD');
    lines.push('   PHIEU GIAO HANG / K80');
    lines.push('--------------------------------');
    lines.push(`Bill : ${order.order_code}`);
    lines.push(`Ngay : ${order.order_date}`);
    lines.push(`Khach: ${order.customer_name}`);
    lines.push('--------------------------------');
    for (const i of order.items) {
      lines.push(`${i.product_name}`);
      lines.push(`${String(i.quantity).padStart(6)}${pad(i.unit,3)} x ${money(i.sale_price).padStart(9)}`);
      lines.push(`${''.padStart(18)}= ${money(i.total_price).padStart(10)}`);
      if(i.inventory_mode==='NON_STOCK'||i.inventory_mode==='CARCASS_PART') lines.push('  * Hang pha loc/khong tru ton');
    }
    lines.push('--------------------------------');
    const pay=order.payment||{};
    const monthlyInstallment=Number(order.installment_amount||pay.installment_amount||order.monthly_installment?.installment_amount||0);
    const storedTotal=Number(order.total_amount||0);
    const rawCurrentBill=Number(order.current_bill_amount||0);
    // V6.51 K80 split fix: total_amount already includes Góp nợ/ngày.
    const payableTotal=storedTotal>0 ? storedTotal : (rawCurrentBill + monthlyInstallment);
    const todayBillTotal=monthlyInstallment>0
      ? (rawCurrentBill>0 && rawCurrentBill < payableTotal ? rawCurrentBill : Math.max(0,payableTotal-monthlyInstallment))
      : (rawCurrentBill || payableTotal);
    const cashAmount=Number(pay.cash_amount||0);
    const bankAmount=Number(pay.bank_amount||0);
    const remainingDebt=Number(order.debt_amount ?? Math.max(0,payableTotal-cashAmount-bankAmount));
    lines.push(`Bill hom nay: ${money(todayBillTotal).padStart(10)}`);
    if(monthlyInstallment>0) lines.push(`Gop no/ngay: ${money(monthlyInstallment).padStart(10)}`);
    lines.push(`Tong can TT: ${money(payableTotal).padStart(10)}`);
    lines.push(`Tien mat   : ${money(cashAmount).padStart(10)}`);
    lines.push(`Chuyen khoan:${money(bankAmount).padStart(9)}`);
    lines.push(`Con no     : ${money(remainingDebt).padStart(10)}`);
    if ((order.old_debts||[]).length) {
      lines.push('--------------------------------');
      lines.push('NO CU CHUA THANH TOAN');
      for (const d of order.old_debts) {
        lines.push(`${d.order_date} ${d.order_code}`);
        lines.push(`  Con no: ${money(d.debt_amount).padStart(18)}`);
      }
      lines.push(`Tong no cu: ${money(order.old_debt_total).padStart(12)}`);
      lines.push(`Tong can thu: ${money(Number(order.old_debt_total||0)+Number(order.debt_amount||0)).padStart(10)}`);
    }
    lines.push('--------------------------------');
    lines.push('Cam on quy khach!');
    return `<html><head><meta charset="utf-8"><style>@page{size:80mm auto;margin:2mm}body{font-family:Consolas,'Courier New',monospace;font-size:12px;width:76mm;white-space:pre-wrap;line-height:1.25}.print{position:fixed;top:5px;right:5px}@media print{.print{display:none}}</style></head><body><button class="print" onclick="window.print()">IN K80</button>${lines.join('\n')}<script>setTimeout(()=>window.print(),300)</script></body></html>`;
  }

  async printHtmlById(id) { return PrintService.billHtml(await this.get(id)); }
  async printHtmlByToken(token) { return PrintService.billHtml(await this.getByToken(token)); }
}
module.exports = new OrderAgent();