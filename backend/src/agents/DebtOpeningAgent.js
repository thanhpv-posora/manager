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

  // Goods-first priority — identical to PaymentAgent.create()'s installment
  // split (productPaidBefore = MIN(paidBefore, currentBillAmount)) — so "new
  // unpaid goods debt" here can never disagree with how a real payment was
  // actually applied. fromDateExclusive is the opening-debt effective date
  // (orders on/before it are part of the opening baseline, never "new");
  // fromDateInclusive additionally narrows to a reporting period on top of
  // that floor — whichever bound is later wins, both are optional.
  async newUnpaidGoodsDebt(customerId, fromDateExclusive, toDate, fromDateInclusive = null) {
    const where = [`customer_id=?`, `status<>'CANCELLED'`, `order_date<=?`];
    const params = [customerId, toDate];
    if (fromDateExclusive) { where.push('order_date>?'); params.push(fromDateExclusive); }
    if (fromDateInclusive) { where.push('order_date>=?'); params.push(fromDateInclusive); }
    const [[row]] = await pool.query(
      `SELECT COALESCE(SUM(GREATEST(0, COALESCE(current_bill_amount,0) - LEAST(COALESCE(paid_amount,0), COALESCE(current_bill_amount,0)))),0) new_debt
       FROM orders WHERE ${where.join(' AND ')}`,
      params
    );
    return Number(row.new_debt || 0);
  }

  // payments.installment_amount is the REAL amount a receipt actually applied
  // toward the daily góp-nợ contribution (PaymentAgent.js's installmentPaid
  // calc) — never orders.installment_amount, which is only the planned/due
  // amount attached to a bill regardless of what was actually collected.
  async actualContribution(customerId, fromDateInclusive, toDate) {
    const where = [`customer_id=?`, `COALESCE(status,'ACTIVE')<>'CANCELLED'`, `payment_date<=?`];
    const params = [customerId, toDate];
    if (fromDateInclusive) { where.push('payment_date>=?'); params.push(fromDateInclusive); }
    const [[row]] = await pool.query(
      `SELECT COALESCE(SUM(installment_amount),0) contributed FROM payments WHERE ${where.join(' AND ')}`,
      params
    );
    return Number(row.contributed || 0);
  }

  async managementSummary(customerId, query = {}, user) {
    const cid = Number(customerId);
    if (!cid) throw Object.assign(new Error('Thiếu khách hàng'), { status: 400 });
    const [customers] = await pool.query(`SELECT id,name,phone FROM customers WHERE id=?`, [cid]);
    if (!customers.length) throw Object.assign(new Error('Không tìm thấy khách hàng'), { status: 404 });

    const asOf = this.resolveDate(query, 'as_of_');
    const opening = await this.get(cid);
    const openingAmount = Number(opening?.opening_debt_amount || 0);
    const effectiveDate = opening?.effective_date ? String(opening.effective_date).slice(0, 10) : null;

    const totalContributed = await this.actualContribution(cid, effectiveDate, asOf.solarDate);
    const newDebt = await this.newUnpaidGoodsDebt(cid, effectiveDate, asOf.solarDate);
    const remainingDebt = openingAmount - totalContributed + newDebt;

    // Existing ledger-based authority, unchanged — surfaced only for
    // comparison. A difference is reported, never used to silently adjust
    // this management figure or the ledger itself.
    const ledgerCurrentDebt = await DebtInstallmentAgent.customerDebt(cid);

    let periodDetail = null;
    if (query.period_from_date || query.period_to_date || query.period_from_lunar_date_text || query.period_to_lunar_date_text) {
      const from = this.resolveDate({ ...query, calendar_type: query.period_calendar_type, date: query.period_from_date, lunar_date_text: query.period_from_lunar_date_text }, '');
      const to = this.resolveDate({ ...query, calendar_type: query.period_calendar_type, date: query.period_to_date, lunar_date_text: query.period_to_lunar_date_text }, '');
      periodDetail = {
        calendar_type: from.calendarType,
        from_date: from.solarDate,
        to_date: to.solarDate,
        contributed_in_period: await this.actualContribution(cid, from.solarDate, to.solarDate),
        // Both bounds apply: never counts an order before the opening-debt
        // effective date as "new", even if the selected period starts earlier.
        new_debt_in_period: await this.newUnpaidGoodsDebt(cid, effectiveDate, to.solarDate, from.solarDate)
      };
    }

    return {
      customer: customers[0],
      opening_debt: opening,
      as_of_calendar_type: asOf.calendarType,
      as_of_date: asOf.solarDate,
      as_of_lunar_date_text: asOf.calendarType === 'LUNAR' ? asOf.lunarText : solarToLunarText(asOf.solarDate),
      opening_debt_amount: openingAmount,
      total_contributed: totalContributed,
      new_debt: newDebt,
      remaining_debt: remainingDebt,
      ledger_current_debt: ledgerCurrentDebt,
      ledger_difference: remainingDebt - ledgerCurrentDebt,
      period: periodDetail
    };
  }

}

function solarToLunarText(solarDate) {
  const l = solarToLunar(solarDate);
  return `${String(l.day).padStart(2,'0')}/${String(l.month).padStart(2,'0')}/${l.year}`;
}

module.exports = new DebtOpeningAgent();
