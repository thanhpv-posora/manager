const pool = require('../config/db');
const { parseLunarText, lunarToSolarDate, solarToLunar } = require('../utils/lunarDate');
const DebtInstallmentAgent = require('./DebtInstallmentAgent');

// feat(debt): customer debt MANAGEMENT summary for the existing Góp bill /
// Nợ góp feature. This is a reporting view, not a second accounting engine:
//   - opening debt is an admin-confirmed reference value (customer_opening_debts),
//   - "actual contributed" reads the same field PaymentAgent already writes
//     per real receipt (payments.installment_amount) — never orders.installment_amount,
//     which is only the planned/due amount,
//   - "new debt" reads the same goods-first priority PaymentAgent.create()
//     already applies (current_bill_amount, paid_amount) — never touches
//     debt_transactions or orders.total_amount.
// It never writes to debt_transactions/orders/payments, so it can never
// diverge from — or be forced to match — the existing ledger-based current
// debt shown elsewhere in the app; a difference is reported, not hidden.
class DebtOpeningAgent {
  constructor() { this.version = '6.66.0'; this.responsibility = 'Admin-managed opening debt + read-only debt management summary for the Góp bill feature'; }

  resolveDate(query = {}, prefix = '') {
    const calendarType = String(query[`${prefix}calendar_type`] || query.calendar_type || 'SOLAR').toUpperCase() === 'LUNAR' ? 'LUNAR' : 'SOLAR';
    if (calendarType === 'LUNAR') {
      const lunarText = String(query[`${prefix}lunar_date_text`] || '').trim();
      const lunar = parseLunarText(lunarText);
      if (!lunar) throw Object.assign(new Error('Vui lòng chọn ngày âm lịch hợp lệ (DD/MM/YYYY)'), { status: 400 });
      const solarDate = lunarToSolarDate(lunar);
      if (!solarDate) throw Object.assign(new Error('Không thể quy đổi ngày âm lịch sang dương lịch'), { status: 400 });
      return { calendarType, solarDate, lunarText };
    }
    const solarDate = String(query[`${prefix}date`] || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(solarDate)) throw Object.assign(new Error('Vui lòng chọn ngày hợp lệ'), { status: 400 });
    return { calendarType, solarDate, lunarText: '' };
  }

  async get(customerId) {
    const [rows] = await pool.query(`SELECT * FROM customer_opening_debts WHERE customer_id=? LIMIT 1`, [customerId]);
    return rows[0] || null;
  }

  // ADMIN-only at the route level (BR-CORE-006/BR-SCOPE — STAFF may view,
  // not change, per the feature spec). One authoritative row per customer;
  // the previous value is snapshotted to audit_logs before being overwritten
  // so it is never silently lost, same idiom PaymentAgent.revertPaymentEffects()
  // already uses for payment_allocations/payment_unapplied_credits.
  async set(customerId, data, user) {
    const cid = Number(customerId);
    if (!cid) throw Object.assign(new Error('Thiếu khách hàng'), { status: 400 });
    const amount = Number(data.opening_debt_amount ?? data.amount ?? 0);
    if (amount < 0) throw Object.assign(new Error('Nợ tổng ban đầu không được âm'), { status: 400 });

    const resolved = this.resolveDate(data, 'effective_');
    const note = String(data.note || '').slice(0, 2000);

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [existingRows] = await conn.query(`SELECT * FROM customer_opening_debts WHERE customer_id=? FOR UPDATE`, [cid]);
      if (existingRows.length) {
        await conn.query(
          `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, note) VALUES (?,?,?,?,?)`,
          [user?.id || null, 'OPENING_DEBT_UPDATE', 'customer_opening_debts', cid, JSON.stringify({ previous: existingRows[0] })]
        );
        await conn.query(
          `UPDATE customer_opening_debts SET opening_debt_amount=?, effective_date=?, calendar_type=?, lunar_date_text=?, note=?, updated_by=? WHERE customer_id=?`,
          [amount, resolved.solarDate, resolved.calendarType, resolved.lunarText || null, note, user?.id || null, cid]
        );
      } else {
        await conn.query(
          `INSERT INTO customer_opening_debts (customer_id, opening_debt_amount, effective_date, calendar_type, lunar_date_text, note, created_by, updated_by)
           VALUES (?,?,?,?,?,?,?,?)`,
          [cid, amount, resolved.solarDate, resolved.calendarType, resolved.lunarText || null, note, user?.id || null, user?.id || null]
        );
      }
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }

