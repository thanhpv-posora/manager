'use strict';
// S8.2d Daily Bill Contribution — Effective Date verification.
//
// Business rule: a debt_monthly_installments row is effective FROM its
// configured (year, month, day) and remains effective until a newer ACTIVE
// row replaces it — it is NOT scoped to the exact (month, year) it was
// entered under. Verifies DebtMonthlyInstallmentAgent.getActiveInstallment()'s
// new latest-effective-date lookup against the real customer_id=4 (Hồng Hiền)
// LUNAR configuration, plus a throwaway customer for the no-config and SOLAR
// scenarios.
//
// Self-cleaning: only ever inserts/deletes rows this script itself creates.
// The pre-existing real row for customer_id=4 (May 2026, 3,000,000) is never
// modified or deleted — only read.

const pool = require('../src/config/db');
const DebtMonthlyInstallmentAgent = require('../src/agents/DebtMonthlyInstallmentAgent');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

const REAL_CUSTOMER_ID = 4; // Hồng Hiền — real, pre-existing, LUNAR, 12/05/2026, 3,000,000, ACTIVE

async function active(customerId, dateText, calendarType, lunarDateText) {
  const r = await DebtMonthlyInstallmentAgent.activeByDate(customerId, dateText, calendarType, lunarDateText);
  return Number(r.installment_amount || 0);
}

