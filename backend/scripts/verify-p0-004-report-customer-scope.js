'use strict';
// P0-004 — ReportAgent.dashboard()/revenue()/profit() must never merge
// company-wide retail_daily_summary values into a CUSTOMER-role response.
// Verifies:
//   - ADMIN/STAFF responses DO include the retail_daily_summary contribution
//     (dashboard.summary.total_revenue, revenue()'s retail_amount/pos_revenue,
//     profit()'s retail_revenue).
//   - CUSTOMER responses include ONLY their own permitted order data — no
//     retail contribution anywhere, not even a fabricated 0/absent-vs-present
//     field (revenue() returns raw posRows shape with no pos_revenue/
//     retail_amount keys; profit() rows carry no retail_revenue key at all).
//   - A second customer with no orders on the test date gets no phantom row
//     from the retail data (proves it's not leaking company retail as if it
//     were "their" data via some other path).
//   - Date filters still work on revenue()/profit() after the change.
//   - dashboard/revenue/profit all follow the identical rule.
//
// Self-cleaning: throwaway customer + product + order + one
// retail_daily_summary row on a safe historical test date (2020-01-15,
// confirmed empty on this DB before running), removed in `finally`.

const pool = require('../src/config/db');
const OrderAgent = require('../src/agents/OrderAgent');
const ProductAgent = require('../src/agents/ProductAgent');
const ReportAgent = require('../src/agents/ReportAgent');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

const TEST_DATE = '2020-01-15';
const RETAIL_AMOUNT = 500000;
const ORDER_QTY = 10;
const ORDER_PRICE = 30000;
const ORDER_TOTAL = ORDER_QTY * ORDER_PRICE; // 300,000

