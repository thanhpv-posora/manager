'use strict';
// Row-level Price Book Item lock — final verification against the exact spec cases.
// Exercises real DB code paths (PriceMatrixAgent.getBook/updateBook) against a single
// throwaway test customer + throwaway orders, cleaned up in `finally` regardless of pass/fail.
// Does not touch any pre-existing customer/product/order/price-book data.
//
// Uses real products from the "Thịt bò" category matching the spec's case names exactly:
// Đùi, Sườn (both marked "used in bill" -> locked), Vụn (never used -> unlocked), Gân 50 (new item added after book already has a paid bill).

const pool = require('../src/config/db');
const PriceMatrixAgent = require('../src/agents/PriceMatrixAgent');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}

async function main() {
  let testCustomerId = null;
  const testOrderIds = [];
  let testCategoryId = null;
  let testBookId = null;

  try {
    const [[beefCat]] = await pool.query(`SELECT id FROM product_categories WHERE name='Thịt bò' LIMIT 1`);
    const [[duiP]] = await pool.query(`SELECT id,name,unit FROM products WHERE category_id=? AND del_flg=0 AND name='Đùi' LIMIT 1`, [beefCat.id]);
    const [[suonP]] = await pool.query(`SELECT id,name,unit FROM products WHERE category_id=? AND del_flg=0 AND name='Sườn' LIMIT 1`, [beefCat.id]);
    const [[vunP]] = await pool.query(`SELECT id,name,unit FROM products WHERE category_id=? AND del_flg=0 AND name='Vụn' LIMIT 1`, [beefCat.id]);
    const [[ganP]] = await pool.query(`SELECT id,name,unit FROM products WHERE category_id=? AND del_flg=0 AND name='Gân 50' LIMIT 1`, [beefCat.id]);
    if (!duiP || !suonP || !vunP || !ganP) throw new Error('Missing one of Đùi/Sườn/Vụn/Gân 50 in Thịt bò category');
    console.log(`Đùi=${duiP.id} Sườn=${suonP.id} Vụn=${vunP.id} Gân 50=${ganP.id}`);

    const [custIns] = await pool.query(
      `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type)
       VALUES(?,?,?,?,?,?,?,?)`,
      [`ROWLOCK-TEST-${Date.now()}`, 'Row Lock Verify Test Customer', '0000000000', 'test', 'PRIVATE_PRICE', 0, 0, 'SOLAR']
    );
    testCustomerId = custIns.insertId;

    const cpc = await PriceMatrixAgent.createCustomerPriceCategory(testCustomerId, beefCat.id, {});
    testCategoryId = cpc.id;

    const EFFECTIVE_DATE = '2026-08-05';
    await PriceMatrixAgent.saveMatrix(
      testCustomerId,
      [
        { product_id: duiP.id, private_price: 200000, in_catalog: true },
        { product_id: suonP.id, private_price: 150000, in_catalog: true },
        { product_id: vunP.id, private_price: 30000, in_catalog: true },
      ],
      null,
      { effective_from: EFFECTIVE_DATE, effective_calendar_type: 'SOLAR' },
      beefCat.id
    );
    const [[bookRow]] = await pool.query(`SELECT id FROM customer_price_books WHERE customer_id=? LIMIT 1`, [testCustomerId]);
    testBookId = bookRow.id;
    console.log(`Created price book id=${testBookId}`);

    // Simulate "Đùi + Sườn used in bill", and the order is PAID so the book HEADER is also
    // locked — proving Case 4 (adding a new item) works even while the header is locked.
    const [orderIns] = await pool.query(
      `INSERT INTO orders(order_code,customer_id,order_date,status,payment_status,total_amount,paid_amount,debt_amount)
       VALUES(?,?,?,?,?,?,?,?)`,
      [`ROWLOCK-ORDER-${Date.now()}`, testCustomerId, EFFECTIVE_DATE, 'CONFIRMED', 'PAID', 700000, 700000, 0]
    );
    const testOrderId = orderIns.insertId;
    testOrderIds.push(testOrderId);
    await pool.query(
      `INSERT INTO order_items(order_id,product_id,product_name,unit,quantity,sale_price,total_price,price_type,price_book_id)
       VALUES(?,?,?,?,?,?,?,?,?),(?,?,?,?,?,?,?,?,?)`,
      [
        testOrderId, duiP.id, duiP.name, duiP.unit || 'kg', 2, 200000, 400000, 'PRICE_BOOK', testBookId,
        testOrderId, suonP.id, suonP.name, suonP.unit || 'kg', 2, 150000, 300000, 'PRICE_BOOK', testBookId,
      ]
    );
    console.log(`Created throwaway PAID order id=${testOrderId} using Đùi + Sườn from this price book`);

    // ── Header lock check (KEEP — unchanged behavior) ──
    const book0 = await PriceMatrixAgent.getBook(testBookId);
    check('Header: book is locked (paid bill exists) — effective date/calendar/status/book info', book0.can_edit === false, JSON.stringify({can_edit: book0.can_edit}));

    // ── getBook: per-item lock flags ──
    const duiItem1 = book0.items.find(i => Number(i.product_id) === duiP.id);
    const suonItem1 = book0.items.find(i => Number(i.product_id) === suonP.id);
    const vunItem1 = book0.items.find(i => Number(i.product_id) === vunP.id);
    check('Case 1: Đùi (used in bill) — can_edit=false, can_delete=false', duiItem1 && duiItem1.can_edit === false && duiItem1.can_delete === false, JSON.stringify(duiItem1));
    check('Case 1: Đùi lock_reason === "🔒 Đã sử dụng trong bill"', duiItem1 && duiItem1.lock_reason === '🔒 Đã sử dụng trong bill', JSON.stringify(duiItem1));
    check('Case 2: Sườn (used in bill) — can_edit=false, can_delete=false', suonItem1 && suonItem1.can_edit === false && suonItem1.can_delete === false, JSON.stringify(suonItem1));
    check('Case 2: Sườn lock_reason === "🔒 Đã sử dụng trong bill"', suonItem1 && suonItem1.lock_reason === '🔒 Đã sử dụng trong bill', JSON.stringify(suonItem1));
    check('Case 3: Vụn (never used) — can_edit=true, can_delete=true', vunItem1 && vunItem1.can_edit === true && vunItem1.can_delete === true, JSON.stringify(vunItem1));

    // ── updateBook: attempt to edit Đùi + Sườn (locked, must be ignored), edit Vụn (unlocked,
    //    must apply), and add Gân 50 as a brand-new item (must apply even though header is
    //    locked and other rows in this same payload are locked) ──
    const attemptedItems = [
      { product_id: duiP.id, sale_price: 999999, note: 'attempted-edit-should-be-ignored' },
      { product_id: suonP.id, sale_price: 888888, note: 'attempted-edit-should-be-ignored' },
      { product_id: vunP.id, sale_price: 33000, note: 'edited' },
      { product_id: ganP.id, sale_price: 50000, note: 'Gân 50' },
    ];
    const updateResult = await PriceMatrixAgent.updateBook(testBookId, { items: attemptedItems }, null);
    check('Case 4: updateBook succeeds — new item (Gân 50) added even though header + other rows are locked', !!updateResult, JSON.stringify(updateResult));

    const book1 = await PriceMatrixAgent.getBook(testBookId);
    const duiItem2 = book1.items.find(i => Number(i.product_id) === duiP.id);
    const suonItem2 = book1.items.find(i => Number(i.product_id) === suonP.id);
    const vunItem2 = book1.items.find(i => Number(i.product_id) === vunP.id);
    const ganItem2 = book1.items.find(i => Number(i.product_id) === ganP.id);
    check('Case 1: Đùi price/note unchanged after attempted edit (still 200000)', duiItem2 && Number(duiItem2.sale_price) === 200000 && duiItem2.note !== 'attempted-edit-should-be-ignored', JSON.stringify(duiItem2));
    check('Case 2: Sườn price/note unchanged after attempted edit (still 150000)', suonItem2 && Number(suonItem2.sale_price) === 150000 && suonItem2.note !== 'attempted-edit-should-be-ignored', JSON.stringify(suonItem2));
    check('Case 3: Vụn price successfully updated to 33000', vunItem2 && Number(vunItem2.sale_price) === 33000, JSON.stringify(vunItem2));
    check('Case 4: Gân 50 inserted at 50000', ganItem2 && Number(ganItem2.sale_price) === 50000, JSON.stringify(ganItem2));

    // ── Case 3 (delete): remove Vụn (unlocked) by omitting it from the payload; keep
    //    attempting to remove Đùi/Sườn (locked) by omission too — must be rejected/kept ──
    const afterDeleteItems = [
      { product_id: ganP.id, sale_price: 50000, note: 'Gân 50' },
      // Đùi, Sườn, Vụn all omitted -> locked ones must survive, Vụn (unlocked) must be deleted
    ];
    await PriceMatrixAgent.updateBook(testBookId, { items: afterDeleteItems }, null);
    const book2 = await PriceMatrixAgent.getBook(testBookId);
    const duiItem3 = book2.items.find(i => Number(i.product_id) === duiP.id);
    const suonItem3 = book2.items.find(i => Number(i.product_id) === suonP.id);
    const vunItem3 = book2.items.find(i => Number(i.product_id) === vunP.id);
    check('Case 3: Vụn (unlocked) deleted by omission from payload', !vunItem3, JSON.stringify(book2.items.map(i => i.product_id)));
    check('Case 1: Đùi (locked) row rejected delete — still present, price unchanged', !!duiItem3 && Number(duiItem3.sale_price) === 200000, JSON.stringify(duiItem3));
    check('Case 2: Sườn (locked) row rejected delete — still present, price unchanged', !!suonItem3 && Number(suonItem3.sale_price) === 150000, JSON.stringify(suonItem3));

    // ── Case 5: historical OrderItem rows for Đùi + Sườn are completely unchanged ──
    const [historicalItems] = await pool.query(
      `SELECT product_id, sale_price, total_price, quantity FROM order_items WHERE order_id=? ORDER BY product_id`,
      [testOrderId]
    );
    const histDui = historicalItems.find(r => Number(r.product_id) === duiP.id);
    const histSuon = historicalItems.find(r => Number(r.product_id) === suonP.id);
    check('Case 5: historical Đùi OrderItem sale_price/total_price unchanged', histDui && Number(histDui.sale_price) === 200000 && Number(histDui.total_price) === 400000, JSON.stringify(histDui));
    check('Case 5: historical Sườn OrderItem sale_price/total_price unchanged', histSuon && Number(histSuon.sale_price) === 150000 && Number(histSuon.total_price) === 300000, JSON.stringify(histSuon));

  } finally {
    // ── Cleanup: remove only what this script created ──
    for (const oid of testOrderIds) {
      await pool.query(`DELETE FROM order_items WHERE order_id=?`, [oid]);
      await pool.query(`DELETE FROM orders WHERE id=?`, [oid]);
    }
    if (testBookId) {
      await pool.query(`DELETE FROM customer_price_book_items WHERE price_book_id=?`, [testBookId]);
      await pool.query(`DELETE FROM customer_price_books WHERE id=?`, [testBookId]);
    }
    if (testCategoryId) {
      await pool.query(`DELETE FROM customer_price_categories WHERE id=?`, [testCategoryId]);
    }
    if (testCustomerId) {
      await pool.query(`DELETE FROM price_change_logs WHERE customer_id=?`, [testCustomerId]);
      await pool.query(`DELETE FROM customer_product_catalogs WHERE customer_id=?`, [testCustomerId]);
      await pool.query(`DELETE FROM customers WHERE id=?`, [testCustomerId]);
    }
    console.log('Cleanup done (test customer + throwaway order + price book removed).');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
