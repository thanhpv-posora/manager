const pool = require('../config/db');
const { nextCode } = require('../utils/code');

class PaymentAgent {
  async list(user, query={}) {
    const where=[], params=[];
    if (user.role==='CUSTOMER') { where.push('p.customer_id=?'); params.push(user.customer_id); }
    if (query.from_date || query.from) { where.push('DATE(p.payment_date)>=?'); params.push(String(query.from_date||query.from).slice(0,10)); }
    if (query.to_date || query.to) { where.push('DATE(p.payment_date)<=?'); params.push(String(query.to_date||query.to).slice(0,10)); }
    if (query.customer_name || query.customer) { where.push('c.name LIKE ?'); params.push('%'+String(query.customer_name||query.customer).trim()+'%'); }
    const [rows]=await pool.query(
      `SELECT p.*,c.name customer_name,o.order_code FROM payments p JOIN customers c ON c.id=p.customer_id
       LEFT JOIN orders o ON o.id=p.order_id ${where.length?'WHERE '+where.join(' AND '):''}
       ORDER BY p.payment_date DESC,p.id DESC`, params);
    return rows;
  }

  async summary(customerId, user) {
    if (user.role==='CUSTOMER' && Number(user.customer_id)!==Number(customerId)) throw new Error('Không có quyền');
    const [customers]=await pool.query(`SELECT id,name,phone,address FROM customers WHERE id=?`, [customerId]);
    if (!customers.length) throw new Error('Không tìm thấy khách');
    const [debtRows]=await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN type IN ('SALE','ADJUSTMENT_INCREASE') THEN amount WHEN type IN ('PAYMENT','ADJUSTMENT_DECREASE') THEN -amount ELSE 0 END),0) current_debt
       FROM debt_transactions WHERE customer_id=?`, [customerId]);
    const [unpaid]=await pool.query(
      `SELECT id,order_code,order_date,total_amount,paid_amount,debt_amount,payment_status,calendar_type,lunar_date_text,current_bill_amount,installment_amount,monthly_installment_id FROM orders
       WHERE customer_id=? AND status<>'CANCELLED' AND debt_amount>0 ORDER BY order_date ASC,id ASC`, [customerId]);
    const [split]=await pool.query(`SELECT payment_method,COALESCE(SUM(amount),0) total FROM payments WHERE customer_id=? GROUP BY payment_method`, [customerId]);
    const [cashBank]=await pool.query(`SELECT COALESCE(SUM(cash_amount),0) cash_total,COALESCE(SUM(bank_amount),0) bank_total,COALESCE(SUM(current_bill_amount),0) current_bill_total,COALESCE(SUM(installment_amount),0) installment_total FROM payments WHERE customer_id=?`, [customerId]);
    const [recent]=await pool.query(`SELECT p.*,o.order_code FROM payments p LEFT JOIN orders o ON o.id=p.order_id WHERE p.customer_id=? ORDER BY p.payment_date DESC,p.id DESC LIMIT 20`, [customerId]);
    return {customer:customers[0], current_debt:debtRows[0].current_debt, unpaid_orders:unpaid, payment_split:split, cash_bank_summary:cashBank[0], recent_payments:recent};
  }

  async applyPaymentToOrder(conn, orderId, amount) {
    const [orders]=await conn.query(`SELECT total_amount,paid_amount,debt_amount FROM orders WHERE id=? FOR UPDATE`, [orderId]);
    if (!orders.length) return 0;
    const order=orders[0];
    const pay=Math.min(Number(amount||0), Number(order.debt_amount||0));
    const newPaid=Number(order.paid_amount||0)+pay;
    const total=Number(order.total_amount||0);
    const debt=Math.max(0,total-newPaid);
    const status=debt<=0?'PAID':newPaid>0?'PARTIAL':'UNPAID';
    await conn.query(`UPDATE orders SET paid_amount=?,debt_amount=?,payment_status=? WHERE id=?`, [Math.min(newPaid,total),debt,status,orderId]);
    return pay;
  }

  async allocate(conn, customerId, amount, excludeOrderId=null) {
    let remaining=Number(amount||0);
    const allocations=[];
    const params=[customerId];
    let extra='';
    if(excludeOrderId){ extra=' AND id<>?'; params.push(excludeOrderId); }
    const [orders]=await conn.query(
      `SELECT id,order_code,debt_amount FROM orders WHERE customer_id=? AND status<>'CANCELLED' AND debt_amount>0 ${extra} ORDER BY order_date ASC,id ASC FOR UPDATE`,
      params
    );
    for (const o of orders) {
      if (remaining<=0) break;
      const pay=Math.min(remaining, Number(o.debt_amount||0));
      const applied=await this.applyPaymentToOrder(conn,o.id,pay);
      if (applied>0) { remaining-=applied; allocations.push(`${o.order_code}:${applied}`); }
    }
    return allocations.join(', ');
  }

  async ensureOrderPayableTotal(conn, orderId, customerId, paymentDate, currentBillAmount, installmentAmount, monthlyInstallmentId, userId) {
    if (!orderId) return;
    const bill = Number(currentBillAmount || 0);
    const installment = Number(installmentAmount || 0);
    if (bill <= 0 && installment <= 0) return;

    const [orders] = await conn.query(
      `SELECT id,total_amount,paid_amount,debt_amount,current_bill_amount,installment_amount,monthly_installment_id
       FROM orders WHERE id=? FOR UPDATE`,
      [orderId]
    );
    if (!orders.length) return;

    const order = orders[0];
    const existingCurrentBill = Number(order.current_bill_amount || 0);
    const baseBill = bill > 0 ? bill : (existingCurrentBill > 0 ? existingCurrentBill : Number(order.total_amount || 0));
    const targetTotal = baseBill + installment;
    const oldTotal = Number(order.total_amount || 0);
    const paid = Number(order.paid_amount || 0);
    const newDebt = Math.max(0, targetTotal - paid);
    const status = newDebt <= 0 ? 'PAID' : paid > 0 ? 'PARTIAL' : 'UNPAID';

    try {
      await conn.query(
        `UPDATE orders
         SET total_amount=?, debt_amount=?, payment_status=?, current_bill_amount=?, installment_amount=?, monthly_installment_id=?
         WHERE id=?`,
        [targetTotal, newDebt, status, baseBill, installment, monthlyInstallmentId || null, orderId]
      );
    } catch (e) {
      await conn.query(
        `UPDATE orders SET total_amount=?, debt_amount=?, payment_status=? WHERE id=?`,
        [targetTotal, newDebt, status, orderId]
      );
    }

    const diff = targetTotal - oldTotal;
    if (diff > 0) {
      await conn.query(
        `INSERT INTO debt_transactions(customer_id,order_id,transaction_date,type,amount,note,created_by)
         VALUES(?,?,?,'ADJUSTMENT_INCREASE',?,?,?)`,
        [customerId, orderId, paymentDate, diff, `Bổ sung góp nợ/ngày vào bill`, userId]
      );
    }
  }

  async create(data, user) {
    const cashAmount=Number(data.cash_amount||0);
    const bankAmount=Number(data.bank_amount||0);
    const paidTotal=cashAmount+bankAmount;
    const explicitAmount=Number(data.amount||0);
    const amount=paidTotal>0 ? paidTotal : (explicitAmount>0 ? explicitAmount : 0);

    if (!data.customer_id || amount<=0) throw new Error('Thiếu khách hoặc số tiền thu không hợp lệ');

    const conn=await pool.getConnection();
    try {
      await conn.beginTransaction();
      const code=await nextCode(conn,'payments','payment_code','PAY');
      let note=data.note||'';

      let currentBillAmount=Number(data.current_bill_amount||0);
      let plannedInstallmentAmount=Number(data.monthly_installment_amount ?? data.installment_amount ?? 0);
      let monthlyInstallmentId=Number(data.monthly_installment_id||0)||null;
      let paymentCalendarType=(data.payment_calendar_type||data.calendar_type||'SOLAR')==='LUNAR'?'LUNAR':'SOLAR';
      let paymentLunarDateText=data.payment_lunar_date_text||data.lunar_date_text||'';
      let paidBefore=0;
      let orderDebtBefore=0;

      // V6.51.11 final critical fix:
      // Backend must derive installment fields from the order when the UI sends 0.
      // This fixes Thu tiền screen and POS/statistics even if frontend payload is incomplete.
      if(data.order_id){
        const [orders]=await conn.query(
          `SELECT id,total_amount,paid_amount,debt_amount,current_bill_amount,installment_amount,monthly_installment_id,calendar_type,lunar_date_text
           FROM orders WHERE id=? FOR UPDATE`,
          [data.order_id]
        );
        if(orders.length){
          const order=orders[0];
          paidBefore=Number(order.paid_amount||0);
          orderDebtBefore=Number(order.debt_amount||0);
          const orderInstallment=Number(order.installment_amount||0);
          const orderCurrentBill=Number(order.current_bill_amount||0)>0
            ? Number(order.current_bill_amount||0)
            : Math.max(0, Number(order.total_amount||0)-orderInstallment);

          // If caller did not send bill/installment, trust the order as source of truth.
          if(currentBillAmount<=0 || plannedInstallmentAmount<=0){
            currentBillAmount=orderCurrentBill;
            plannedInstallmentAmount=orderInstallment;
          }
          if(!monthlyInstallmentId && order.monthly_installment_id){
            monthlyInstallmentId=Number(order.monthly_installment_id)||null;
          }
          paymentCalendarType=order.calendar_type==='LUNAR'?'LUNAR':paymentCalendarType;
          paymentLunarDateText=order.lunar_date_text||paymentLunarDateText;

          // Ensure old orders have correct total/debt before applying payment.
          await this.ensureOrderPayableTotal(
            conn,
            data.order_id,
            data.customer_id,
            data.payment_date,
            currentBillAmount,
            plannedInstallmentAmount,
            monthlyInstallmentId,
            user.id
          );
        }
      }

      const payableTotal=currentBillAmount+plannedInstallmentAmount;
      const remainingDebt=Math.max(0,(payableTotal>0?payableTotal:amount)-amount);

      // Calculate REAL installment amount included in this payment.
      // Product bill is paid first; money above remaining product bill counts as installment paid.
      const explicitInstallmentPaid=Number(
        data.installment_paid_amount ??
        data.paid_installment_amount ??
        data.actual_installment_amount ??
        0
      );
      let installmentPaid=0;
      if(plannedInstallmentAmount>0){
        if(explicitInstallmentPaid>0){
          installmentPaid=Math.min(plannedInstallmentAmount, explicitInstallmentPaid);
        }else{
          const productPaidBefore=Math.min(paidBefore, currentBillAmount);
          const remainingProductBill=Math.max(0, currentBillAmount-productPaidBefore);
          const installmentPaidBefore=Math.max(0, paidBefore-currentBillAmount);
          const remainingInstallment=Math.max(0, plannedInstallmentAmount-installmentPaidBefore);
          installmentPaid=Math.max(0, Math.min(remainingInstallment, amount-remainingProductBill));
        }
      }

      if(installmentPaid>0){
        note = note ? `${note} / Góp nợ/ngày đã thu: ${installmentPaid}` : `Góp nợ/ngày đã thu: ${installmentPaid}`;
      }

      let billApplied=0;
      let remainingPaid=amount;
      if(data.order_id){
        // Apply total money to the order debt. The order total already includes installment.
        const orderPayLimit=orderDebtBefore>0 ? Math.min(remainingPaid, orderDebtBefore) : remainingPaid;
        if(orderPayLimit>0){
          billApplied=await this.applyPaymentToOrder(conn,data.order_id,orderPayLimit);
          remainingPaid=Math.max(0,remainingPaid-billApplied);
        }
      }

      if(!data.order_id && remainingPaid>0){
        const alloc=await this.allocate(conn,data.customer_id,remainingPaid);
        note = note || alloc;
      }

      const method=(cashAmount>0 && bankAmount>0) ? 'MIXED' : (cashAmount>0?'CASH':(bankAmount>0?'BANK_TRANSFER':(data.payment_method||'CASH')));

      let insertId;
      try{
        const [r]=await conn.query(
          `INSERT INTO payments(payment_code,customer_id,order_id,payment_date,amount,payment_method,cash_amount,bank_amount,current_bill_amount,installment_amount,monthly_installment_id,payment_calendar_type,payment_lunar_date_text,note,created_by)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [code,data.customer_id,data.order_id||null,data.payment_date,amount,method,cashAmount,bankAmount,currentBillAmount||0,installmentPaid,monthlyInstallmentId,paymentCalendarType,paymentLunarDateText||null,note,user.id]
        );
        insertId=r.insertId;
      }catch(e){
        // Backward compatible fallback when optional calendar columns are not migrated yet.
        const [r]=await conn.query(
          `INSERT INTO payments(payment_code,customer_id,order_id,payment_date,amount,payment_method,cash_amount,bank_amount,current_bill_amount,installment_amount,monthly_installment_id,note,created_by)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [code,data.customer_id,data.order_id||null,data.payment_date,amount,method,cashAmount,bankAmount,currentBillAmount||0,installmentPaid,monthlyInstallmentId,note,user.id]
        );
        insertId=r.insertId;
      }

      await conn.query(
        `INSERT INTO debt_transactions(customer_id,order_id,payment_id,transaction_date,type,amount,note,created_by)
         VALUES(?,?,?,?, 'PAYMENT', ?, ?, ?)`,
        [data.customer_id,data.order_id||null,insertId,data.payment_date,amount,note||`Thu tiền ${code}`,user.id]
      );

      if(Number(data.installment_plan_id||0)>0 && installmentPaid>0){
        await conn.query(
          `INSERT INTO debt_installment_payments(plan_id,customer_id,payment_id,payment_date,amount,payment_method,cash_amount,bank_amount,note,created_by)
           VALUES(?,?,?,?,?,?,?,?,?,?)`,
          [data.installment_plan_id,data.customer_id,insertId,data.payment_date,installmentPaid,method,cashAmount,bankAmount,note||'',user.id]
        );
      }

      await conn.commit();
      return {
        message:'Đã thu tiền và cập nhật công nợ',
        payment_code:code,
        amount,
        cash_amount:cashAmount,
        bank_amount:bankAmount,
        today_bill_total:currentBillAmount,
        monthly_installment_amount:plannedInstallmentAmount,
        payable_total:payableTotal,
        paid_total:amount,
        remaining_debt:remainingDebt,
        current_bill_amount:currentBillAmount||billApplied,
        installment_amount:installmentPaid,
        planned_installment_amount:plannedInstallmentAmount,
        installment_paid:installmentPaid,
        payment_calendar_type:paymentCalendarType,
        payment_lunar_date_text:paymentLunarDateText,
        allocation_note:note,
        monthly_installment_id:monthlyInstallmentId
      };
    } catch(e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }
}
module.exports = new PaymentAgent();
