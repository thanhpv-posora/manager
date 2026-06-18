const pool = require('../config/db');
const { nanoid } = require('nanoid');
const { nextCode } = require('../utils/code');
const InventoryService = require('../services/InventoryService');
const PrintService = require('../services/PrintService');
const DebtMonthlyInstallmentAgent=require('./DebtMonthlyInstallmentAgent');
const { resolveBillSolarDate }=require('../utils/lunarDate');
const PriceBookService = require('../services/PriceBookService');
const { assertCustomerScope, customerScopeWhere }=require('../middleware/scope');

function parseLunarDateParts(text){
  const m=String(text||'').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if(!m)return null;
  return {day:Number(m[1]),month:Number(m[2]),year:Number(m[3])};
}


async function buildMissingPriceError(conn, customerId, billDate, missingIds) {
  const ids = [...new Set((missingIds || []).map(x => Number(x)).filter(Boolean))];
  let items = ids.map(id => ({ product_id: id, product_name: `ID ${id}` }));
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const [products] = await conn.query(
      `SELECT id, name FROM products WHERE id IN (${placeholders})`,
      ids
    );
    const names = new Map(products.map(p => [Number(p.id), p.name || `ID ${p.id}`]));
    items = ids.map(id => ({ product_id: id, product_name: names.get(id) || `ID ${id}` }));
  }
  const msg = items.length === 1
    ? `Khách chưa có giá cho mặt hàng ${items[0].product_name}. Vui lòng cập nhật bảng giá riêng trước khi lưu bill.`
    : `Khách chưa có giá cho ${items.length} mặt hàng: ${items.map(x => x.product_name).join(', ')}. Vui lòng cập nhật bảng giá riêng trước khi lưu bill.`;
  const err = new Error(msg);
  err.status = 400;
  err.statusCode = 400;
  err.code = 'PRICE_NOT_FOUND';
  err.details = { customer_id: customerId, bill_date: billDate, items };
  return err;
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
  constructor(){this.version='65.55.0';this.responsibility='Order POS blocks future shipping dates and uses shipping-date effective price book';}

  async ensureOrderEditable(conn, orderId) {
    const [rows] = await conn.query(`SELECT id,status,is_locked,locked_at,payment_status,customer_id FROM orders WHERE id=? FOR UPDATE`, [orderId]);
    if (!rows.length) throw new Error('Không tìm thấy bill');
    const o = rows[0];
    if (String(o.status || '').toUpperCase() === 'CANCELLED') throw new Error('Bill đã hủy, không thể sửa');
    if (Number(o.is_locked || 0) === 1 || o.locked_at) throw new Error('Bill đã chốt sổ, không thể sửa');
    const [allocs] = await conn.query(`SELECT COUNT(*) cnt FROM payment_allocations WHERE order_id=?`, [orderId]).catch(async e => { if (e && (e.code==='ER_NO_SUCH_TABLE'||e.errno===1146)) return [[{cnt:0}]]; throw e; });
    if (Number(allocs[0]?.cnt || 0) > 0) throw new Error('Bill đã có thu tiền/phân bổ, không thể sửa hàng. Hãy điều chỉnh bằng phiếu khác.');
    return o;
  }

  async lock(orderId, data={}, user={}) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query(`SELECT id,status,is_locked,locked_at FROM orders WHERE id=? FOR UPDATE`, [orderId]);
      if (!rows.length) throw new Error('Không tìm thấy bill');
      if (String(rows[0].status || '').toUpperCase() === 'CANCELLED') throw new Error('Bill đã hủy, không thể chốt');
      try {
        await conn.query(`UPDATE orders SET is_locked=1, locked_at=NOW(), locked_by=?, lock_note=? WHERE id=?`, [user?.id || null, data.note || data.lock_note || null, orderId]);
      } catch(e) {
        if (e && (e.code==='ER_BAD_FIELD_ERROR'||e.errno===1054)) throw new Error('Chưa chạy migration khóa bill V65.47');
        throw e;
      }
      await conn.commit();
      return {message:'Đã chốt sổ bill', order_id:Number(orderId)};
    } catch(e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }

  async loadLegacyDirectPayments(orderId) {
    const [rows] = await pool.query(
      `SELECT p.id payment_id, p.order_id, p.amount allocated_amount, 'LEGACY_DIRECT_PAYMENT' allocation_type,
              p.payment_code, p.payment_date, p.payment_method, p.cash_amount, p.bank_amount, p.amount payment_amount, p.note
       FROM payments p WHERE p.order_id=?
       ORDER BY p.payment_date ASC, p.id ASC`,
      [orderId]
    );
    return rows;
  }

  async loadOrderPaymentAllocations(orderId) {
    // V65.34: payment history must be shown per bill allocation, not by the payment row order_id only.
    // This keeps old debt payments understandable: money used to clear an older bill is printed on that old bill.
    try {
      try {
        const [rows] = await pool.query(
          `SELECT pa.id allocation_id, pa.payment_id, pa.order_id, pa.amount allocated_amount,
                  COALESCE(pa.cash_amount,0) allocation_cash_amount,
                  COALESCE(pa.bank_amount,0) allocation_bank_amount,
                  pa.allocation_type,
                  p.payment_code, p.payment_date, p.payment_method, p.cash_amount, p.bank_amount, p.amount payment_amount, p.note
           FROM payment_allocations pa
           JOIN payments p ON p.id=pa.payment_id
           WHERE pa.order_id=?
           ORDER BY p.payment_date ASC, p.id ASC, pa.id ASC`,
          [orderId]
        );
        if (rows.length) return rows;
        // V65.44: if allocation table exists but this bill was paid before allocation rows were introduced,
        // print the direct payment rows instead of showing an empty payment history.
        return await this.loadLegacyDirectPayments(orderId);
      } catch (e2) {
        if (!(e2 && (e2.code === 'ER_BAD_FIELD_ERROR' || e2.errno === 1054))) throw e2;
        const [rows] = await pool.query(
          `SELECT pa.id allocation_id, pa.payment_id, pa.order_id, pa.amount allocated_amount,
                  0 allocation_cash_amount, 0 allocation_bank_amount,
                  pa.allocation_type,
                  p.payment_code, p.payment_date, p.payment_method, p.cash_amount, p.bank_amount, p.amount payment_amount, p.note
           FROM payment_allocations pa
           JOIN payments p ON p.id=pa.payment_id
           WHERE pa.order_id=?
           ORDER BY p.payment_date ASC, p.id ASC, pa.id ASC`,
          [orderId]
        );
        if (rows.length) return rows;
        return await this.loadLegacyDirectPayments(orderId);
      }
    } catch (e) {
      if (!(e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146))) throw e;
return await this.loadLegacyDirectPayments(orderId);
    }
  }

  async list(user, query={}) {
    const where=[], params=[];
    if (user.role==='CUSTOMER') {
      const scope=await customerScopeWhere(user,'o.customer_id');
      where.push(scope.clause); params.push(...scope.params);
    }
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
    const order = orders[0];
    await assertCustomerScope(user, order.customer_id);
    const [items] = await pool.query(`SELECT * FROM order_items WHERE order_id=? ORDER BY id`, [id]);
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
    const payment_allocations = await this.loadOrderPaymentAllocations(order.id);
    const allocation_paid_total = payment_allocations.reduce((sum,x)=>sum+Number(x.allocated_amount||0),0);
    const payment_summary = { allocated_paid_total: allocation_paid_total, remaining_debt: Math.max(0, Number(order.total_amount||0)-allocation_paid_total) };
    return {...order, items, old_debts:oldDebts, old_debt_total:oldDebts.reduce((s,x)=>s+Number(x.debt_amount||0),0), monthly_installment, payment:payRows[0]||null, payment_allocations, payment_summary};
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
    const payment_allocations = await this.loadOrderPaymentAllocations(order.id);
    const allocation_paid_total = payment_allocations.reduce((sum,x)=>sum+Number(x.allocated_amount||0),0);
    const payment_summary = { allocated_paid_total: allocation_paid_total, remaining_debt: Math.max(0, Number(order.total_amount||0)-allocation_paid_total) };
    return {...order, items, old_debts:oldDebts, old_debt_total:oldDebts.reduce((s,x)=>s+Number(x.debt_amount||0),0), monthly_installment, payment:payRows[0]||null, payment_allocations, payment_summary};
  }

  async create(data, user) {
    if (!data.items || !data.items.length) throw new Error('Bill phải có ít nhất 1 mặt hàng');
    await assertCustomerScope(user, data.customer_id);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const code = await nextCode(conn,'orders','order_code','BILL');
      const safeCalendarType=data.calendar_type==='LUNAR'?'LUNAR':'SOLAR';
      const safeLunarDateText=safeCalendarType==='LUNAR'?(data.lunar_date_text||''):'';
      const billSolarDate=resolveBillSolarDate(safeCalendarType,data.order_date,safeLunarDateText);
      const todayIso = new Date(Date.now()+7*60*60*1000).toISOString().slice(0,10);
      if (String(billSolarDate||'').slice(0,10) > todayIso) {
        const err = new Error('Không thể tạo bill có ngày xuất hàng lớn hơn ngày hiện tại');
        err.statusCode = 400;
        err.code = 'FUTURE_BILL_DATE';
        err.details = { calendar_type: safeCalendarType, order_date: billSolarDate, lunar_date_text: safeLunarDateText, today: todayIso };
        throw err;
      }

      // V65.52 critical fix:
      // POS manual entry and Excel import must both use the price book effective at the bill shipping date.
      // Do NOT trust the sale_price already present in frontend items because it may come from the newest
      // customer catalog load, while Excel/bill date may be older (e.g. 08/01 AL must not use 01/02 AL price).
      const missingPriceProductIds = [];
      for (const it of data.items) {
        if (!it.product_id) continue;
        const isExplicitManual = it.manual_price === true || it.force_manual_price === true;
        if (!isExplicitManual) {
          const price = await PriceBookService.getEffectivePrice(data.customer_id, it.product_id, billSolarDate, conn, safeCalendarType, safeLunarDateText);
          if (!price || Number(price.sale_price)<=0) {
            missingPriceProductIds.push(it.product_id);
            continue;
          }
          it.sale_price = price.sale_price;
          it.price_type = price.price_type;
          it.price_book_id = price.price_book_id || null;
        } else if (!it.sale_price || Number(it.sale_price)<=0) {
          missingPriceProductIds.push(it.product_id);
        }
      }
      if (missingPriceProductIds.length) throw await buildMissingPriceError(conn, data.customer_id, billSolarDate, missingPriceProductIds);
      const itemTotal = data.items.reduce((s,it)=>s+Number(it.quantity||0)*Number(it.sale_price||0),0);
      // V6.51 critical fix: order total must include the effective daily installment.
      // Otherwise a bill paid only for today's items is incorrectly marked PAID and the installment debt disappears.
      const installmentAmount = Number(data.monthly_installment_amount ?? data.installment_amount ?? 0);
      const total = itemTotal + installmentAmount;
      const paid = 0; // V65.47: Bill không xử lý tiền. Tiền chỉ ghi ở menu Thu tiền.
      const debt = Math.max(0,total-paid);
      const pstatus = paid<=0?'UNPAID':paid>=total?'PAID':'PARTIAL';
      const [r] = await conn.query(
        `INSERT INTO orders(order_code,customer_id,order_date,delivery_date,status,payment_status,total_amount,paid_amount,debt_amount,private_token,note,created_by)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        [code,data.customer_id,billSolarDate,data.delivery_date||null,'DELIVERED',pstatus,total,paid,debt,nanoid(24),data.note||'',user.id]
      );
      
const orderId = r.insertId;
    // V6.51: persist bill calendar and installment fields so POS, payment, print, and reports use the same values.
    try{
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
        const inv = await InventoryService.out(conn,it.product_id,it.quantity,billSolarDate,'SALE',orderId,`Xuất bill ${code}`,user.id);
        try {
          await conn.query(
            `INSERT INTO order_items(order_id,product_id,product_name,unit,quantity,sale_price,total_price,price_type,price_book_id,note,inventory_mode,stock_checked)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
            [orderId,it.product_id,it.product_name,it.unit||'kg',it.quantity,it.sale_price,line,it.price_type||'MANUAL_PRICE',it.price_book_id||null,it.note||null,inv.inventory_mode,inv.stock_checked?1:0]
          );
        } catch (e) {
          // Backward compatibility if production DB has not run V65.44.1 migration yet.
          const safePriceType = (it.price_type === 'PRICE_BOOK') ? 'PRIVATE_PRICE' : (it.price_type || 'MANUAL_PRICE');
          await conn.query(
            `INSERT INTO order_items(order_id,product_id,product_name,unit,quantity,sale_price,total_price,price_type,note,inventory_mode,stock_checked)
             VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
            [orderId,it.product_id,it.product_name,it.unit||'kg',it.quantity,it.sale_price,line,safePriceType,it.note||null,inv.inventory_mode,inv.stock_checked?1:0]
          );
        }
      }
      if (debt > 0) {
        await conn.query(
          `INSERT INTO debt_transactions(customer_id,order_id,transaction_date,type,amount,note,created_by)
           VALUES(?,?,?,'SALE',?,?,?)`,
          [data.customer_id,orderId,billSolarDate,debt,`Công nợ bill ${code}`,user.id]
        );
      }

      // V65.38: if customer had unused paid money from older receipts, apply it automatically
      // to this newly-created bill by Ngày xuất hàng order. This prevents tiền dư from
      // becoming unmanaged when the next bill is created after the receipt was recorded.
      try {
        const PaymentAgent = require('./PaymentAgent');
        await PaymentAgent.allocateExistingCreditsToOpenBills(conn, data.customer_id, user.id);
      } catch (e) {
        // Do not block bill creation if the optional credit table has not been migrated yet.
        if (!(e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146))) throw e;
      }

      await conn.commit();
      return {message:'Đã tạo bill', order_id:orderId, order_code:code};
    } catch(e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }


  async recalcOrderTotals(conn, orderId) {
    const [sumRows] = await conn.query(`SELECT COALESCE(SUM(total_price),0) total FROM order_items WHERE order_id=?`, [orderId]);
    const itemTotal = Number(sumRows[0].total || 0);
    const [orderRows] = await conn.query(`SELECT paid_amount, installment_amount FROM orders WHERE id=? FOR UPDATE`, [orderId]);
    const paid = Number(orderRows[0]?.paid_amount || 0);
    const installmentAmount = Number(orderRows[0]?.installment_amount || 0);
    const total = itemTotal + installmentAmount;
    const debt = Math.max(0, total - paid);
    const status = paid <= 0 ? 'UNPAID' : paid >= total ? 'PAID' : 'PARTIAL';
    await conn.query(
      `UPDATE orders SET current_bill_amount=?, total_amount=?, debt_amount=?, payment_status=? WHERE id=?`,
      [itemTotal, total, debt, status, orderId]
    );
    return { item_total:itemTotal, total_amount:total, debt_amount:debt, payment_status:status };
  }

  async resolveAddItemProduct(conn, order, data) {
    const productId = Number(data.product_id || 0);
    if (productId > 0) {
      const [rows] = await conn.query(
        `SELECT p.id product_id,p.name product_name,p.unit,p.default_sale_price,p.inventory_mode,p.allow_negative_stock,
                COALESCE(cpp.sale_price,p.default_sale_price,0) sale_price,
                CASE WHEN cpp.sale_price IS NOT NULL THEN 'PRIVATE_PRICE' ELSE 'COMMON_PRICE' END price_type
         FROM products p
         LEFT JOIN customer_product_prices cpp ON cpp.product_id=p.id AND cpp.customer_id=? AND cpp.is_active=1
         WHERE p.id=? AND p.del_flg=0 AND p.is_active=1 LIMIT 1`,
        [order.customer_id, productId]
      );
      if(!rows.length) throw new Error('Không tìm thấy mặt hàng đã chọn');
      const price = await PriceBookService.getEffectivePrice(order.customer_id, productId, order.order_date, conn, order.calendar_type, order.lunar_date_text);
      if(price){ rows[0].sale_price=price.sale_price; rows[0].price_type=price.price_type; rows[0].price_book_id=price.price_book_id || null; }
      return rows[0];
    }

    const name = String(data.product_name || data.name || '').trim();
    if(!name) throw new Error('Thiếu tên mặt hàng cần thêm');

    const [exists] = await conn.query(
      `SELECT p.id product_id,p.name product_name,p.unit,p.default_sale_price,p.inventory_mode,p.allow_negative_stock,
              COALESCE(cpp.sale_price,p.default_sale_price,0) sale_price,
              CASE WHEN cpp.sale_price IS NOT NULL THEN 'PRIVATE_PRICE' ELSE 'COMMON_PRICE' END price_type
       FROM products p
       LEFT JOIN customer_product_prices cpp ON cpp.product_id=p.id AND cpp.customer_id=? AND cpp.is_active=1
       WHERE p.del_flg=0 AND p.is_active=1 AND LOWER(TRIM(p.name))=LOWER(TRIM(?)) LIMIT 1`,
      [order.customer_id, name]
    );
    if(exists.length) {
      const price = await PriceBookService.getEffectivePrice(order.customer_id, exists[0].product_id, order.order_date, conn, order.calendar_type, order.lunar_date_text);
      if(price){ exists[0].sale_price=price.sale_price; exists[0].price_type=price.price_type; exists[0].price_book_id=price.price_book_id || null; }
      return exists[0];
    }

    const salePrice = Number(data.sale_price || data.price || 0);
    if(!(salePrice > 0)) throw new Error('Mặt hàng mới cần nhập giá bán');
    const code = 'QK' + Date.now().toString().slice(-10);
    const unit = data.unit || 'kg';
    const [r] = await conn.query(
      `INSERT INTO products(category_id,product_code,name,unit,default_sale_price,default_purchase_price,stock_quantity,low_stock_threshold,note,is_active,del_flg,inventory_mode,allow_negative_stock)
       VALUES(NULL,?,?,?,?,0,0,5,'Tạo nhanh từ sửa bill',1,0,?,1)`,
      [code, name, unit, salePrice, data.inventory_mode || 'CARCASS_PART']
    );
    const newId = r.insertId;
    try{
      await conn.query(
        `INSERT INTO customer_product_catalogs(customer_id,product_id,sort_order,is_default,is_active,del_flg)
         VALUES(?,?,999,1,1,0)
         ON DUPLICATE KEY UPDATE is_default=1,is_active=1,del_flg=0`,
        [order.customer_id, newId]
      );
      await conn.query(
        `INSERT INTO customer_product_prices(customer_id,product_id,sale_price,effective_from,is_active)
         VALUES(?,?,?,CURDATE(),1)`,
        [order.customer_id, newId, salePrice]
      );
    }catch(e){}
    return {product_id:newId, product_name:name, unit, sale_price:salePrice, price_type:'MANUAL_PRICE', inventory_mode:data.inventory_mode || 'CARCASS_PART', allow_negative_stock:1};
  }

  async addItem(orderId, data, user={}) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [orders] = await conn.query(`SELECT * FROM orders WHERE id=? FOR UPDATE`, [orderId]);
      if(!orders.length) throw new Error('Không tìm thấy bill');
      const order = orders[0];
      if(order.status === 'CANCELLED') throw new Error('Bill đã hủy, không thể thêm hàng');
      await assertCustomerScope(user, order.customer_id);
      await this.ensureOrderEditable(conn, orderId);

      const p = await this.resolveAddItemProduct(conn, order, data);
      const qty = Number(data.quantity || data.qty || 0);
      if(!(qty > 0)) throw new Error('Số lượng phải lớn hơn 0');
      const salePrice = Number(data.sale_price || data.price || p.sale_price || 0);
      if(!(salePrice >= 0)) throw new Error('Giá bán không hợp lệ');
      const line = qty * salePrice;
      const inv = await InventoryService.out(conn, p.product_id, qty, order.order_date, 'SALE', orderId, `Thêm hàng vào bill ${order.order_code}`, user.id || order.created_by || null);
      try {
        await conn.query(
          `INSERT INTO order_items(order_id,product_id,product_name,unit,quantity,sale_price,total_price,price_type,price_book_id,note,inventory_mode,stock_checked)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          [orderId, p.product_id, p.product_name, p.unit || data.unit || 'kg', qty, salePrice, line, data.price_type || p.price_type || 'MANUAL_PRICE', data.price_book_id || p.price_book_id || null, data.note || null, inv.inventory_mode, inv.stock_checked?1:0]
        );
      } catch (e) {
        const rawPriceType = data.price_type || p.price_type || 'MANUAL_PRICE';
        const safePriceType = rawPriceType === 'PRICE_BOOK' ? 'PRIVATE_PRICE' : rawPriceType;
        await conn.query(
          `INSERT INTO order_items(order_id,product_id,product_name,unit,quantity,sale_price,total_price,price_type,note,inventory_mode,stock_checked)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          [orderId, p.product_id, p.product_name, p.unit || data.unit || 'kg', qty, salePrice, line, safePriceType, data.note || null, inv.inventory_mode, inv.stock_checked?1:0]
        );
      }
      const totals = await this.recalcOrderTotals(conn, orderId);
      await conn.commit();
      return {message:'Đã thêm mặt hàng vào bill', ...totals};
    } catch(e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }

  async updateItem(orderId, itemId, data, user={}) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const o = await this.ensureOrderEditable(conn, orderId);
      await assertCustomerScope(user, o.customer_id);
      const [items] = await conn.query(`SELECT * FROM order_items WHERE id=? AND order_id=? FOR UPDATE`, [itemId,orderId]);
      if (!items.length) throw new Error('Không tìm thấy dòng bill');
      const old = items[0];
      const newQty = Number(data.quantity);
      const newPrice = Number(data.sale_price);
      const newTotal = newQty * newPrice;
      await conn.query(`UPDATE order_items SET quantity=?, sale_price=?, total_price=? WHERE id=?`, [newQty,newPrice,newTotal,itemId]);
      await InventoryService.adjustOrderItem(conn, old.product_id, Number(old.quantity), newQty);
      await this.recalcOrderTotals(conn, orderId);
      await conn.commit();
      return {message:'Đã sửa dòng bill'};
    } catch(e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }

  async printK80ByToken(token) {
    // V65.35: K80 must use the same professional payment-allocation summary as A4,
    // including separated cash/bank amounts per bill allocation.
    return PrintService.billK80Html(await this.getByToken(token));
  }

  async printHtmlById(id, user) { return PrintService.billHtml(await this.get(id, user)); }
  async printHtmlByToken(token) { return PrintService.billHtml(await this.getByToken(token)); }
}
module.exports = new OrderAgent();