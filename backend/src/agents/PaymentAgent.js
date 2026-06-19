const pool = require('../config/db');
const { nextCode } = require('../utils/code');
const { assertCustomerScope, customerScopeWhere }=require('../middleware/scope');

class PaymentAgent {
  async transactionStatus(key) {
    if (!key) throw new Error('Thiếu mã giao dịch');
    const [rows] = await pool.query(
      `SELECT idempotency_key,status,response_json,error_message,created_at,updated_at
       FROM payment_transaction_requests WHERE idempotency_key=? LIMIT 1`,
      [key]
    );
    if (!rows.length) return { idempotency_key:key, status:'NOT_FOUND' };
    const row = rows[0];
    let response = null;
    try { response = row.response_json ? JSON.parse(row.response_json) : null; } catch (_) {}
    return { ...row, response_json: undefined, response };
  }

  async list(user, query={}) {
    const where=[], params=[];
    if (user.role==='CUSTOMER') {
      const scope=await customerScopeWhere(user,'p.customer_id');
      where.push(scope.clause); params.push(...scope.params);
    }
    if (query.from_date || query.from) { where.push('DATE(p.payment_date)>=?'); params.push(String(query.from_date||query.from).slice(0,10)); }
    if (query.to_date || query.to) { where.push('DATE(p.payment_date)<=?'); params.push(String(query.to_date||query.to).slice(0,10)); }
    if (query.customer_name || query.customer) { where.push('c.name LIKE ?'); params.push('%'+String(query.customer_name||query.customer).trim()+'%'); }
    const [rows]=await pool.query(
      `SELECT p.*,c.name customer_name,o.order_code FROM payments p JOIN customers c ON c.id=p.customer_id
       LEFT JOIN orders o ON o.id=p.order_id ${where.length?'WHERE '+where.join(' AND '):''}
       ORDER BY p.payment_date DESC,p.id DESC`, params);

    // V65.42: enrich each real receipt with allocation details so customer-bill reports
    // can show exactly how much cash/bank the customer gave each time and which bills
    // that receipt was allocated to. Keep this backward compatible if the allocation
    // table has not been migrated yet.
    const paymentIds = rows.map(r=>Number(r.id)).filter(Boolean);
    if (paymentIds.length) {
      try {
        const placeholders = paymentIds.map(()=>'?').join(',');
        const [allocRows] = await pool.query(
          `SELECT pa.payment_id, pa.order_id, o.order_code, o.order_date,
                  pa.amount amount,
                  COALESCE(pa.cash_amount,0) cash_amount,
                  COALESCE(pa.bank_amount,0) bank_amount,
                  pa.allocation_type
           FROM payment_allocations pa
           LEFT JOIN orders o ON o.id=pa.order_id
           WHERE pa.payment_id IN (${placeholders})
           ORDER BY o.order_date ASC,o.id ASC,pa.id ASC`,
          paymentIds
        );
        const map = new Map();
        for (const a of allocRows) {
          const pid=Number(a.payment_id);
          if(!map.has(pid)) map.set(pid,[]);
          map.get(pid).push(a);
        }
        for (const r of rows) {
          const allocs = map.get(Number(r.id)) || [];
          r.allocations = allocs;
          r.allocation_text = allocs.length
            ? allocs.map(a=>`${a.order_code||('#'+a.order_id)}: ${Number(a.amount||0).toLocaleString('en-US')}đ`).join('; ')
            : (r.order_code ? `${r.order_code}: ${Number(r.amount||0).toLocaleString('en-US')}đ` : 'Chưa phân bổ');
          r.allocated_total = allocs.reduce((sum,a)=>sum+Number(a.amount||0),0);
        }
      } catch(e) {
        if (!(e && (e.code==='ER_NO_SUCH_TABLE' || e.errno===1146 || e.code==='ER_BAD_FIELD_ERROR' || e.errno===1054))) throw e;
        for (const r of rows) {
          r.allocations = [];
          r.allocation_text = r.order_code ? `${r.order_code}: ${Number(r.amount||0).toLocaleString('en-US')}đ` : 'Chưa phân bổ';
          r.allocated_total = Number(r.amount||0);
        }
      }
    }
    return rows;
  }