    return this.get(cid);
  }

  // FINAL BUSINESS FORMULA (confirmed):
  //   CURRENT TOTAL DEBT = OPENING DEBT - TOTAL BILL CONTRIBUTION + TOTAL OUTSTANDING BILL BALANCE
  // where, per valid (non-CANCELLED) bill from the opening-debt effective
  // date through the as-of date:
  //   contribution = orders.installment_amount — the góp/ngày amount
  //     ATTACHED to the bill at creation, counted whether or not the bill
  //     has been paid yet. Deliberately NOT payments.installment_amount
  //     (that is "actually collected", a different, explicitly rejected
  //     metric for this formula).
  //   remaining    = MAX(0, total_amount - paid_amount)
  // orders.paid_amount is the authority for "effective paid amount" — it is
  // the one field every payment mutation path (PaymentAgent.create/update/
  // cancel, via applyPaymentToOrder/recalcOrderAfterPaymentChange) already
  // keeps in sync net of allocations, edits, and reversals, so a cancelled
  // or reverted payment's contribution is already backed out by the time
  // this reads it. payment_allocations is not needed here.
  // current_bill_amount/total_amount both fall back to the same pre-V6.51
  // derivation PaymentAgent.create() already uses for legacy rows, so the
  // goods+contribution=total_amount identity holds for every row read here.
  async billsInRange(customerId, fromDateInclusive, toDate) {
    const where = [`customer_id=?`, `status<>'CANCELLED'`, `order_date<=?`];
    const params = [customerId, toDate];
    if (fromDateInclusive) { where.push('order_date>=?'); params.push(fromDateInclusive); }
    const [rows] = await pool.query(
      `SELECT id,order_code,order_date,current_bill_amount,installment_amount,total_amount,paid_amount,payment_status
       FROM orders WHERE ${where.join(' AND ')} ORDER BY order_date ASC,id ASC`,
      params
    );
    return rows.map(r => {
      const totalAmount = Number(r.total_amount || 0);
      const installmentAmount = Number(r.installment_amount || 0);
      const goodsAmount = Number(r.current_bill_amount || 0) > 0
        ? Number(r.current_bill_amount || 0)
        : Math.max(0, totalAmount - installmentAmount);
      const paidAmount = Number(r.paid_amount || 0);
      const remainingAmount = Math.max(0, totalAmount - paidAmount);
      return {
        order_id: r.id, order_code: r.order_code, order_date: r.order_date,
        goods_amount: goodsAmount, contribution_amount: installmentAmount, bill_total: totalAmount,
        paid_amount: paidAmount, remaining_amount: remainingAmount, payment_status: r.payment_status
      };
    });
  }

  async managementSummary(customerId, query = {}, user) {
    const cid = Number(customerId);
    if (!cid) throw Object.assign(new Error('Thiếu khách hàng'), { status: 400 });
    const [customers] = await pool.query(`SELECT id,name,phone FROM customers WHERE id=?`, [cid]);
    if (!customers.length) throw Object.assign(new Error('Không tìm thấy khách hàng'), { status: 404 });

    const asOf = this.resolveDate(query, 'as_of_');
    const opening = await this.get(cid);
    const effectiveDate = opening?.effective_date ? String(opening.effective_date).slice(0, 10) : null;
    // LOCKED RULE: opening debt only applies when as_of_date >= effective_date.
    const openingApplicable = !!opening && (!effectiveDate || asOf.solarDate >= effectiveDate);
    const openingAmount = openingApplicable ? Number(opening.opening_debt_amount || 0) : 0;

    const bills = await this.billsInRange(cid, effectiveDate, asOf.solarDate);
    const agg = this.aggregate(openingAmount, bills);

    // Existing ledger-based authority, unchanged — surfaced only for
    // comparison. A difference is reported, never used to silently adjust
    // this management figure or the ledger itself.
    const ledgerCurrentDebt = await DebtInstallmentAgent.customerDebt(cid);

    return {
      customer: customers[0],
      opening_debt: opening,
      opening_applicable: openingApplicable,
      as_of_calendar_type: asOf.calendarType,
      as_of_date: asOf.solarDate,
      as_of_lunar_date_text: asOf.calendarType === 'LUNAR' ? asOf.lunarText : solarToLunarText(asOf.solarDate),
      ...agg,
      ledger_current_debt: ledgerCurrentDebt,
      ledger_difference: agg.current_total_debt - ledgerCurrentDebt,
      contribution_bills: bills,
      outstanding_bills: bills.filter(b => b.remaining_amount > 0)
    };
  }

  // Pure aggregation — no I/O — so the exact business-confirmed test matrix
  // can be run against this real code path without touching the database.
  // FINAL BUSINESS FORMULA: current_total_debt = opening - contribution + outstanding.
  // Algebraic invariant (BillTotal=Goods+Contribution, Remaining=BillTotal-Paid
  // => Opening-Contribution+Remaining === Opening+Goods-Paid) is recomputed from
  // the exact same per-bill rows every call, so any mismatch means a real bug
  // in this method, not a data-timing race — surfaced, never hidden.
  aggregate(openingAmount, bills) {
    const totalContribution = bills.reduce((s, b) => s + b.contribution_amount, 0);
    const totalOutstanding = bills.reduce((s, b) => s + b.remaining_amount, 0);
    const totalGoods = bills.reduce((s, b) => s + b.goods_amount, 0);
    const totalPaid = bills.reduce((s, b) => s + b.paid_amount, 0);

    const currentTotalDebt = openingAmount - totalContribution + totalOutstanding;
    const reconciliationDebt = openingAmount + totalGoods - totalPaid;
    const reconciliationDifference = currentTotalDebt - reconciliationDebt;

    return {
      opening_debt_amount: openingAmount,
      total_contribution: totalContribution,
      total_outstanding: totalOutstanding,
      current_total_debt: currentTotalDebt,
      reconciliation: {
        total_goods: totalGoods,
        total_paid: totalPaid,
        formula_result: reconciliationDebt,
        matches: Math.abs(reconciliationDifference) < 0.01,
        difference: reconciliationDifference
      }
    };
  }

}

function solarToLunarText(solarDate) {
  const l = solarToLunar(solarDate);
  return `${String(l.day).padStart(2,'0')}/${String(l.month).padStart(2,'0')}/${l.year}`;
}

module.exports = new DebtOpeningAgent();
