'use strict';
// Verifies the "+ Thêm mặt hàng chưa có trong bảng giá" bug fix at the API/agent level
// (candidates must be computed from the book's OWN category, not the page's shared `rows`
// state). Simulates the exact frontend call sequence: getBook -> matrix(book.customer_id,
// book.category_id) -> filter out existing items -> updateBook with a new item added.
// Self-cleaning: creates a throwaway customer + category + price book + order, removed in
// `finally` regardless of pass/fail. Does not touch any pre-existing data.

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
      [`ADDITEMS-TEST-${Date.now()}`, 'Add Missing Items Verify Test Customer', '0000000000', 'test', 'PRIVATE_PRICE', 0, 0, 'SOLAR']
    );
    testCustomerId = custIns.insertId;

    const cpc = await PriceMatrixAgent.createCustomerPriceCategory(testCustomerId, beefCat.id, {});
    testCategoryId = cpc.id;

    const EFFECTIVE_DATE = '2026-08-05';
    // Book only contains Đùi + Sườn + Vụn — Gân 50 is a real, active product in the SAME
    // category that was deliberately left out, so it must show up as a candidate.
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

    // Mark Đùi + Sườn "used in bill" (PAID -> header also locked, the harder case).
    const [orderIns] = await pool.query(
      `INSERT INTO orders(order_code,customer_id,order_date,status,payment_status,total_amount,paid_amount,debt_amount)
       VALUES(?,?,?,?,?,?,?,?)`,
      [`ADDITEMS-ORDER-${Date.now()}`, testCustomerId, EFFECTIVE_DATE, 'CONFIRMED', 'PAID', 700000, 700000, 0]
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
    console.log(`Created throwaway PAID order id=${testOrderId} using Đùi + Sườn (book header now locked)`);

    // ── Step 1-2: open the (used/locked) book ──
    const book0 = await PriceMatrixAgent.getBook(testBookId);
    check('1-2. Book header is locked (paid bill exists)', book0.can_edit === false, JSON.stringify({can_edit: book0.can_edit}));
    const duiItem0 = book0.items.find(i => Number(i.product_id) === duiP.id);
    check('2. Đùi (existing item) shows lock badge (can_edit=false, lock_reason set)', duiItem0 && duiItem0.can_edit === false && duiItem0.lock_reason === '🔒 Đã sử dụng trong bill', JSON.stringify(duiItem0));
    check('getBook response carries category_id + customer_id for candidate lookup', !!book0.category_id && !!book0.customer_id, JSON.stringify({category_id: book0.category_id, customer_id: book0.customer_id}));

    // ── Step 3-4: candidates computed exactly like the fixed openBook() — via the book's
    //    OWN category_id/customer_id, never the shared page-level `rows` state ──
    const catalog = await PriceMatrixAgent.matrix(book0.customer_id, book0.category_id);
    const inBookIds = new Set(book0.items.map(i => String(i.product_id)));
    const candidatesBefore = (catalog.rows || []).filter(r => !inBookIds.has(String(r.product_id)));
    console.log(`Candidate count before save: ${candidatesBefore.length} (product_ids: ${candidatesBefore.map(c=>c.product_id).join(',')})`);
    check('3. "Thêm mặt hàng chưa có..." section is non-empty (candidates exist)', candidatesBefore.length > 0);
    check('4. Gân 50 appears as a candidate', candidatesBefore.some(c => Number(c.product_id) === ganP.id));

    // ── Step 5-6: set price 50.000 and save ──
    const newItems = candidatesBefore
      .filter(c => Number(c.product_id) === ganP.id)
      .map(c => ({ product_id: c.product_id, sale_price: 50000, note: null }));
    const existingPayload = book0.items.map(it => ({ product_id: it.product_id, sale_price: it.sale_price, note: it.note }));
    const saveResult = await PriceMatrixAgent.updateBook(testBookId, { items: [...existingPayload, ...newItems] }, null);
    check('6. Save succeeds', !!saveResult, JSON.stringify(saveResult));

    // ── Step 7-9: reopen the same book ──
    const book1 = await PriceMatrixAgent.getBook(testBookId);
    const ganItem1 = book1.items.find(i => Number(i.product_id) === ganP.id);
    check('8. Gân 50 now appears in existing-item table with price 50000', ganItem1 && Number(ganItem1.sale_price) === 50000, JSON.stringify(ganItem1));
    const catalog2 = await PriceMatrixAgent.matrix(book1.customer_id, book1.category_id);
    const inBookIds2 = new Set(book1.items.map(i => String(i.product_id)));
    const candidatesAfter = (catalog2.rows || []).filter(r => !inBookIds2.has(String(r.product_id)));
    check('9. Gân 50 no longer appears in the candidate list', !candidatesAfter.some(c => Number(c.product_id) === ganP.id), JSON.stringify(candidatesAfter.map(c=>c.product_id)));

    // ── Step 10: locked items remain unchanged ──
    const duiItem1 = book1.items.find(i => Number(i.product_id) === duiP.id);
    const suonItem1 = book1.items.find(i => Number(i.product_id) === suonP.id);
    check('10. Đùi (locked) unchanged after save', duiItem1 && Number(duiItem1.sale_price) === 200000 && duiItem1.can_edit === false, JSON.stringify(duiItem1));
    check('10. Sườn (locked) unchanged after save', suonItem1 && Number(suonItem1.sale_price) === 150000 && suonItem1.can_edit === false, JSON.stringify(suonItem1));

    // ── Step 11: old bill OrderItems unchanged ──
    const [historicalItems] = await pool.query(
      `SELECT product_id, sale_price, total_price FROM order_items WHERE order_id=? ORDER BY product_id`,
      [testOrderId]
    );
    const histDui = historicalItems.find(r => Number(r.product_id) === duiP.id);
    const histSuon = historicalItems.find(r => Number(r.product_id) === suonP.id);
    check('11. Historical Đùi OrderItem unchanged', histDui && Number(histDui.sale_price) === 200000 && Number(histDui.total_price) === 400000, JSON.stringify(histDui));
    check('11. Historical Sườn OrderItem unchanged', histSuon && Number(histSuon.sale_price) === 150000 && Number(histSuon.total_price) === 300000, JSON.stringify(histSuon));

  } finally {
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
