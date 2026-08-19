const pool = require('../config/db');
const { nextCode } = require('../utils/code');
const { assertCustomerScope, customerScopeWhere }=require('../middleware/scope');
const { parseLunarText, lunarToSolarDate, solarToLunar } = require('../utils/lunarDate');
const DebtInstallmentAgent = require('./DebtInstallmentAgent');

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
    // Overpay-guard consistency: debt_amount here must be the same
    // authoritative GREATEST(0,total-SUM(payment_allocations)) figure
    // create()'s overpay guard enforces (_authoritativeOrderRemaining) —
    // never the stored orders.debt_amount column, which can go stale (see
    // commit 1d9ed72). Otherwise this picker could show a bill as owing an
    // amount the backend would then reject as already settled, or vice
    // versa. Field name kept as debt_amount so no other consumer of this
    // response shape needs to change.
    const [unpaid]=await pool.query(
      `SELECT o.id,o.order_code,o.order_date,o.total_amount,
              COALESCE(pa.allocated,0) paid_amount,
              GREATEST(0, o.total_amount-COALESCE(pa.allocated,0)) debt_amount,
              o.payment_status,o.calendar_type,o.lunar_date_text,o.current_bill_amount,o.installment_amount,o.monthly_installment_id
       FROM orders o
       LEFT JOIN (SELECT order_id, SUM(amount) allocated FROM payment_allocations GROUP BY order_id) pa ON pa.order_id=o.id
       WHERE o.customer_id=? AND COALESCE(o.status,'CONFIRMED')<>'CANCELLED'
       HAVING debt_amount>0
       ORDER BY o.order_date ASC,o.id ASC`, [customerId]);
    const [split]=await pool.query(`SELECT payment_method,COALESCE(SUM(amount),0) total FROM payments WHERE customer_id=? GROUP BY payment_method`, [customerId]);
    const [cashBank]=await pool.query(`SELECT COALESCE(SUM(cash_amount),0) cash_total,COALESCE(SUM(bank_amount),0) bank_total,COALESCE(SUM(current_bill_amount),0) current_bill_total,COALESCE(SUM(installment_amount),0) installment_total FROM payments WHERE customer_id=?`, [customerId]);
    const [recent]=await pool.query(`SELECT p.*,o.order_code FROM payments p LEFT JOIN orders o ON o.id=p.order_id WHERE p.customer_id=? ORDER BY p.payment_date DESC,p.id DESC LIMIT 20`, [customerId]);
    return {customer:customers[0], current_debt:debtRows[0].current_debt, unpaid_orders:unpaid, payment_split:split, cash_bank_summary:cashBank[0], recent_payments:recent};
  }

  // feat(debt): period contribution summary — "Đã góp trong kỳ" for a
  // customer over a solar or lunar-selected date range.
  // Authority: the `payments` table itself, one row per real receipt — never
  // payment_allocations (a receipt split across bills) and never
  // debt_installment_payments (a receipt tied to a daily-installment plan),
  // both of which would either double-count or miss allocation-free receipts.
  // Cancelled/reverted receipts are excluded by status; cancel()/update() also
  // already zero their amounts and delete their allocation rows, so this is
  // belt-and-suspenders, not the only guard. Calendar mode only resolves which
  // solar date range to query — historical payment_date values are never
  // reinterpreted (BR-CORE-005).
  resolvePeriodRange(query = {}) {
    const calendarType = String(query.calendar_type || 'SOLAR').toUpperCase() === 'LUNAR' ? 'LUNAR' : 'SOLAR';
    if (calendarType === 'LUNAR') {
      const fromLunarText = String(query.from_lunar_date_text || query.lunar_from || '').trim();
      const toLunarText = String(query.to_lunar_date_text || query.lunar_to || '').trim();
      const fromLunar = parseLunarText(fromLunarText);
      const toLunar = parseLunarText(toLunarText);
      if (!fromLunar || !toLunar) throw Object.assign(new Error('Vui lòng chọn từ ngày và đến ngày âm lịch (định dạng DD/MM/YYYY)'), { status: 400 });
      const fromDate = lunarToSolarDate(fromLunar);
      const toDate = lunarToSolarDate(toLunar);
      if (!fromDate || !toDate) throw Object.assign(new Error('Không thể quy đổi ngày âm lịch sang dương lịch'), { status: 400 });
      return { calendarType, fromDate, toDate, fromLunarText, toLunarText };
    }
    const fromDate = String(query.from_date || query.from || '').slice(0, 10);
    const toDate = String(query.to_date || query.to || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
      throw Object.assign(new Error('Vui lòng chọn từ ngày và đến ngày'), { status: 400 });
    }
    return { calendarType, fromDate, toDate, fromLunarText: '', toLunarText: '' };
  }

  async periodContribution(customerId, query = {}, user) {
    await assertCustomerScope(user, customerId);
    const [customers] = await pool.query(`SELECT id,name,phone,billing_calendar_type FROM customers WHERE id=?`, [customerId]);
    if (!customers.length) throw new Error('Không tìm thấy khách');

    const range = this.resolvePeriodRange(query);
    const [fromDate, toDate] = range.fromDate <= range.toDate ? [range.fromDate, range.toDate] : [range.toDate, range.fromDate];

    // Same signed ledger read every other current-debt display in the app
    // uses — see DebtInstallmentAgent.customerDebt(). Independent of the
    // selected period, per LOCKED RULE A.
    const currentDebt = await DebtInstallmentAgent.customerDebt(customerId);

    const [rows] = await pool.query(
      `SELECT id,payment_code,payment_date,cash_amount,bank_amount,note,order_id,status
       FROM payments
       WHERE customer_id=? AND COALESCE(status,'ACTIVE')<>'CANCELLED' AND payment_date BETWEEN ? AND ?
       ORDER BY payment_date ASC,id ASC`,
      [customerId, fromDate, toDate]
    );

    const paymentIds = rows.map(r => Number(r.id)).filter(Boolean);
    const allocMap = new Map();
    if (paymentIds.length) {
      try {
        const placeholders = paymentIds.map(() => '?').join(',');
        const [allocRows] = await pool.query(
          `SELECT pa.payment_id, o.order_code
           FROM payment_allocations pa LEFT JOIN orders o ON o.id=pa.order_id
           WHERE pa.payment_id IN (${placeholders})
           ORDER BY o.order_date ASC,o.id ASC,pa.id ASC`,
          paymentIds
        );
        for (const a of allocRows) {
          const pid = Number(a.payment_id);
          if (!allocMap.has(pid)) allocMap.set(pid, []);
          if (a.order_code) allocMap.get(pid).push(a.order_code);
        }
      } catch (e) {
        if (!(e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146))) throw e;
      }
    }

    let cashTotal = 0, bankTotal = 0;
    const detail = rows.map(r => {
      const cash = Number(r.cash_amount || 0);
      const bank = Number(r.bank_amount || 0);
      cashTotal += cash;
      bankTotal += bank;
      const bills = allocMap.get(Number(r.id)) || [];
      return {
        payment_id: r.id,
        payment_date: r.payment_date,
        lunar_date_text: (() => { const l = solarToLunar(r.payment_date); return `${String(l.day).padStart(2,'0')}/${String(l.month).padStart(2,'0')}/${l.year}`; })(),
        payment_code: r.payment_code,
        bill_codes: bills.length ? bills.join(', ') : (r.order_id ? '' : 'Chưa phân bổ'),
        cash_amount: cash,
        bank_amount: bank,
        total_amount: cash + bank,
        note: r.note || ''
      };
    });

    // LOCKED RULE D (optional): only surfaced when a real
    // debt_installment_plans authority already exists for this customer —
    // never a derived/guessed number.
    let remainingPlanTotal;
    try {
      const plans = await DebtInstallmentAgent.list(customerId);
      const active = (plans || []).filter(p => p.status === 'ACTIVE');
      if (active.length) remainingPlanTotal = active.reduce((s, p) => s + Number(p.remaining_amount || 0), 0);
    } catch (e) { /* optional field — never blocks the period summary */ }

    return {
      customer: customers[0],
      calendar_type: range.calendarType,
      from_date: fromDate,
      to_date: toDate,
      from_lunar_date_text: range.calendarType === 'LUNAR' ? range.fromLunarText : '',
      to_lunar_date_text: range.calendarType === 'LUNAR' ? range.toLunarText : '',
      current_debt: currentDebt,
      period_summary: {
        cash_total: cashTotal,
        bank_total: bankTotal,
        total: cashTotal + bankTotal,
        payment_count: detail.length
      },
      remaining_plan_total: remainingPlanTotal,
      rows: detail
    };
  }

  // GO-LIVE BLOCKER 3 fix: single source of truth for "what does this order
  // actually owe right now" — the order's own debt_transactions rows, same
  // sign convention every reconciliation check in this codebase already uses
  // (SALE/ADJUSTMENT_INCREASE add, PAYMENT/ADJUSTMENT_DECREASE subtract).
  // Not a second ledger — just a read of the existing one. Introduced because
  // total_amount-paid_amount arithmetic (used in three places below) has no
  // way to know about a Sales Return's compensating ADJUSTMENT_DECREASE —
  // total_amount is immutable (BR-BILL-004/BR-PRICE-002, never rewritten by a
  // return) and paid_amount only tracks cash payments, never a return's debt
  // forgiveness — so that arithmetic silently resurrects debt a return had
  // already reversed.
  async _ledgerDebtForOrder(conn, orderId) {
    const [[row]] = await conn.query(
      `SELECT COALESCE(SUM(CASE
          WHEN type IN ('SALE','ADJUSTMENT_INCREASE') THEN amount
          WHEN type IN ('PAYMENT','ADJUSTMENT_DECREASE') THEN -amount
          ELSE 0 END),0) net
       FROM debt_transactions WHERE order_id=?`,
      [orderId]
    );
    return Number(row.net || 0);
  }

  async applyPaymentToOrder(conn, orderId, amount) {
    const [orders]=await conn.query(`SELECT total_amount,paid_amount,debt_amount FROM orders WHERE id=? FOR UPDATE`, [orderId]);
    if (!orders.length) return 0;
    const order=orders[0];
    const total=Number(order.total_amount||0);
    const paidBefore=Number(order.paid_amount||0);
    // V65.37's original fallback used total-paidBefore as a floor for stale
    // debt_amount rows (old bills created before debt recalculation). GO-LIVE
    // BLOCKER 3: that floor is now the ledger-derived debt instead of
    // total-paidBefore — it still catches the same stale-data case (the
    // ledger sum is >0 even when debt_amount is wrongly 0), without
    // overstating debt after a Sales Return (see _ledgerDebtForOrder above).
    const debtBefore=Math.max(0, Number(order.debt_amount||0), await this._ledgerDebtForOrder(conn, orderId));
    const pay=Math.min(Number(amount||0), debtBefore);
    const newPaid=Math.min(total, paidBefore+pay);
    // GO-LIVE BLOCKER 3: derive the new debt from debtBefore-pay (both
    // already ledger-aware), not total-newPaid — identical result in the
    // normal case (no return has ever touched this order), but no longer
    // wrong once one has.
    const debt=Math.max(0, debtBefore-pay);
    const status=debt<=0?'PAID':newPaid>0?'PARTIAL':'UNPAID';
    await conn.query(`UPDATE orders SET paid_amount=?,debt_amount=?,payment_status=? WHERE id=?`, [newPaid,debt,status,orderId]);
    return pay;
  }

  // FEAT (overpay guard): authoritative "how much of this order is still
  // owed right now" — GREATEST(0, total_amount - SUM(payment_allocations)).
  // Deliberately NOT applyPaymentToOrder()'s debtBefore=Math.max(stored
  // debt_amount, _ledgerDebtForOrder()) — that ledger floor can itself be
  // stale (verified live: a pre-Gate-3-ledger-fix payment split across bills
  // wrote one lump debt_transactions row against a single order, leaving
  // every OTHER order it partially settled with zero ledger rows — same root
  // cause ReportAgent.customerBillingMatrix() hit and fixed, commit 1d9ed72).
  // payment_allocations is the one figure every payment code path — old and
  // new — always wrote correctly per real split, so it's the only safe basis
  // for a hard block/allow decision on real money.
  async _authoritativeOrderRemaining(conn, orderId) {
    const [[row]] = await conn.query(
      `SELECT o.total_amount total, COALESCE(SUM(pa.amount),0) allocated
       FROM orders o LEFT JOIN payment_allocations pa ON pa.order_id=o.id
       WHERE o.id=? GROUP BY o.id FOR UPDATE`,
      [orderId]
    );
    if (!row) return 0;
    return Math.max(0, Number(row.total || 0) - Number(row.allocated || 0));
  }

  // Every OTHER valid (non-cancelled) bill this customer still owes on, with
  // the same authoritative remaining — excludes excludeOrderId (the "current
  // bill" the caller already handles separately). Used both to validate the
  // overpay guard and to hand the frontend's excess-allocation dialog its
  // list of real eligible targets.
  async _authoritativeOtherOpenBills(conn, customerId, excludeOrderId) {
    const [rows] = await conn.query(
      `SELECT o.id, o.order_code, o.order_date, o.calendar_type, o.lunar_date_text,
              GREATEST(0, o.total_amount - COALESCE(pa.allocated,0)) remaining
       FROM orders o
       LEFT JOIN (SELECT order_id, SUM(amount) allocated FROM payment_allocations GROUP BY order_id) pa
         ON pa.order_id=o.id
       WHERE o.customer_id=? AND o.status<>'CANCELLED' AND o.id<>?
       HAVING remaining>0
       ORDER BY o.order_date ASC, o.id ASC
       FOR UPDATE`,
      [customerId, excludeOrderId || 0]
    );
    return rows;
  }

  // Applies `amount` to a single order, capped at that order's own
  // authoritative remaining (never more, never resurrecting the ledger-floor
  // bug applyPaymentToOrder() carries) — writes orders.paid_amount/
  // debt_amount/payment_status directly from that same authoritative figure.
  async _applyPaymentToOrderAuthoritative(conn, orderId, amount) {
    const [[order]] = await conn.query(`SELECT total_amount,paid_amount FROM orders WHERE id=? FOR UPDATE`, [orderId]);
    if (!order) return 0;
    const remainingBefore = await this._authoritativeOrderRemaining(conn, orderId);
    const pay = Math.min(Number(amount || 0), remainingBefore);
    if (pay <= 0) return 0;
    const newPaid = Number(order.paid_amount || 0) + pay;
    const newDebt = Math.max(0, remainingBefore - pay);
    const status = newDebt <= 0 ? 'PAID' : (newPaid > 0 ? 'PARTIAL' : 'UNPAID');
    await conn.query(`UPDATE orders SET paid_amount=?,debt_amount=?,payment_status=? WHERE id=?`, [newPaid, newDebt, status, orderId]);
    return pay;
  }

  // GO-LIVE F7: allocate() (the pre-payment_allocations, note-string-only
  // helper) was removed here — its sole caller in create() now goes through
  // allocateCustomerOpenBillsByDate() unconditionally (see F7 comment at
  // that call site), which does everything this did plus writes reversible
  // payment_allocations rows and tracks leftover money as unapplied credit.



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


  // CR-4: ensurePaymentAllocationSplitColumns() and
  // ensurePaymentUnappliedCreditsTable() lived here and ran DDL on the
  // request path. Both objects — payment_allocations (with its cash/bank
  // split columns) and payment_unapplied_credits — are now created by
  // config/bootstrap.js ensureSchema() at startup, so no business method
  // creates or alters a table any more.

  async insertUnappliedCredit(conn, paymentId, customerId, amount, cashAmount, bankAmount, note, userId) {
    const total = Number(amount || 0);
    if (!paymentId || !customerId || total <= 0) return;
    await conn.query(
      `INSERT INTO payment_unapplied_credits(payment_id,customer_id,original_amount,remaining_amount,cash_amount,bank_amount,note,created_by,created_at)
       VALUES(?,?,?,?,?,?,?,?,NOW())`,
      [paymentId, customerId, total, total, Number(cashAmount||0), Number(bankAmount||0), note || 'Tiền khách trả dư chưa phân bổ vào bill', userId || null]
    );
  }

  // GO-LIVE BLOCKER 2 (Sales Return settlement): a completed return can
  // compute a debt reversal larger than what the order's own current
  // debt_amount can absorb (bill already paid down, or fully paid). The
  // excess is not a payment overpayment — there is no payments row behind
  // it, only a sales_returns one — so it goes through this sibling of
  // insertUnappliedCredit() instead, with payment_id left NULL and
  // source_type/source_id pointing at the return. Same shape/semantics as an
  // overpayment credit otherwise: it sits in payment_unapplied_credits until
  // allocateExistingCreditsToOpenBills() (called from OrderAgent.create())
  // applies it to a future bill. Called by ReturnAgent.complete() inside its
  // own transaction — atomicity/idempotency come from that caller's existing
  // single-use status-gate + transaction boundary, not from anything here.
  async insertReturnUnappliedCredit(conn, returnId, customerId, amount, note, userId) {
    const total = Number(amount || 0);
    if (!returnId || !customerId || total <= 0) return;
    await conn.query(
      `INSERT INTO payment_unapplied_credits(payment_id,customer_id,original_amount,remaining_amount,cash_amount,bank_amount,note,source_type,source_id,created_by,created_at)
       VALUES(NULL,?,?,?,0,0,?,'SALES_RETURN',?,?,NOW())`,
      [customerId, total, total, note || 'Tiền dư từ trả hàng chưa phân bổ vào bill', returnId, userId || null]
    );
  }

  // PRODUCTION RELEASE GATE Phase 3 fix: applying an existing unapplied
  // credit (payment overpayment OR sales-return excess) to a new bill wrote
  // orders.debt_amount/paid_amount (via applyPaymentToOrder) and
  // payment_allocations, but posted NO debt_transactions row — breaking the
  // SUM(debt_transactions WHERE order_id=X)==orders.debt_amount invariant
  // every other write path in this file maintains (_ledgerDebtForOrder(),
  // the same read ensureOrderPayableTotal()/applyPaymentToOrder() both
  // trust, would silently overstate this order's debt the moment anything
  // re-derives it from the ledger — same defect class the Gate 3 multi-bill
  // fix closed for the payment-application path). Reproduced live on
  // meatbiz_cr4_rehearsal (verify-p1-credit-allocation-ledger-gap.js) before
  // this fix, confirmed present.
  async allocateExistingCreditsToOpenBills(conn, customerId, userId, transactionDate = null) {
    if (!customerId) return { allocations: [], applied_total: 0 };
    const safeTransactionDate = transactionDate || new Date().toISOString().slice(0, 10);
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
          // Phase 3 fix: mirror the orders.debt_amount reduction just applied
          // above into the append-only ledger — same PAYMENT type/sign
          // convention _ledgerDebtForOrder() already uses for a real cash
          // payment; a credit application reduces debt identically from the
          // ledger's point of view. payment_id is nullable here (a
          // return-sourced credit has none), same as every other nullable
          // payment_id debt_transactions row already written elsewhere.
          await conn.query(
            `INSERT INTO debt_transactions(customer_id,order_id,payment_id,transaction_date,type,amount,note,created_by)
             VALUES(?,?,?,?, 'PAYMENT', ?, ?, ?)`,
            [customerId, o.id, credit.payment_id || null, safeTransactionDate, applied, `Phân bổ tiền dư (credit #${credit.id}) vào bill ${o.order_code}`, userId || null]
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

    // GO-LIVE BLOCKER 3 fix: this used to set debt_amount = targetTotal-paid
    // unconditionally — correct only when total_amount/paid_amount are the
    // WHOLE story, which stops being true the moment a Sales Return posts its
    // own compensating ADJUSTMENT_DECREASE (returns intentionally never touch
    // total_amount, only debt_amount+the ledger — see ReturnAgent.complete()).
    // That blind recompute silently resurrected debt a return had already
    // reversed. Fix: post the installment/bill-growth charge (if any) as its
    // own ledger row FIRST — exactly as before — then derive the new
    // debt_amount from the order's own ledger, which by construction already
    // includes that new row plus every SALE/PAYMENT/return adjustment ever
    // posted for this order.
    const diff = targetTotal - oldTotal;
    if (diff > 0) {
      await conn.query(
        `INSERT INTO debt_transactions(customer_id,order_id,transaction_date,type,amount,note,created_by)
         VALUES(?,?,?,'ADJUSTMENT_INCREASE',?,?,?)`,
        [customerId, orderId, paymentDate, diff, `Bổ sung góp nợ/ngày vào bill`, userId]
      );
    }
    const newDebt = Math.max(0, await this._ledgerDebtForOrder(conn, orderId));
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
        err.status = 409;
        throw err;
      }
      if (row.status === 'FAILED') {
        const err = new Error(row.error_message || 'Giao dịch trước đó bị lỗi. Vui lòng kiểm tra log trước khi thực hiện lại.');
        err.code = 'PAYMENT_PREVIOUS_FAILED';
        err.status = 409;
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

  // GO-LIVE BLOCKER 1: idempotency_key is now mandatory for every payment
  // create request, not opt-in. The dedup infra below (payment_transaction_
  // requests + getIdempotentResult/beginIdempotentRequest/finishIdempotent-
  // Request) already existed and was correct, but every caller was free to
  // omit the key entirely — beginIdempotentRequest()'s own `if(!key) return
  // false` guard silently turned dedup into a no-op whenever that happened,
  // so a double-click/network-retry submit from the "Thu tiền" screen could
  // still create two payments. Rejecting a missing key up front, before any
  // read/write, closes that gap for every caller (route + AI chat).
  async create(data, user) {
    const idempotencyKey = String(data.idempotency_key || data.idempotencyKey || '').trim();
    if (!idempotencyKey) {
      throw Object.assign(new Error('Thiếu idempotency_key cho phiếu thu'), { status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' });
    }
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
      // CR-4: payment_allocations (incl. its cash/bank split columns) and
      // payment_unapplied_credits are created by ensureSchema() at startup —
      // no runtime DDL here. The previous per-request ALTER/CREATE ran before
      // beginTransaction() precisely because MySQL DDL commits implicitly;
      // moving schema ownership to bootstrap removes the hazard entirely.
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
      let currentOrderCode=null;
      let currentOrderDate=null;

      // V6.51.11 final critical fix:
      // Backend must derive installment fields from the order when the UI sends 0.
      // This fixes Thu tiền screen and POS/statistics even if frontend payload is incomplete.
      if(data.order_id){
        const [orders]=await conn.query(
          `SELECT id,order_code,order_date,total_amount,paid_amount,debt_amount,current_bill_amount,installment_amount,monthly_installment_id,calendar_type,lunar_date_text
           FROM orders WHERE id=? FOR UPDATE`,
          [data.order_id]
        );
        if(orders.length){
          const order=orders[0];
          paidBefore=Number(order.paid_amount||0);
          orderDebtBefore=Number(order.debt_amount||0);
          currentOrderCode=order.order_code;
          currentOrderDate=order.order_date;
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
      if (data.order_id) {
        // FEAT (overpay guard): a specific "current bill" is selected — it
        // must be paid first, and any excess beyond its own authoritative
        // remaining may ONLY go to other real outstanding bills the operator
        // explicitly chose (never silently auto-allocated, never dropped as
        // unapplied credit). Reject the whole payment, before writing
        // anything, if that excess can't be fully covered by real debt.
        const currentBillRemaining = await this._authoritativeOrderRemaining(conn, data.order_id);
        let chosenIds = [];
        if (amount > currentBillRemaining + 0.01) {
          const excess = amount - currentBillRemaining;
          const otherBills = await this._authoritativeOtherOpenBills(conn, data.customer_id, data.order_id);
          const totalOtherEligible = otherBills.reduce((s,o)=>s+Number(o.remaining||0),0);
          if (totalOtherEligible <= 0) {
            throw Object.assign(new Error(
              'Số tiền thanh toán lớn hơn số tiền còn lại của bill.\nKhách hàng không còn bill nợ khác để phân bổ số tiền dư.'
            ), {
              status: 400, code: 'PAYMENT_EXCEEDS_AVAILABLE_DEBT',
              details: { current_bill_remaining: currentBillRemaining, entered_amount: amount, surplus: excess }
            });
          }
          if (excess > totalOtherEligible + 0.01) {
            const totalAvailable = currentBillRemaining + totalOtherEligible;
            throw Object.assign(new Error(
              `Tổng công nợ có thể thanh toán: ${totalAvailable.toLocaleString('en-US')}\nTiền nhập: ${amount.toLocaleString('en-US')}\nVượt quá: ${(excess-totalOtherEligible).toLocaleString('en-US')}`
            ), {
              status: 400, code: 'PAYMENT_EXCEEDS_AVAILABLE_DEBT',
              details: { total_available_debt: totalAvailable, entered_amount: amount, over_amount: excess-totalOtherEligible, current_bill_remaining: currentBillRemaining, other_eligible_total: totalOtherEligible, eligible_bills: otherBills }
            });
          }
          chosenIds = Array.isArray(data.allocate_order_ids) ? data.allocate_order_ids.map(Number).filter(Boolean) : [];
          if (!chosenIds.length) {
            throw Object.assign(new Error(
              'Có tiền dư sau khi thanh toán bill hiện tại. Vui lòng chọn bill khác để phân bổ số tiền dư.'
            ), {
              status: 400, code: 'PAYMENT_ALLOCATION_CHOICE_REQUIRED',
              details: { current_bill_remaining: currentBillRemaining, entered_amount: amount, surplus: excess, eligible_bills: otherBills }
            });
          }
          const eligibleById = new Map(otherBills.map(o=>[o.id,o]));
          for (const id of chosenIds) {
            if (!eligibleById.has(id)) {
              throw Object.assign(new Error('Bill được chọn để phân bổ không hợp lệ hoặc đã thay đổi.'), { status: 400, code: 'PAYMENT_ALLOCATION_CHOICE_REQUIRED' });
            }
          }
        }

        const rawAllocations = [];
        const appliedToCurrent = await this._applyPaymentToOrderAuthoritative(conn, data.order_id, amount);
        if (appliedToCurrent > 0) {
          rawAllocations.push({ order_id: Number(data.order_id), order_code: currentOrderCode, order_date: currentOrderDate, applied_amount: appliedToCurrent });
        }
        let excessLeft = amount - appliedToCurrent;
        if (excessLeft > 0.01 && chosenIds.length) {
          const otherBills = await this._authoritativeOtherOpenBills(conn, data.customer_id, data.order_id);
          const eligibleById = new Map(otherBills.map(o=>[o.id,o]));
          for (const id of chosenIds) {
            if (excessLeft <= 0.01) break;
            const bill = eligibleById.get(id);
            if (!bill) continue;
            const applied = await this._applyPaymentToOrderAuthoritative(conn, id, excessLeft);
            if (applied > 0) {
              rawAllocations.push({ order_id: id, order_code: bill.order_code, order_date: bill.order_date, applied_amount: applied });
              excessLeft -= applied;
            }
          }
        }
        if (excessLeft > 0.01) {
          // Defensive — should be unreachable given the validation above
          // already confirmed chosenIds cover the excess; if a chosen bill's
          // remaining shrank between validation and here (a genuine
          // concurrent payment on the same bill), fail closed instead of
          // silently dropping the leftover as unapplied credit.
          throw Object.assign(new Error('Không thể phân bổ hết số tiền dư vào các bill đã chọn. Vui lòng thử lại.'), { status: 400, code: 'PAYMENT_ALLOCATION_CHOICE_REQUIRED' });
        }

        orderAllocations = this.splitAllocationsByTender(rawAllocations, cashAmount, bankAmount);
        oldDebtAllocations = orderAllocations.filter(a=>Number(a.order_id)!==Number(data.order_id));
        billApplied = appliedToCurrent;
        remainingPaid = 0;
        unusedAmount = 0;
      } else {
        // GO-LIVE F7: no pre-selected bill — unchanged auto-allocation by
        // shipping date across every open bill (out of scope for the overpay
        // guard above, which only applies once a specific "current bill" is
        // selected — see PaymentAgent audit note for the overpay-guard task).
        // - clear the remaining debt of BILL1 first
        // - any remaining money must flow into BILL2, BILL3, ...
        // - every receiving bill gets its own payment_allocations row so printing the bill
        //   shows the amount actually applied to that bill.
        const allocResult=await this.allocateCustomerOpenBillsByDate(conn,data.customer_id,remainingPaid);
        orderAllocations=this.splitAllocationsByTender(allocResult.allocations, cashAmount, bankAmount);
        oldDebtAllocations = orderAllocations;
        billApplied = 0;
        remainingPaid=allocResult.remaining;
        if(allocResult.note){
          note = note ? `${note} / Tự động phân bổ theo ngày xuất hàng: ${allocResult.note}` : `Tự động phân bổ theo ngày xuất hàng: ${allocResult.note}`;
        }

        unusedAmount=remainingPaid;
        if(unusedAmount>0){
          note = note ? `${note} / Tiền dư chưa phân bổ: ${unusedAmount}` : `Tiền dư chưa phân bổ: ${unusedAmount}`;
        }
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

      // GATE 3 FIX (multi-bill payment ledger misattribution): a single lump
      // PAYMENT row tied entirely to data.order_id (for the FULL amount) used
      // to be posted here, regardless of how allocateCustomerOpenBillsByDate()
      // above actually split the money across orders. payment_allocations
      // already records the true per-order split (loop just above); this row
      // didn't match it. Concretely: order_id's own per-order ledger
      // (_ledgerDebtForOrder, the source of truth applyPaymentToOrder() and
      // ensureOrderPayableTotal() both read) absorbed the WHOLE payment even
      // when only part of it applied there, while every OTHER bill this same
      // payment actually paid down got no PAYMENT row at all — so a later
      // góp nợ payment made specifically against that other, genuinely fully-
      // paid bill re-derived its debt from the ledger and resurrected it.
      // Fix: post one PAYMENT row per real allocation (same order_id/amount
      // as its payment_allocations row), plus one order_id=NULL row for any
      // leftover parked as unapplied credit — sums to the same customer-level
      // total as before (amount); only the per-order split is now correct.
      const paymentLedgerRows = (orderAllocations || [])
        .filter(a => Number(a.applied_amount || 0) > 0)
        .map(a => ({ order_id: a.order_id, amount: Number(a.applied_amount || 0) }));
      if (Number(unusedAmount || 0) > 0) {
        paymentLedgerRows.push({ order_id: null, amount: Number(unusedAmount) });
      }
      if (!paymentLedgerRows.length) {
        // No allocation happened at all (shouldn't normally occur — unusedAmount
        // absorbs any remainder) — preserve the previous lump-sum behavior.
        paymentLedgerRows.push({ order_id: data.order_id || null, amount });
      }
      for (const row of paymentLedgerRows) {
        await conn.query(
          `INSERT INTO debt_transactions(customer_id,order_id,payment_id,transaction_date,type,amount,note,created_by)
           VALUES(?,?,?,?, 'PAYMENT', ?, ?, ?)`,
          [data.customer_id,row.order_id,insertId,data.payment_date,row.amount,note||`Thu tiền ${code}`,user.id]
        );
      }

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

  // GO-LIVE BLOCKER 3 fix: debtDelta is the exact amount this reverted
  // payment had previously applied to this order (its paid_amount share,
  // already subtracted from paid_amount by the caller before this runs) —
  // restore debt_amount by that same amount instead of recomputing it from
  // total_amount-paid_amount, which has no way to know a Sales Return may
  // have reversed debt on this order in the meantime and would resurrect it.
  // debtDelta=0 (the old, parameterless call shape) preserves the exact
  // previous no-return behavior: paid_amount recalculated, debt_amount left
  // untouched relative to itself.
  async recalcOrderAfterPaymentChange(conn, orderId, debtDelta = 0) {
    if (!orderId) return;
    const [rows] = await conn.query(`SELECT id,total_amount,paid_amount,debt_amount FROM orders WHERE id=? FOR UPDATE`, [orderId]);
    if (!rows.length) return;
    const o = rows[0];
    const total = Number(o.total_amount || 0);
    const paid = Math.max(0, Math.min(total, Number(o.paid_amount || 0)));
    const debt = Math.max(0, Number(o.debt_amount || 0) + Number(debtDelta || 0));
    const status = debt <= 0 ? 'PAID' : paid > 0 ? 'PARTIAL' : 'UNPAID';
    await conn.query(`UPDATE orders SET paid_amount=?, debt_amount=?, payment_status=? WHERE id=?`, [paid, debt, status, orderId]);
  }

  // S8.1A: debt_transactions is append-only — never DELETE or UPDATE a posted
  // row. To undo a payment's ledger effect (edit/cancel), post a compensating
  // ADJUSTMENT row sized to net the payment's current contribution to zero.
  // Computing the net from a fresh SUM (rather than assuming exactly one row)
  // keeps this correct even if the same payment_id is reverted more than once
  // across repeated edits.
  async reverseDebtLedgerForPayment(conn, paymentId, customerId, userId) {
    // GATE 3 FIX: since create() now posts one PAYMENT row per order this
    // payment actually applied to (instead of one lump row), the reversal
    // must net each order_id to zero individually too — a single
    // order_id=NULL compensating row only balanced the CUSTOMER-level total,
    // leaving every per-order ledger (_ledgerDebtForOrder) still showing the
    // original, un-reverted PAYMENT contribution after a cancel/edit.
    // GROUP BY order_id keeps this idempotent across repeated reverts of the
    // same payment_id, same reasoning as the original single-sum query.
    const [rows] = await conn.query(
      `SELECT order_id, COALESCE(SUM(CASE
          WHEN type IN ('SALE','ADJUSTMENT_INCREASE') THEN amount
          WHEN type IN ('PAYMENT','ADJUSTMENT_DECREASE') THEN -amount
          ELSE 0 END),0) net_effect
       FROM debt_transactions WHERE payment_id=?
       GROUP BY order_id`,
      [paymentId]
    );
    const today = new Date().toISOString().slice(0,10);
    for (const row of rows) {
      const net = Number(row.net_effect || 0);
      if (Math.abs(net) < 0.01) continue;
      const reverseType = net < 0 ? 'ADJUSTMENT_INCREASE' : 'ADJUSTMENT_DECREASE';
      await conn.query(
        `INSERT INTO debt_transactions(customer_id,order_id,payment_id,transaction_date,type,amount,note,created_by)
         VALUES(?,?,?,?,?,?,?,?)`,
        [customerId, row.order_id, paymentId, today, reverseType, Math.abs(net), `Đảo bút toán công nợ do sửa/hủy phiếu thu #${paymentId}`, userId || null]
      );
    }
  }

  async revertPaymentEffects(conn, paymentId, userId = null) {
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

    // GO-LIVE BLOCKER 3 fix: a Map of orderId -> total amount reverted for
    // that order (was a Set of just the orderId) so recalcOrderAfterPaymentChange
    // can restore debt by the exact delta instead of recomputing it blind.
    const affected = new Map();
    for (const a of allocRows) {
      const amount = Number(a.amount || 0);
      if (a.order_id && amount > 0) {
        const [orders] = await conn.query(`SELECT id,total_amount,paid_amount FROM orders WHERE id=? FOR UPDATE`, [a.order_id]);
        if (orders.length) {
          const paid = Math.max(0, Number(orders[0].paid_amount || 0) - amount);
          await conn.query(`UPDATE orders SET paid_amount=? WHERE id=?`, [paid, a.order_id]);
          const oid = Number(a.order_id);
          affected.set(oid, (affected.get(oid) || 0) + amount);
        }
      }
    }

    // Backward compatible: older payment rows may not have allocation rows.
    if (!allocRows.length && p.order_id && Number(p.amount || 0) > 0) {
      const [orders] = await conn.query(`SELECT id,total_amount,paid_amount FROM orders WHERE id=? FOR UPDATE`, [p.order_id]);
      if (orders.length) {
        const paid = Math.max(0, Number(orders[0].paid_amount || 0) - Number(p.amount || 0));
        await conn.query(`UPDATE orders SET paid_amount=? WHERE id=?`, [paid, p.order_id]);
        const oid = Number(p.order_id);
        affected.set(oid, (affected.get(oid) || 0) + Number(p.amount || 0));
      }
    }

    for (const [oid, delta] of affected) await this.recalcOrderAfterPaymentChange(conn, oid, delta);

    // GO-LIVE F3: debt_installment_payments was never touched by revert —
    // a cancelled/edited payment that included an installment contribution
    // left this row behind forever, permanently over-stating
    // DebtInstallmentAgent.plans()'s SUM(debt_installment_payments.amount)
    // paid progress for that plan. Snapshot+delete, same treatment as the
    // allocation/credit rows below.
    let installmentRows = [];
    try {
      const [rows] = await conn.query(`SELECT * FROM debt_installment_payments WHERE payment_id=? FOR UPDATE`, [paymentId]);
      installmentRows = rows || [];
    } catch (e) {
      if (!(e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146 || e.code === 'ER_BAD_FIELD_ERROR' || e.errno === 1054))) throw e;
    }

    let unappliedCreditRows = [];
    try {
      const [rows] = await conn.query(`SELECT * FROM payment_unapplied_credits WHERE payment_id=? FOR UPDATE`, [paymentId]);
      unappliedCreditRows = rows || [];
    } catch (e) {
      if (!(e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146))) throw e;
    }

    // GO-LIVE F2 (H-12): payment_allocations/payment_unapplied_credits/
    // debt_installment_payments are about to be hard-deleted below — none of
    // the three has a soft-cancel column of its own (adding one would
    // require every read path, e.g. PaymentAgent.list()'s allocation join
    // and DebtInstallmentAgent.plans()/summary(), to start filtering it — a
    // much wider change than this cleanup calls for). Snapshotting the full
    // row set to audit_logs first — the same shared, entity-agnostic table
    // ReturnAgent.js already writes to — recovers "what did this payment
    // cover before it was reverted" without touching any existing read path.
    // Best-effort: never blocks the revert if audit_logs itself fails to write.
    if (allocRows.length || unappliedCreditRows.length || installmentRows.length) {
      try {
        await conn.query(
          `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, note) VALUES (?,?,?,?,?)`,
          [userId || null, 'PAYMENT_REVERT_SNAPSHOT', 'payments', paymentId, JSON.stringify({
            payment_allocations: allocRows,
            payment_unapplied_credits: unappliedCreditRows,
            debt_installment_payments: installmentRows,
          })]
        );
      } catch (e) { /* best-effort — audit_logs must never block a payment revert */ }
    }

    try { await conn.query(`DELETE FROM payment_allocations WHERE payment_id=?`, [paymentId]); } catch(e) { if (!(e && (e.code==='ER_NO_SUCH_TABLE'||e.errno===1146))) throw e; }
    try { await conn.query(`DELETE FROM payment_unapplied_credits WHERE payment_id=?`, [paymentId]); } catch(e) { if (!(e && (e.code==='ER_NO_SUCH_TABLE'||e.errno===1146))) throw e; }
    try { await conn.query(`DELETE FROM debt_installment_payments WHERE payment_id=?`, [paymentId]); } catch(e) { if (!(e && (e.code==='ER_NO_SUCH_TABLE'||e.errno===1146||e.code==='ER_BAD_FIELD_ERROR'||e.errno===1054))) throw e; }
    try { await this.reverseDebtLedgerForPayment(conn, paymentId, p.customer_id, userId); } catch(e) { if (!(e && (e.code==='ER_BAD_FIELD_ERROR'||e.errno===1054))) throw e; }
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
      // CR-4: schema for payment_allocations / payment_unapplied_credits is
      // owned by ensureSchema() — see create() above.
      await conn.beginTransaction();
      const old = await this.revertPaymentEffects(conn, paymentId, user?.id || null);

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

  // GO-LIVE F5: reason is now mandatory, matching OrderAgent.cancel() /
  // InventoryReceiveService.cancel() — both already require a non-empty
  // reason, checked before a connection is even opened. Payment cancel used
  // to default to a generic reason when none was given.
  async cancel(paymentId, data={}, user={}) {
    const reason = String(data.reason || data.note || '').trim();
    if (!reason) throw Object.assign(new Error('Vui lòng nhập lý do hủy phiếu thu'), { status: 400 });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const old = await this.revertPaymentEffects(conn, paymentId, user?.id || null);
      if (user?.role === 'CUSTOMER' && Number(user.customer_id) !== Number(old.customer_id)) throw new Error('Không có quyền');

      // GO-LIVE F4: `old` was read (SELECT ... FOR UPDATE) inside
      // revertPaymentEffects() BEFORE anything below zeroes it — these are
      // still the pre-cancel amounts. amount/cash_amount/bank_amount
      // continue to zero out exactly as before (every existing
      // SUM(amount)-style reporting query depends on that), but the
      // original values are now preserved in original_* instead of being
      // silently lost, and cancelled_at/cancelled_by/cancel_reason record
      // who/when/why — the same triad orders/inventory_receives already have.
      const originalAmount = Number(old.amount || 0);
      const originalCash = Number(old.cash_amount || 0);
      const originalBank = Number(old.bank_amount || 0);

      try {
        await conn.query(
          `UPDATE payments
           SET status='CANCELLED', amount=0, cash_amount=0, bank_amount=0,
               original_amount=?, original_cash_amount=?, original_bank_amount=?,
               cancelled_at=NOW(), cancelled_by=?, cancel_reason=?,
               note=CONCAT(COALESCE(note,''),' / HỦY: ',?), updated_at=NOW()
           WHERE id=?`,
          [originalAmount, originalCash, originalBank, user?.id || null, reason, reason, paymentId]
        );
      } catch(e) {
        if (e && (e.code==='ER_BAD_FIELD_ERROR' || e.errno===1054)) {
          // Pre-GO-LIVE-migration environment (SchemaMigrationAgent not run
          // yet) — degrade gracefully instead of failing the cancel outright.
          try {
            await conn.query(`UPDATE payments SET status='CANCELLED', amount=0, cash_amount=0, bank_amount=0, note=CONCAT(COALESCE(note,''),' / HỦY: ',?), updated_at=NOW() WHERE id=?`, [reason, paymentId]);
          } catch(e2) {
            if (e2 && (e2.code==='ER_BAD_FIELD_ERROR' || e2.errno===1054)) {
              await conn.query(`UPDATE payments SET amount=0, cash_amount=0, bank_amount=0, note=CONCAT(COALESCE(note,''),' / HỦY: ',?) WHERE id=?`, [reason, paymentId]);
            } else throw e2;
          }
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