  async summary(customerId, user) {
    await assertCustomerScope(user, customerId);
    const [customers]=await pool.query(`SELECT id,name,phone,address FROM customers WHERE id=?`, [customerId]);
    if (!customers.length) throw new Error('Không tìm thấy khách');
    const [debtRows]=await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN type IN ('SALE','ADJUSTMENT_INCREASE') THEN amount WHEN type IN ('PAYMENT','ADJUSTMENT_DECREASE') THEN -amount ELSE 0 END),0) current_debt
       FROM debt_transactions WHERE customer_id=?`, [customerId]);
    const [unpaid]=await pool.query(
      `SELECT id,order_code,order_date,total_amount,paid_amount,debt_amount,payment_status,calendar_type,lunar_date_text,current_bill_amount,installment_amount,monthly_installment_id FROM orders
       WHERE customer_id=? AND COALESCE(status,'CONFIRMED')<>'CANCELLED' AND debt_amount>0 ORDER BY order_date ASC,id ASC`, [customerId]);
    const [split]=await pool.query(`SELECT payment_method,COALESCE(SUM(amount),0) total FROM payments WHERE customer_id=? GROUP BY payment_method`, [customerId]);
    const [cashBank]=await pool.query(`SELECT COALESCE(SUM(cash_amount),0) cash_total,COALESCE(SUM(bank_amount),0) bank_total,COALESCE(SUM(current_bill_amount),0) current_bill_total,COALESCE(SUM(installment_amount),0) installment_total FROM payments WHERE customer_id=?`, [customerId]);
    const [recent]=await pool.query(`SELECT p.*,o.order_code FROM payments p LEFT JOIN orders o ON o.id=p.order_id WHERE p.customer_id=? ORDER BY p.payment_date DESC,p.id DESC LIMIT 20`, [customerId]);
    return {customer:customers[0], current_debt:debtRows[0].current_debt, unpaid_orders:unpaid, payment_split:split, cash_bank_summary:cashBank[0], recent_payments:recent};
  }

  async applyPaymentToOrder(conn, orderId, amount) {
    const [orders]=await conn.query(`SELECT total_amount,paid_amount,debt_amount FROM orders WHERE id=? FOR UPDATE`, [orderId]);
    if (!orders.length) return 0;
    const order=orders[0];
    const total=Number(order.total_amount||0);
    const paidBefore=Number(order.paid_amount||0);
    // V65.37: use computed bill debt as the source of truth when debt_amount is stale.
    // Some old bills were created before debt recalculation, so debt_amount can be 0
    // even though total_amount - paid_amount is still positive. If we only look at
    // debt_amount, money dư after clearing an older bill will not flow to the next bill.
    const debtBefore=Math.max(0, Number(order.debt_amount||0), total-paidBefore);
    const pay=Math.min(Number(amount||0), debtBefore);
    const newPaid=Math.min(total, paidBefore+pay);
    const debt=Math.max(0,total-newPaid);
    const status=debt<=0?'PAID':newPaid>0?'PARTIAL':'UNPAID';
    await conn.query(`UPDATE orders SET paid_amount=?,debt_amount=?,payment_status=? WHERE id=?`, [newPaid,debt,status,orderId]);
    return pay;
  }

  async allocate(conn, customerId, amount, excludeOrderId=null) {
    let remaining=Number(amount||0);
    const allocations=[];
    const params=[customerId];
    let extra='';
    if(excludeOrderId){ extra=' AND id<>?'; params.push(excludeOrderId); }
    const [orders]=await conn.query(
      `SELECT id,order_code,
              GREATEST(COALESCE(debt_amount,0), COALESCE(total_amount,0)-COALESCE(paid_amount,0)) debt_amount
       FROM orders
       WHERE customer_id=? AND COALESCE(status,'CONFIRMED')<>'CANCELLED'
         AND GREATEST(COALESCE(debt_amount,0), COALESCE(total_amount,0)-COALESCE(paid_amount,0))>0 ${extra}
       ORDER BY order_date ASC,id ASC FOR UPDATE`,
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




  async allocateCustomerOpenBillsByDate(conn, customerId, amount) {
    let remaining=Number(amount||0);
    const allocations=[];
    if(!customerId || remaining<=0) return { allocations, note:'', remaining };
    const [orders]=await conn.query(
      `SELECT id,order_code,order_date,total_amount,paid_amount,
              GREATEST(COALESCE(debt_amount,0), COALESCE(total_amount,0)-COALESCE(paid_amount,0)) debt_amount
       FROM orders
       WHERE customer_id=? AND COALESCE(status,'CONFIRMED')<>'CANCELLED'
         AND GREATEST(COALESCE(debt_amount,0), COALESCE(total_amount,0)-COALESCE(paid_amount,0))>0
       ORDER BY order_date ASC,id ASC
       FOR UPDATE`,
      [customerId]
    );
    for(const o of orders){
      if(remaining<=0) break;
      const beforeDebt=Number(o.debt_amount||0);
      const want=Math.min(remaining,beforeDebt);
      const applied=await this.applyPaymentToOrder(conn,o.id,want);
      if(applied>0){
        remaining-=applied;
        allocations.push({
          order_id:o.id,
          order_code:o.order_code,
          order_date:o.order_date,
          debt_before:beforeDebt,
          applied_amount:applied,
          debt_after:Math.max(0,beforeDebt-applied)
        });
      }
    }
    return {
      allocations,
      note:allocations.map(a=>`${a.order_code}:${a.applied_amount}`).join(', '),
      remaining
    };
  }

  async allocateOrderSequence(conn, customerId, amount, orderIds=[]) {
    let remaining=Number(amount||0);
    const allocations=[];
    const ids=[...new Set((orderIds||[]).map(x=>Number(x)).filter(Boolean))];
    if(!ids.length || remaining<=0) return { allocations, note:'', remaining };
    const placeholders=ids.map(()=>'?').join(',');
    const [orders]=await conn.query(
      `SELECT id,order_code,order_date,total_amount,paid_amount,
              GREATEST(COALESCE(debt_amount,0), COALESCE(total_amount,0)-COALESCE(paid_amount,0)) debt_amount
       FROM orders
       WHERE customer_id=? AND COALESCE(status,'CONFIRMED')<>'CANCELLED'
         AND GREATEST(COALESCE(debt_amount,0), COALESCE(total_amount,0)-COALESCE(paid_amount,0))>0
         AND id IN (${placeholders})
       ORDER BY order_date ASC,id ASC
       FOR UPDATE`,
      [customerId, ...ids]
    );
    for(const o of orders){
      if(remaining<=0) break;
      const beforeDebt=Number(o.debt_amount||0);
      const want=Math.min(remaining,beforeDebt);
      const applied=await this.applyPaymentToOrder(conn,o.id,want);
      if(applied>0){
        remaining-=applied;
        allocations.push({
          order_id:o.id,
          order_code:o.order_code,
          order_date:o.order_date,
          debt_before:beforeDebt,
          applied_amount:applied,
          debt_after:Math.max(0,beforeDebt-applied)
        });
      }
    }
    return {
      allocations,
      note:allocations.map(a=>`${a.order_code}:${a.applied_amount}`).join(', '),
      remaining
    };
  }

  async allocateSelected(conn, customerId, amount, orderIds=[], excludeOrderId=null) {
    let remaining=Number(amount||0);
    const allocations=[];
    const ids=[...new Set((orderIds||[]).map(x=>Number(x)).filter(Boolean))].filter(id=>!excludeOrderId || Number(id)!==Number(excludeOrderId));
    if(!ids.length || remaining<=0) return { allocations, note:'' , remaining };
    const placeholders=ids.map(()=>'?').join(',');
    const [orders]=await conn.query(
      `SELECT id,order_code,order_date,total_amount,paid_amount,
              GREATEST(COALESCE(debt_amount,0), COALESCE(total_amount,0)-COALESCE(paid_amount,0)) debt_amount
       FROM orders
       WHERE customer_id=? AND COALESCE(status,'CONFIRMED')<>'CANCELLED'
         AND GREATEST(COALESCE(debt_amount,0), COALESCE(total_amount,0)-COALESCE(paid_amount,0))>0
         AND id IN (${placeholders})
       FOR UPDATE`,
      [customerId, ...ids]
    );
    // V65.40: user can select multiple bills in dialog, but accounting allocation
    // must always follow Ngày xuất hàng from old to new. Do not preserve checkbox order.
    for(const o of orders){
      if(remaining<=0) break;
      const beforeDebt=Number(o.debt_amount||0);
      const want=Math.min(remaining,beforeDebt);
      const applied=await this.applyPaymentToOrder(conn,o.id,want);
      if(applied>0){
        remaining-=applied;
        allocations.push({
          order_id:o.id,
          order_code:o.order_code,
          order_date:o.order_date,
          debt_before:beforeDebt,
          applied_amount:applied,
          debt_after:Math.max(0,beforeDebt-applied)
        });
      }
    }
    return {
      allocations,
      note:allocations.map(a=>`${a.order_code}:${a.applied_amount}`).join(', '),
      remaining
    };
  }


  async ensurePaymentAllocationSplitColumns(conn) {
    try {
      await conn.query(`ALTER TABLE payment_allocations ADD COLUMN cash_amount DECIMAL(15,2) NOT NULL DEFAULT 0`);
    } catch (e) {
      if (!(e && (e.code === 'ER_DUP_FIELDNAME' || e.errno === 1060 || e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146))) throw e;
    }
    try {
      await conn.query(`ALTER TABLE payment_allocations ADD COLUMN bank_amount DECIMAL(15,2) NOT NULL DEFAULT 0`);
    } catch (e) {
      if (!(e && (e.code === 'ER_DUP_FIELDNAME' || e.errno === 1060 || e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146))) throw e;
    }
  }


  async ensurePaymentUnappliedCreditsTable(conn) {
    await conn.query(`CREATE TABLE IF NOT EXISTS payment_unapplied_credits (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      payment_id BIGINT NOT NULL,
      customer_id BIGINT NOT NULL,
      original_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
      remaining_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
      cash_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
      bank_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
      note VARCHAR(500) NULL,
      created_by BIGINT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      INDEX idx_puc_customer_remaining(customer_id, remaining_amount),
      INDEX idx_puc_payment(payment_id)
    )`);
  }

  async insertUnappliedCredit(conn, paymentId, customerId, amount, cashAmount, bankAmount, note, userId) {
    const total = Number(amount || 0);
    if (!paymentId || !customerId || total <= 0) return;
    await this.ensurePaymentUnappliedCreditsTable(conn);
    await conn.query(
      `INSERT INTO payment_unapplied_credits(payment_id,customer_id,original_amount,remaining_amount,cash_amount,bank_amount,note,created_by,created_at)
       VALUES(?,?,?,?,?,?,?,?,NOW())`,
      [paymentId, customerId, total, total, Number(cashAmount||0), Number(bankAmount||0), note || 'Tiền khách trả dư chưa phân bổ vào bill', userId || null]
    );
  }

  async allocateExistingCreditsToOpenBills(conn, customerId, userId) {
    if (!customerId) return { allocations: [], applied_total: 0 };
    await this.ensurePaymentUnappliedCreditsTable(conn);
    const [credits] = await conn.query(
      `SELECT * FROM payment_unapplied_credits
       WHERE customer_id=? AND remaining_amount>0
       ORDER BY created_at ASC,id ASC FOR UPDATE`,
      [customerId]
    );
    if (!credits.length) return { allocations: [], applied_total: 0 };

    const [orders] = await conn.query(
      `SELECT id,order_code,order_date,total_amount,paid_amount,
              GREATEST(COALESCE(debt_amount,0), COALESCE(total_amount,0)-COALESCE(paid_amount,0)) debt_amount
       FROM orders
       WHERE customer_id=? AND COALESCE(status,'CONFIRMED')<>'CANCELLED'
         AND GREATEST(COALESCE(debt_amount,0), COALESCE(total_amount,0)-COALESCE(paid_amount,0))>0
       ORDER BY order_date ASC,id ASC FOR UPDATE`,
      [customerId]
    );
    const allocations=[];
    let appliedTotal=0;
    for (const credit of credits) {
      let creditLeft = Number(credit.remaining_amount || 0);
      let cashLeft = Math.min(creditLeft, Number(credit.cash_amount || 0));
      let bankLeft = Math.max(0, Math.min(creditLeft - cashLeft, Number(credit.bank_amount || 0)));
      for (const o of orders) {
        if (creditLeft <= 0) break;
        const currentDebt = Math.max(0, Number(o.total_amount||0) - Number(o.paid_amount||0));
        if (currentDebt <= 0) continue;
        const amount = Math.min(creditLeft, currentDebt);
        const cash = Math.min(amount, cashLeft);
        cashLeft -= cash;
        const bank = Math.min(amount - cash, bankLeft);
        bankLeft -= bank;
        const applied = await this.applyPaymentToOrder(conn, o.id, amount);
        if (applied > 0) {
          await this.insertPaymentAllocationSafe(
            conn, credit.payment_id, o.id, customerId, applied, 'CUSTOMER_CREDIT',
            `Phân bổ tiền dư vào bill ${o.order_code}`, userId, cash, bank
          );
          creditLeft -= applied;
          appliedTotal += applied;
          o.paid_amount = Number(o.paid_amount || 0) + applied;
          allocations.push({ order_id:o.id, order_code:o.order_code, applied_amount:applied, cash_amount:cash, bank_amount:bank, credit_id:credit.id });
        }
      }
      await conn.query(
        `UPDATE payment_unapplied_credits SET remaining_amount=?, updated_at=NOW() WHERE id=?`,
        [Math.max(0, creditLeft), credit.id]
      );
    }
    return { allocations, applied_total: appliedTotal };
  }

  splitAllocationsByTender(allocations, cashAmount, bankAmount) {
    let cashLeft = Number(cashAmount || 0);
    let bankLeft = Number(bankAmount || 0);
    return (allocations || []).map(a => {
      const amount = Number(a.applied_amount || a.amount || 0);
      const cash = Math.min(amount, Math.max(0, cashLeft));
      cashLeft -= cash;
      const bank = Math.min(amount - cash, Math.max(0, bankLeft));
      bankLeft -= bank;
      return { ...a, cash_amount: cash, bank_amount: bank };
    });
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


  async getIdempotentResult(key) {
    if (!key) return null;
    try {
      const [rows] = await pool.query(
        `SELECT status,response_json,error_message FROM payment_transaction_requests WHERE idempotency_key=? LIMIT 1`,
        [key]
      );
      if (!rows.length) return null;
      const row = rows[0];
      if (row.status === 'SUCCESS') {
        try { return JSON.parse(row.response_json || '{}'); } catch (_) { return { message:'Giao dịch đã xử lý', idempotency_key:key }; }
      }
      if (row.status === 'PROCESSING') {
        const err = new Error('Giao dịch đang xử lý. Vui lòng bấm kiểm tra lại, không bấm thu tiền thêm lần nữa.');
        err.code = 'PAYMENT_PROCESSING';
        throw err;
      }
      if (row.status === 'FAILED') {
        const err = new Error(row.error_message || 'Giao dịch trước đó bị lỗi. Vui lòng kiểm tra log trước khi thực hiện lại.');
        err.code = 'PAYMENT_PREVIOUS_FAILED';
        throw err;
      }
    } catch (e) {
      if (e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146)) return null;
      throw e;
    }
    return null;
  }

  async beginIdempotentRequest(key, data, user) {
    if (!key) return false;
    try {
      await pool.query(
        `INSERT INTO payment_transaction_requests
         (idempotency_key,status,request_json,created_by,created_at,updated_at)
         VALUES(?,?,?,?,NOW(),NOW())`,
        [key,'PROCESSING',JSON.stringify(data||{}),user?.id||null]
      );
      return true;
    } catch (e) {
      if (e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062)) {
        const existing = await this.getIdempotentResult(key);
        if (existing) return false;
      }
      if (e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146)) return false;
      throw e;
    }
  }

  async finishIdempotentRequest(key, status, payload) {
    if (!key) return;
    try {
      await pool.query(
        `UPDATE payment_transaction_requests
         SET status=?, response_json=?, error_message=?, updated_at=NOW()
         WHERE idempotency_key=?`,
        [status, status==='SUCCESS'?JSON.stringify(payload||{}):null, status==='FAILED'?String(payload?.message||payload||''):null, key]
      );
    } catch (e) {
      if (!(e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146))) throw e;
    }
  }

  async insertPaymentAllocationSafe(conn, paymentId, orderId, customerId, amount, allocationType, note, userId, cashAmount=0, bankAmount=0) {
    if (!paymentId || !orderId || Number(amount||0)<=0) return;
    try {
      await conn.query(
        `INSERT INTO payment_allocations(payment_id,order_id,customer_id,amount,cash_amount,bank_amount,allocation_type,note,created_by,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,NOW())`,
        [paymentId,orderId,customerId,amount,Number(cashAmount||0),Number(bankAmount||0),allocationType,note||'',userId||null]
      );
    } catch (e) {
      if (e && (e.code === 'ER_BAD_FIELD_ERROR' || e.errno === 1054)) {
        await conn.query(
          `INSERT INTO payment_allocations(payment_id,order_id,customer_id,amount,allocation_type,note,created_by,created_at)
           VALUES(?,?,?,?,?,?,?,NOW())`,
          [paymentId,orderId,customerId,amount,allocationType,note||'',userId||null]
        );
        return;
      }
      if (!(e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146))) throw e;
    }
  }

  async create(data, user) {
    const idempotencyKey = String(data.idempotency_key || data.idempotencyKey || '').trim();
    const existingIdempotentResult = await this.getIdempotentResult(idempotencyKey);
    if (existingIdempotentResult) return existingIdempotentResult;
    const idempotencyStarted = await this.beginIdempotentRequest(idempotencyKey, data, user);

    const cashAmount=Number(data.cash_amount||0);
    const bankAmount=Number(data.bank_amount||0);
    const paidTotal=cashAmount+bankAmount;
    const explicitAmount=Number(data.amount||0);
    const amount=paidTotal>0 ? paidTotal : (explicitAmount>0 ? explicitAmount : 0);

    if (!data.customer_id || amount<=0) throw new Error('Thiếu khách hoặc số tiền thu không hợp lệ');
    await assertCustomerScope(user, data.customer_id);

    const conn=await pool.getConnection();
    try {
      // V65.35: make sure allocation table can store tender split before the transaction starts.
      // MySQL DDL commits implicitly, so never ALTER inside the payment transaction.
      await this.ensurePaymentAllocationSplitColumns(conn);
      await this.ensurePaymentUnappliedCreditsTable(conn);
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
      let orderAllocations=[];
      let oldDebtAllocations=[];
      let unusedAmount=0;
      if(data.order_id){
        // V65.41: Do not depend on manual checkbox selection anymore.
        // When the customer has open bills, the payment must be allocated automatically
        // from the oldest shipping/order date to the newest. This means:
        // - clear the remaining debt of BILL1 first
        // - any remaining money must flow into BILL2, BILL3, ...
        // - every receiving bill gets its own payment_allocations row so printing the bill
        //   shows the amount actually applied to that bill.
        const allocResult=await this.allocateCustomerOpenBillsByDate(conn,data.customer_id,remainingPaid);
        orderAllocations=this.splitAllocationsByTender(allocResult.allocations, cashAmount, bankAmount);
        oldDebtAllocations=orderAllocations.filter(a=>Number(a.order_id)!==Number(data.order_id));
        billApplied=orderAllocations.filter(a=>Number(a.order_id)===Number(data.order_id)).reduce((sum,a)=>sum+Number(a.applied_amount||0),0);
        remainingPaid=allocResult.remaining;
        if(allocResult.note){
          note = note ? `${note} / Tự động phân bổ theo ngày xuất hàng: ${allocResult.note}` : `Tự động phân bổ theo ngày xuất hàng: ${allocResult.note}`;
        }

        unusedAmount=remainingPaid;
        if(unusedAmount>0){
          note = note ? `${note} / Tiền dư chưa phân bổ: ${unusedAmount}` : `Tiền dư chưa phân bổ: ${unusedAmount}`;
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

      if (Array.isArray(orderAllocations) && orderAllocations.length) {
        for (const a of orderAllocations) {
          const allocationType = Number(a.order_id)===Number(data.order_id) ? 'CURRENT_BILL' : 'RELATED_BILL';
          await this.insertPaymentAllocationSafe(
            conn, insertId, a.order_id, data.customer_id, a.applied_amount, allocationType,
            `${allocationType==='CURRENT_BILL'?'Thanh toán bill đang chọn':'Phân bổ thanh toán theo thứ tự ngày xuất hàng'} ${a.order_code}`,
            user.id,
            a.cash_amount || 0,
            a.bank_amount || 0
          );
        }
      }

      // V65.40: If money remains after selected bills are fully paid, keep it as customer credit.
      // Do not silently allocate to bills that the user did not select in the dialog.
      if (Number(unusedAmount || 0) > 0) {
        const allocatedCash = (orderAllocations || []).reduce((sum,a)=>sum+Number(a.cash_amount||0),0);
        const allocatedBank = (orderAllocations || []).reduce((sum,a)=>sum+Number(a.bank_amount||0),0);
        const unusedCash = Math.max(0, Number(cashAmount||0) - allocatedCash);
        const unusedBank = Math.max(0, Number(bankAmount||0) - allocatedBank);
        await this.insertUnappliedCredit(
          conn, insertId, data.customer_id, unusedAmount,
          Math.min(unusedAmount, unusedCash),
          Math.max(0, unusedAmount - Math.min(unusedAmount, unusedCash)),
          `Tiền dư từ phiếu thu ${code}`, user.id
        );
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
      const response = {
        message:'Đã thu tiền và cập nhật công nợ',
        payment_code:code,
        payment_id: insertId,
        idempotency_key: idempotencyKey || null,
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
        old_debt_allocations:oldDebtAllocations||[],
        unused_amount:unusedAmount||0,
        monthly_installment_id:monthlyInstallmentId
      };
      if (idempotencyStarted) await this.finishIdempotentRequest(idempotencyKey, 'SUCCESS', response);
      return response;
    } catch(e) {
      await conn.rollback();
      if (idempotencyStarted) await this.finishIdempotentRequest(idempotencyKey, 'FAILED', e);
      throw e;
    } finally { conn.release(); }
  }

  async recalcOrderAfterPaymentChange(conn, orderId) {
    if (!orderId) return;
    const [rows] = await conn.query(`SELECT id,total_amount,paid_amount FROM orders WHERE id=? FOR UPDATE`, [orderId]);
    if (!rows.length) return;
    const o = rows[0];
    const total = Number(o.total_amount || 0);
    const paid = Math.max(0, Math.min(total, Number(o.paid_amount || 0)));
    const debt = Math.max(0, total - paid);
    const status = debt <= 0 ? 'PAID' : paid > 0 ? 'PARTIAL' : 'UNPAID';
    await conn.query(`UPDATE orders SET paid_amount=?, debt_amount=?, payment_status=? WHERE id=?`, [paid, debt, status, orderId]);
  }

  async revertPaymentEffects(conn, paymentId) {
    const [payments] = await conn.query(`SELECT * FROM payments WHERE id=? FOR UPDATE`, [paymentId]);
    if (!payments.length) throw new Error('Không tìm thấy phiếu thu');
    const p = payments[0];
    if (Number(p.is_locked || 0) === 1 || p.locked_at) throw new Error('Phiếu thu đã chốt, không thể sửa/xóa');
    if (String(p.status || '').toUpperCase() === 'CANCELLED') throw new Error('Phiếu thu đã hủy');

    let allocRows=[];
    try {
      const [rows] = await conn.query(`SELECT * FROM payment_allocations WHERE payment_id=? FOR UPDATE`, [paymentId]);
      allocRows = rows || [];
    } catch (e) {
      if (!(e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146))) throw e;
    }

    const affected = new Set();
    for (const a of allocRows) {
      const amount = Number(a.amount || 0);
      if (a.order_id && amount > 0) {
        const [orders] = await conn.query(`SELECT id,total_amount,paid_amount FROM orders WHERE id=? FOR UPDATE`, [a.order_id]);
        if (orders.length) {
          const paid = Math.max(0, Number(orders[0].paid_amount || 0) - amount);
          await conn.query(`UPDATE orders SET paid_amount=? WHERE id=?`, [paid, a.order_id]);
          affected.add(Number(a.order_id));
        }
      }
    }

    // Backward compatible: older payment rows may not have allocation rows.
    if (!allocRows.length && p.order_id && Number(p.amount || 0) > 0) {
      const [orders] = await conn.query(`SELECT id,total_amount,paid_amount FROM orders WHERE id=? FOR UPDATE`, [p.order_id]);
      if (orders.length) {
        const paid = Math.max(0, Number(orders[0].paid_amount || 0) - Number(p.amount || 0));
        await conn.query(`UPDATE orders SET paid_amount=? WHERE id=?`, [paid, p.order_id]);
        affected.add(Number(p.order_id));
      }
    }

    for (const oid of affected) await this.recalcOrderAfterPaymentChange(conn, oid);

    try { await conn.query(`DELETE FROM payment_allocations WHERE payment_id=?`, [paymentId]); } catch(e) { if (!(e && (e.code==='ER_NO_SUCH_TABLE'||e.errno===1146))) throw e; }
    try { await conn.query(`DELETE FROM payment_unapplied_credits WHERE payment_id=?`, [paymentId]); } catch(e) { if (!(e && (e.code==='ER_NO_SUCH_TABLE'||e.errno===1146))) throw e; }
    try { await conn.query(`DELETE FROM debt_transactions WHERE payment_id=?`, [paymentId]); } catch(e) { if (!(e && (e.code==='ER_BAD_FIELD_ERROR'||e.errno===1054))) throw e; }
    return p;
  }

  async update(paymentId, data, user) {
    // Scope check before any mutations: load payment customer_id without a transaction.
    const [prows] = await pool.query(`SELECT customer_id FROM payments WHERE id=? LIMIT 1`, [paymentId]);
    if (!prows.length) throw new Error('Không tìm thấy phiếu thu');
    await assertCustomerScope(user, prows[0].customer_id);
    if (data.customer_id && Number(data.customer_id) !== Number(prows[0].customer_id)) {
      await assertCustomerScope(user, data.customer_id);
    }

    const conn = await pool.getConnection();
    try {
      await this.ensurePaymentAllocationSplitColumns(conn);
      await this.ensurePaymentUnappliedCreditsTable(conn);
      await conn.beginTransaction();
      const old = await this.revertPaymentEffects(conn, paymentId);

      const customerId = Number(data.customer_id || old.customer_id);
      const orderId = Number(data.order_id || old.order_id || 0) || null;
      const cashAmount = Number(data.cash_amount || 0);
      const bankAmount = Number(data.bank_amount || 0);
      const amount = cashAmount + bankAmount;
      if (!customerId || amount <= 0) throw new Error('Thiếu khách hoặc số tiền thu không hợp lệ');
      const method = (cashAmount>0 && bankAmount>0) ? 'MIXED' : (cashAmount>0 ? 'CASH' : 'BANK_TRANSFER');
      const paymentDate = String(data.payment_date || old.payment_date || new Date().toISOString().slice(0,10)).slice(0,10);
      let note = data.note || old.note || '';

      const allocResult = await this.allocateCustomerOpenBillsByDate(conn, customerId, amount);
      const split = this.splitAllocationsByTender(allocResult.allocations, cashAmount, bankAmount);
      if (allocResult.note) note = note ? `${note} / Sửa phiếu thu, phân bổ lại: ${allocResult.note}` : `Sửa phiếu thu, phân bổ lại: ${allocResult.note}`;

      let unusedAmount = Number(allocResult.remaining || 0);
      if (unusedAmount > 0) note = note ? `${note} / Tiền dư chưa phân bổ: ${unusedAmount}` : `Tiền dư chưa phân bổ: ${unusedAmount}`;

      await conn.query(
        `UPDATE payments SET customer_id=?,order_id=?,payment_date=?,amount=?,payment_method=?,cash_amount=?,bank_amount=?,note=?,updated_at=NOW() WHERE id=?`,
        [customerId, orderId, paymentDate, amount, method, cashAmount, bankAmount, note, paymentId]
      );

      for (const a of split) {
        await this.insertPaymentAllocationSafe(
          conn, paymentId, a.order_id, customerId, a.applied_amount,
          Number(a.order_id) === Number(orderId) ? 'CURRENT_BILL' : 'RELATED_BILL',
          `Phân bổ lại sau khi sửa phiếu thu ${old.payment_code || ''} ${a.order_code || ''}`,
          user?.id || null,
          a.cash_amount || 0,
          a.bank_amount || 0
        );
      }

      if (unusedAmount > 0) {
        const allocatedCash = split.reduce((sum,a)=>sum+Number(a.cash_amount||0),0);
        const allocatedBank = split.reduce((sum,a)=>sum+Number(a.bank_amount||0),0);
        const unusedCash = Math.max(0, cashAmount - allocatedCash);
        const unusedBank = Math.max(0, bankAmount - allocatedBank);
        await this.insertUnappliedCredit(conn, paymentId, customerId, unusedAmount, Math.min(unusedAmount, unusedCash), Math.max(0, unusedAmount - Math.min(unusedAmount, unusedCash)), `Tiền dư sau khi sửa phiếu thu ${old.payment_code || ''}`, user?.id || null);
      }

      await conn.query(
        `INSERT INTO debt_transactions(customer_id,order_id,payment_id,transaction_date,type,amount,note,created_by)
         VALUES(?,?,?,?, 'PAYMENT', ?, ?, ?)`,
        [customerId, orderId, paymentId, paymentDate, amount, note || `Sửa phiếu thu ${old.payment_code || ''}`, user?.id || null]
      );

      await conn.commit();
      return { message:'Đã sửa phiếu thu và phân bổ lại công nợ', payment_id:Number(paymentId), amount, cash_amount:cashAmount, bank_amount:bankAmount, unused_amount:unusedAmount, allocations:split };
    } catch(e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }

  async cancel(paymentId, data={}, user={}) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const old = await this.revertPaymentEffects(conn, paymentId);
      if (user?.role === 'CUSTOMER' && Number(user.customer_id) !== Number(old.customer_id)) throw new Error('Không có quyền');
      const note = data.note || data.reason || 'Hủy phiếu thu nhập sai';
      try {
        await conn.query(`UPDATE payments SET status='CANCELLED', amount=0, cash_amount=0, bank_amount=0, note=CONCAT(COALESCE(note,''),' / HỦY: ',?), updated_at=NOW() WHERE id=?`, [note, paymentId]);
      } catch(e) {
        if (e && (e.code==='ER_BAD_FIELD_ERROR' || e.errno===1054)) {
          await conn.query(`UPDATE payments SET amount=0, cash_amount=0, bank_amount=0, note=CONCAT(COALESCE(note,''),' / HỦY: ',?) WHERE id=?`, [note, paymentId]);
        } else throw e;
      }
      await conn.commit();
      return { message:'Đã hủy phiếu thu và trả lại công nợ', payment_id:Number(paymentId) };
    } catch(e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }

  async lock(paymentId, data={}, user={}) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query(`SELECT * FROM payments WHERE id=? FOR UPDATE`, [paymentId]);
      if (!rows.length) throw new Error('Không tìm thấy phiếu thu');
      if (user?.role === 'CUSTOMER' && Number(user.customer_id) !== Number(rows[0].customer_id)) throw new Error('Không có quyền');
      if (String(rows[0].status || '').toUpperCase() === 'CANCELLED') throw new Error('Phiếu thu đã hủy, không thể chốt');
      try {
        await conn.query(`UPDATE payments SET is_locked=1, locked_at=NOW(), locked_by=?, lock_note=?, updated_at=NOW() WHERE id=?`, [user?.id || null, data.note || data.lock_note || null, paymentId]);
      } catch(e) {
        if (e && (e.code==='ER_BAD_FIELD_ERROR' || e.errno===1054)) throw new Error('Chưa chạy migration khóa phiếu thu V65.47');
        throw e;
      }
      await conn.commit();
      return { message:'Đã chốt phiếu thu', payment_id:Number(paymentId) };
    } catch(e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }

}
module.exports = new PaymentAgent();