async function main() {
  const tempRowIds = [];
  let throwawayCustomerId = null;

  try {
    // ══════════════════════ Baseline: confirm the real row is exactly as described ══════════════════════
    const [[baseline]] = await pool.query(
      `SELECT installment_day, installment_month, installment_year, calendar_type, installment_amount, status
       FROM debt_monthly_installments
       WHERE customer_id=? AND calendar_type='LUNAR' AND installment_month=5 AND installment_year=2026 AND installment_day=12`,
      [REAL_CUSTOMER_ID]
    );
    check('Baseline: real customer_id=4 row exists exactly as described (12/05/2026 LUNAR, 3,000,000, ACTIVE)',
      !!baseline && Number(baseline.installment_amount) === 3000000 && baseline.status === 'ACTIVE', baseline);

    // ══════════════════════ Scenarios 1-5: effective-from, no newer config yet ══════════════════════
    check('1. 11/05/2026 LUNAR (before effective day) -> 0', await active(REAL_CUSTOMER_ID, null, 'LUNAR', '11/05/2026') === 0,
      await active(REAL_CUSTOMER_ID, null, 'LUNAR', '11/05/2026'));

    check('2. 12/05/2026 LUNAR (exact effective day) -> 3,000,000', await active(REAL_CUSTOMER_ID, null, 'LUNAR', '12/05/2026') === 3000000,
      await active(REAL_CUSTOMER_ID, null, 'LUNAR', '12/05/2026'));

    check('3. 25/05/2026 LUNAR (same month, later day) -> 3,000,000', await active(REAL_CUSTOMER_ID, null, 'LUNAR', '25/05/2026') === 3000000,
      await active(REAL_CUSTOMER_ID, null, 'LUNAR', '25/05/2026'));

    check('4. 02/06/2026 LUNAR (next month — the reported bug) -> 3,000,000', await active(REAL_CUSTOMER_ID, null, 'LUNAR', '02/06/2026') === 3000000,
      await active(REAL_CUSTOMER_ID, null, 'LUNAR', '02/06/2026'));

    check('5. 01/08/2026 LUNAR (later lunar month, still no newer config) -> 3,000,000', await active(REAL_CUSTOMER_ID, null, 'LUNAR', '01/08/2026') === 3000000,
      await active(REAL_CUSTOMER_ID, null, 'LUNAR', '01/08/2026'));

    // ══════════════════════ Scenario 6: temporary newer configuration ══════════════════════
    {
      const [ins] = await pool.query(
        `INSERT INTO debt_monthly_installments(customer_id,installment_day,installment_month,installment_year,calendar_type,installment_amount,status)
         VALUES(?,?,?,?,?,?,?)`,
        [REAL_CUSTOMER_ID, 10, 6, 2026, 'LUNAR', 4000000, 'ACTIVE']
      );
      tempRowIds.push(ins.insertId);

      check('6a. 09/06/2026 LUNAR (day before the newer config) -> still 3,000,000', await active(REAL_CUSTOMER_ID, null, 'LUNAR', '09/06/2026') === 3000000,
        await active(REAL_CUSTOMER_ID, null, 'LUNAR', '09/06/2026'));

      check('6b. 10/06/2026 LUNAR (exact new effective day) -> 4,000,000', await active(REAL_CUSTOMER_ID, null, 'LUNAR', '10/06/2026') === 4000000,
        await active(REAL_CUSTOMER_ID, null, 'LUNAR', '10/06/2026'));

      check('6c. 15/07/2026 LUNAR (after the newer config) -> 4,000,000', await active(REAL_CUSTOMER_ID, null, 'LUNAR', '15/07/2026') === 4000000,
        await active(REAL_CUSTOMER_ID, null, 'LUNAR', '15/07/2026'));

      check('6d. 25/05/2026 LUNAR (older date, before either config change) -> still 3,000,000', await active(REAL_CUSTOMER_ID, null, 'LUNAR', '25/05/2026') === 3000000,
        await active(REAL_CUSTOMER_ID, null, 'LUNAR', '25/05/2026'));

      // Clean up the temporary row now, then re-verify the real row is untouched and back to sole authority.
      await pool.query(`DELETE FROM debt_monthly_installments WHERE id=?`, [tempRowIds.pop()]);

      check('6e. After cleanup: 02/06/2026 LUNAR reverts to 3,000,000 (real row untouched)', await active(REAL_CUSTOMER_ID, null, 'LUNAR', '02/06/2026') === 3000000,
        await active(REAL_CUSTOMER_ID, null, 'LUNAR', '02/06/2026'));
    }

    // ══════════════════════ Scenario 7: customer without any configuration ══════════════════════
    {
      const [custIns] = await pool.query(
        `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type)
         VALUES(?,?,?,?,?,?,?,?)`,
        [`S82D-CUST-${Date.now()}`, 'S8.2d Verify Test Customer', '0', 'test', 'PRIVATE_PRICE', 0, 0, 'SOLAR']
      );
      throwawayCustomerId = custIns.insertId;

      const amountLunar = await active(throwawayCustomerId, null, 'LUNAR', '02/06/2026');
      check('7. Customer with no configuration -> 0 (no Góp/ngày row)', amountLunar === 0, amountLunar);
    }

    // ══════════════════════ Scenario 8: SOLAR configurations follow the same effective-from rule ══════════════════════
    {
      const [ins1] = await pool.query(
        `INSERT INTO debt_monthly_installments(customer_id,installment_day,installment_month,installment_year,calendar_type,installment_amount,status)
         VALUES(?,?,?,?,?,?,?)`,
        [throwawayCustomerId, 12, 5, 2026, 'SOLAR', 2000000, 'ACTIVE']
      );
      tempRowIds.push(ins1.insertId);

      check('8a. SOLAR 2026-05-11 (before effective day) -> 0', await active(throwawayCustomerId, '2026-05-11', 'SOLAR', '') === 0,
        await active(throwawayCustomerId, '2026-05-11', 'SOLAR', ''));
      check('8b. SOLAR 2026-05-12 (exact effective day) -> 2,000,000', await active(throwawayCustomerId, '2026-05-12', 'SOLAR', '') === 2000000,
        await active(throwawayCustomerId, '2026-05-12', 'SOLAR', ''));
      check('8c. SOLAR 2026-06-02 (next month, no newer config) -> 2,000,000', await active(throwawayCustomerId, '2026-06-02', 'SOLAR', '') === 2000000,
        await active(throwawayCustomerId, '2026-06-02', 'SOLAR', ''));

      const [ins2] = await pool.query(
        `INSERT INTO debt_monthly_installments(customer_id,installment_day,installment_month,installment_year,calendar_type,installment_amount,status)
         VALUES(?,?,?,?,?,?,?)`,
        [throwawayCustomerId, 10, 6, 2026, 'SOLAR', 2500000, 'ACTIVE']
      );
      tempRowIds.push(ins2.insertId);

      check('8d. SOLAR 2026-06-09 (day before newer config) -> still 2,000,000', await active(throwawayCustomerId, '2026-06-09', 'SOLAR', '') === 2000000,
        await active(throwawayCustomerId, '2026-06-09', 'SOLAR', ''));
      check('8e. SOLAR 2026-06-10 (exact new effective day) -> 2,500,000', await active(throwawayCustomerId, '2026-06-10', 'SOLAR', '') === 2500000,
        await active(throwawayCustomerId, '2026-06-10', 'SOLAR', ''));
      check('8f. SOLAR 2026-07-15 (well after newer config) -> 2,500,000', await active(throwawayCustomerId, '2026-07-15', 'SOLAR', '') === 2500000,
        await active(throwawayCustomerId, '2026-07-15', 'SOLAR', ''));

      // LUNAR/SOLAR isolation: this throwaway customer's SOLAR configs must never leak into a LUNAR lookup.
      check('8g. Same customer, LUNAR calendar -> 0 (no LUNAR config exists, SOLAR rows do not leak across calendar_type)',
        await active(throwawayCustomerId, null, 'LUNAR', '02/06/2026') === 0,
        await active(throwawayCustomerId, null, 'LUNAR', '02/06/2026'));
    }

    // ══════════════════════ Final safety check: real customer's baseline row is untouched ══════════════════════
    const [[finalRow]] = await pool.query(
      `SELECT installment_day, installment_month, installment_year, calendar_type, installment_amount, status
       FROM debt_monthly_installments
       WHERE customer_id=? AND calendar_type='LUNAR' AND installment_month=5 AND installment_year=2026 AND installment_day=12`,
      [REAL_CUSTOMER_ID]
    );
    check('Final: real customer_id=4 row is byte-identical to baseline (untouched by this script)',
      JSON.stringify(finalRow) === JSON.stringify(baseline), { baseline, finalRow });

    const [[realCount]] = await pool.query(`SELECT COUNT(*) cnt FROM debt_monthly_installments WHERE customer_id=?`, [REAL_CUSTOMER_ID]);
    check('Final: real customer_id=4 has exactly 1 row (no leftover temp rows)', Number(realCount.cnt) === 1, realCount.cnt);

  } finally {
    for (const id of tempRowIds) {
      await pool.query(`DELETE FROM debt_monthly_installments WHERE id=?`, [id]).catch(() => {});
    }
    if (throwawayCustomerId) {
      await pool.query(`DELETE FROM debt_monthly_installments WHERE customer_id=?`, [throwawayCustomerId]).catch(() => {});
      await pool.query(`DELETE FROM customers WHERE id=?`, [throwawayCustomerId]).catch(() => {});
    }
    console.log('Cleanup done.');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