async function main() {
  const productIds = [];
  const customerIds = [];
  const orderIds = [];
  let retailRowInserted = false;

  try {
    const [[existingRetail]] = await pool.query(`SELECT COUNT(*) c FROM retail_daily_summary WHERE business_date=?`, [TEST_DATE]);
    const [[existingOrders]] = await pool.query(`SELECT COUNT(*) c FROM orders WHERE order_date=?`, [TEST_DATE]);
    check('Setup precondition: test date is empty of pre-existing retail/order rows', Number(existingRetail.c) === 0 && Number(existingOrders.c) === 0, { existingRetail: existingRetail.c, existingOrders: existingOrders.c });

    // ══════════════════ Seed: product, customer C1 (with order), customer C2 (no order) ══════════════════
    const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const productName = `P0-004 PRODUCT ${uniq}`;
    await ProductAgent.addProduct({ name: productName, unit: 'kg', inventory_mode: 'TRACK_STOCK', sales_flow: 'INVENTORY_SALE', stock_quantity: 100, allow_negative_stock: 0 });
    const [[product]] = await pool.query(`SELECT * FROM products WHERE name=? LIMIT 1`, [productName]);
    productIds.push(product.id);

    const [c1Ins] = await pool.query(
      `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type,partner_type,default_sales_flow)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      [`P004-C1-${uniq}`, 'P0-004 Test Customer C1', '0', 'test', 'COMMON_PRICE', 0, 0, 'SOLAR', 2, 'INVENTORY_SALE']
    );
    const c1Id = c1Ins.insertId;
    customerIds.push(c1Id);

    const [c2Ins] = await pool.query(
      `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type,partner_type,default_sales_flow)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      [`P004-C2-${uniq}`, 'P0-004 Test Customer C2 (no order on test date)', '0', 'test', 'COMMON_PRICE', 0, 0, 'SOLAR', 2, 'INVENTORY_SALE']
    );
    const c2Id = c2Ins.insertId;
    customerIds.push(c2Id);

    const orderResult = await OrderAgent.create({
      customer_id: c1Id, order_date: TEST_DATE,
      items: [{ product_id: product.id, product_name: productName, unit: 'kg', quantity: ORDER_QTY, sale_price: ORDER_PRICE, manual_price: true }],
    }, { id: null, role: 'ADMIN' });
    orderIds.push(orderResult.order_id);
    check('Setup: order created on test date with known total', true, orderResult);

    await pool.query(`INSERT INTO retail_daily_summary(business_date,amount) VALUES(?,?)`, [TEST_DATE, RETAIL_AMOUNT]);
    retailRowInserted = true;

    const admin = { id: null, role: 'ADMIN' };
    const staff = { id: null, role: 'STAFF' };
    const customer1 = { id: null, role: 'CUSTOMER', customer_id: c1Id };
    const customer2 = { id: null, role: 'CUSTOMER', customer_id: c2Id };

    // ══════════════════ dashboard() ══════════════════
    {
      const [[c1OrderSum]] = await pool.query(`SELECT COALESCE(SUM(total_amount),0) v FROM orders WHERE customer_id=? AND status<>'CANCELLED'`, [c1Id]);
      const [[allOrderSum]] = await pool.query(`SELECT COALESCE(SUM(total_amount),0) v FROM orders WHERE status<>'CANCELLED'`);
      const [[allRetailSum]] = await pool.query(`SELECT COALESCE(SUM(amount),0) v FROM retail_daily_summary`);

      const customerDash = await ReportAgent.dashboard(customer1);
      check('dashboard(): CUSTOMER total_revenue == exactly their own order sum (no retail merge)', Number(customerDash.summary.total_revenue) === Number(c1OrderSum.v), { got: customerDash.summary.total_revenue, expected: c1OrderSum.v });

      const adminDash = await ReportAgent.dashboard(admin);
      check('dashboard(): ADMIN total_revenue == all orders + all retail (merge present)', Number(adminDash.summary.total_revenue) === Number(allOrderSum.v) + Number(allRetailSum.v), { got: adminDash.summary.total_revenue, expectedOrders: allOrderSum.v, expectedRetail: allRetailSum.v });

      const staffDash = await ReportAgent.dashboard(staff);
      check('dashboard(): STAFF gets the same merge as ADMIN', Number(staffDash.summary.total_revenue) === Number(adminDash.summary.total_revenue));
    }

    // ══════════════════ revenue() ══════════════════
    {
      const customerRev = await ReportAgent.revenue({ from: TEST_DATE, to: TEST_DATE }, customer1);
      check('revenue(): CUSTOMER gets exactly one row for the test date, revenue == their order total', Array.isArray(customerRev) && customerRev.length === 1 && Number(customerRev[0].revenue) === ORDER_TOTAL, customerRev);
      check('revenue(): CUSTOMER row has NO pos_revenue/retail_amount keys (raw posRows shape, not the merged shape)', customerRev[0] && !('pos_revenue' in customerRev[0]) && !('retail_amount' in customerRev[0]), customerRev[0]);

      const adminRev = await ReportAgent.revenue({ from: TEST_DATE, to: TEST_DATE }, admin);
      const adminRow = adminRev.find(r => String(r.period) === TEST_DATE);
      check('revenue(): ADMIN row for the test date carries the exact seeded retail_amount', !!adminRow && Number(adminRow.retail_amount) === RETAIL_AMOUNT, adminRow);
      check('revenue(): ADMIN revenue = pos_revenue + retail_amount', !!adminRow && Number(adminRow.revenue) === Number(adminRow.pos_revenue) + Number(adminRow.retail_amount), adminRow);

      const staffRev = await ReportAgent.revenue({ from: TEST_DATE, to: TEST_DATE }, staff);
      const staffRow = staffRev.find(r => String(r.period) === TEST_DATE);
      check('revenue(): STAFF gets the same merge as ADMIN', !!staffRow && Number(staffRow.retail_amount) === RETAIL_AMOUNT, staffRow);

      // Second customer, no order on the test date — must get an empty result,
      // never a phantom row derived from the company retail figure.
      const customer2Rev = await ReportAgent.revenue({ from: TEST_DATE, to: TEST_DATE }, customer2);
      check('revenue(): a customer with NO order on the test date gets an empty result (no company retail leaking in as "their" row)', Array.isArray(customer2Rev) && customer2Rev.length === 0, customer2Rev);

      // Date filter regression: a non-overlapping range must not surface the test-date row.
      const customerRevOtherRange = await ReportAgent.revenue({ from: '2021-01-01', to: '2021-01-02' }, customer1);
      check('revenue(): date filter still excludes the test-date row for a non-overlapping range', !customerRevOtherRange.some(r => String(r.period) === TEST_DATE), customerRevOtherRange);
    }

    // ══════════════════ profit() ══════════════════
    {
      const customerProfit = await ReportAgent.profit({ from: TEST_DATE, to: TEST_DATE }, customer1);
      const customerRow = customerProfit.rows.find(r => String(r.period) === TEST_DATE);
      check('profit(): CUSTOMER row exists with revenue == their order total', !!customerRow && Number(customerRow.revenue) === ORDER_TOTAL, customerRow);
      check('profit(): CUSTOMER row has NO retail_revenue key at all (not even 0)', customerRow && !('retail_revenue' in customerRow), customerRow);

      const adminProfit = await ReportAgent.profit({ from: TEST_DATE, to: TEST_DATE }, admin);
      const adminRow = adminProfit.rows.find(r => String(r.period) === TEST_DATE);
      check('profit(): ADMIN row carries the exact seeded retail_revenue', !!adminRow && Number(adminRow.retail_revenue) === RETAIL_AMOUNT, adminRow);
      check('profit(): ADMIN revenue includes the retail contribution (order total + retail)', !!adminRow && Number(adminRow.revenue) === ORDER_TOTAL + RETAIL_AMOUNT, adminRow);

      const staffProfit = await ReportAgent.profit({ from: TEST_DATE, to: TEST_DATE }, staff);
      const staffRow = staffProfit.rows.find(r => String(r.period) === TEST_DATE);
      check('profit(): STAFF gets the same merge as ADMIN', !!staffRow && Number(staffRow.retail_revenue) === RETAIL_AMOUNT, staffRow);

      const customer2Profit = await ReportAgent.profit({ from: TEST_DATE, to: TEST_DATE }, customer2);
      check('profit(): a customer with NO order on the test date gets no row for it', !customer2Profit.rows.some(r => String(r.period) === TEST_DATE), customer2Profit.rows);

      // group_by regression: month grouping still works and still excludes retail for CUSTOMER.
      const customerProfitMonthly = await ReportAgent.profit({ from: TEST_DATE, to: TEST_DATE, group_by: 'month' }, customer1);
      const customerMonthRow = customerProfitMonthly.rows.find(r => String(r.period) === '2020-01');
      check('profit(): group_by=month still works and still has no retail_revenue for CUSTOMER', !!customerMonthRow && !('retail_revenue' in customerMonthRow) && Number(customerMonthRow.revenue) === ORDER_TOTAL, customerMonthRow);
    }

  } finally {
    for (const oid of orderIds) {
      await pool.query(`DELETE FROM order_item_fifo_allocations WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id=?)`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM order_items WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM debt_transactions WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM stock_transactions WHERE reference_type='SALE' AND reference_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM orders WHERE id=?`, [oid]).catch(() => {});
    }
    for (const cid of customerIds) {
      await pool.query(`DELETE FROM debt_transactions WHERE customer_id=?`, [cid]).catch(() => {});
      await pool.query(`DELETE FROM customers WHERE id=?`, [cid]).catch(() => {});
    }
    for (const pid of productIds) {
      await pool.query(`DELETE FROM stock_transactions WHERE product_id=?`, [pid]).catch(() => {});
      await pool.query(`DELETE FROM products WHERE id=?`, [pid]).catch(() => {});
    }
    if (retailRowInserted) {
      await pool.query(`DELETE FROM retail_daily_summary WHERE business_date=?`, [TEST_DATE]).catch(() => {});
    }
    console.log('Cleanup done.');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
