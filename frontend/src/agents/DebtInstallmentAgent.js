const pool=require('../config/db');

class DebtInstallmentAgent {
  constructor(){this.version='6.20.0';this.responsibility='Real debt engine: target debt, paid, remaining, daily installment and bill display';}

  async customerDebt(customerId){
    const [rows]=await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN type IN ('SALE','ADJUSTMENT_INCREASE') THEN amount WHEN type IN ('PAYMENT','ADJUSTMENT_DECREASE') THEN -amount ELSE 0 END),0) current_debt
       FROM debt_transactions WHERE customer_id=?`,[customerId]);
    return Number(rows[0]?.current_debt||0);
  }

  async list(customerId){
    const params=[]; let where='WHERE 1=1';
    if(customerId){where+=' AND p.customer_id=?';params.push(customerId);}
    const [rows]=await pool.query(
      `SELECT p.*,c.name customer_name,COALESCE(SUM(ip.amount),0) paid_amount
       FROM debt_installment_plans p JOIN customers c ON c.id=p.customer_id
       LEFT JOIN debt_installment_payments ip ON ip.plan_id=p.id
       ${where} GROUP BY p.id ORDER BY p.status='ACTIVE' DESC,p.start_date DESC,p.id DESC`,params);
    return rows.map(r=>{
      const target=Number(r.target_debt_amount||0), paid=Number(r.paid_amount||0);
      const remain=Math.max(0,target-paid);
      return {...r,remaining_amount:remain,estimated_days_left:r.daily_amount>0?Math.ceil(remain/Number(r.daily_amount)):0,progress_percent:target>0?Math.min(100,Math.round(paid/target*100)):0};
    });
  }

  async create(data,user){
    if(!data.customer_id) throw new Error('Thiếu khách hàng');
    if(!data.daily_amount || Number(data.daily_amount)<=0) throw new Error('Số tiền góp/ngày phải lớn hơn 0');
    const currentDebt=await this.customerDebt(data.customer_id);
    const target=Number(data.target_debt_amount||currentDebt||0);
    await pool.query(
      `INSERT INTO debt_installment_plans(customer_id,plan_name,daily_amount,start_date,end_date,status,note,target_debt_amount,created_by)
       VALUES(?,?,?,?,?,'ACTIVE',?,?,?)`,
      [data.customer_id,data.plan_name||'Trả góp công nợ hằng ngày',data.daily_amount,data.start_date,data.end_date||null,data.note||'',target,user?.id||null]);
    return {message:'Đã tạo kế hoạch trả góp công nợ',target_debt_amount:target};
  }

  async update(id,data){
    await pool.query(
      `UPDATE debt_installment_plans SET plan_name=?,daily_amount=?,start_date=?,end_date=?,status=?,note=?,target_debt_amount=? WHERE id=?`,
      [data.plan_name||'Trả góp công nợ hằng ngày',data.daily_amount||0,data.start_date,data.end_date||null,data.status||'ACTIVE',data.note||'',data.target_debt_amount||0,id]);
    return {message:'Đã cập nhật kế hoạch trả góp'};
  }

  async addPayment(planId,data,user){
    const [plans]=await pool.query(`SELECT * FROM debt_installment_plans WHERE id=?`,[planId]);
    if(!plans.length) throw new Error('Không tìm thấy kế hoạch trả góp');
    const plan=plans[0];
    const cashAmount=Number(data.cash_amount||0);
    const bankAmount=Number(data.bank_amount||0);
    const splitTotal=cashAmount+bankAmount;
    const amount=splitTotal>0?splitTotal:Number(data.amount||plan.daily_amount||0);
    if(amount<=0) throw new Error('Số tiền thu phải lớn hơn 0');
    const method=(cashAmount>0&&bankAmount>0)?'MIXED':(cashAmount>0?'CASH':(bankAmount>0?'BANK_TRANSFER':(data.payment_method||'CASH')));
    const conn=await pool.getConnection();
    try{
      await conn.beginTransaction();
      const [r]=await conn.query(`INSERT INTO payments(customer_id,order_id,payment_date,amount,payment_method,cash_amount,bank_amount,current_bill_amount,installment_amount,note,created_by) VALUES(?,NULL,?,?,?,?,?,?,?,?,?)`,
        [plan.customer_id,data.payment_date,amount,method,cashAmount,bankAmount,0,amount,data.note||`Thu góp công nợ #${planId}`,user?.id||null]);
      await conn.query(`INSERT INTO debt_transactions(customer_id,order_id,payment_id,transaction_date,type,amount,note,created_by) VALUES(?,NULL,? ,?,'PAYMENT',?,?,?)`,
        [plan.customer_id,r.insertId,data.payment_date,amount,data.note||`Thu góp công nợ #${planId}`,user?.id||null]);
      await conn.query(`INSERT INTO debt_installment_payments(plan_id,customer_id,payment_id,payment_date,amount,payment_method,cash_amount,bank_amount,note,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        [planId,plan.customer_id,r.insertId,data.payment_date,amount,method,cashAmount,bankAmount,data.note||'',user?.id||null]);
      await conn.commit(); return {message:'Đã ghi nhận tiền góp công nợ'};
    }catch(e){await conn.rollback();throw e;}finally{conn.release();}
  }

  async cancel(id, reason){
    await pool.query(
      `UPDATE debt_installment_plans SET status='CANCELLED', note=CONCAT(COALESCE(note,''),'\nHủy: ',?) WHERE id=?`,
      [reason||'', id]
    );
    return {message:'Đã hủy kế hoạch góp nợ'};
  }

  async payments(planId){const [rows]=await pool.query(`SELECT * FROM debt_installment_payments WHERE plan_id=? ORDER BY payment_date DESC,id DESC`,[planId]);return rows;}

  async summaryForBill(customerId,orderDate){
    const [plans]=await pool.query(`SELECT p.*,COALESCE(SUM(ip.amount),0) paid_amount FROM debt_installment_plans p LEFT JOIN debt_installment_payments ip ON ip.plan_id=p.id WHERE p.customer_id=? AND p.status='ACTIVE' GROUP BY p.id ORDER BY p.start_date ASC,p.id ASC`,[customerId]);
    if(!plans.length)return null;
    const [recentPayments]=await pool.query(`SELECT * FROM debt_installment_payments WHERE customer_id=? AND payment_date<=? ORDER BY payment_date DESC,id DESC LIMIT 10`,[customerId,orderDate]);
    const [todayPayments]=await pool.query(`SELECT plan_id,COALESCE(SUM(amount),0) paid_today FROM debt_installment_payments WHERE customer_id=? AND payment_date=? GROUP BY plan_id`,[customerId,orderDate]);
    const todayMap={};
    for(const p of todayPayments) todayMap[p.plan_id]=Number(p.paid_today||0);

    const mapped=plans.map(p=>{
      const target=Number(p.target_debt_amount||0);
      const paid=Number(p.paid_amount||0);
      const remaining=Math.max(0,target-paid);
      const paidToday=Number(todayMap[p.id]||0);
      const dueToday=Math.max(0,Number(p.daily_amount||0)-paidToday);
      return {...p,remaining_amount:remaining,paid_today:paidToday,due_today:dueToday,progress_percent:target>0?Math.min(100,Math.round(paid/target*100)):0};
    });
    return {
      plans:mapped,
      daily_total:mapped.reduce((s,p)=>s+Number(p.daily_amount||0),0),
      paid_total:mapped.reduce((s,p)=>s+Number(p.paid_amount||0),0),
      target_total:mapped.reduce((s,p)=>s+Number(p.target_debt_amount||0),0),
      remaining_total:mapped.reduce((s,p)=>s+Number(p.remaining_amount||0),0),
      due_today_total:mapped.reduce((s,p)=>s+Number(p.due_today||0),0),
      recent_payments:recentPayments
    };
  }
}
module.exports=new DebtInstallmentAgent();
