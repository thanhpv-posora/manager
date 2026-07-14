'use strict';
// Verifies the "new Price Book item invisible in POS/Excel import" bug fix.
// Root cause: PriceMatrixAgent.customerCatalogForOrder() (the API CreateOrder.jsx and its
// Excel-import matcher both read the catalog from) gated visibility on customer_product_catalogs
// membership. Adding a brand-new item to an existing Price Book (PriceMatrixAgent.updateBook,
// the "+ Thêm mặt hàng chưa có trong bảng giá" feature) only writes to
// customer_price_book_items — never to customer_product_catalogs — so the product had a real
// price but was invisible in POS and Excel import.
//
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
    const [[xgP]] = await pool.query(`SELECT id,name,unit FROM products WHERE category_id=? AND del_flg=0 AND name='Xg ống 4' LIMIT 1`, [beefCat.id]);
    const [[qtP]] = await pool.query(`SELECT id,name,unit FROM products WHERE category_id=? AND del_flg=0 AND name='Quýt lọc' LIMIT 1`, [beefCat.id]);
    if (!duiP || !xgP || !qtP) throw new Error('Missing one of Đùi/Xg ống 4/Quýt lọc in Thịt bò category');
    console.log(`Đùi=${duiP.id} Xg ống 4=${xgP.id} Quýt lọc=${qtP.id}`);

    const [custIns] = await pool.query(
      `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type)
       VALUES(?,?,?,?,?,?,?,?)`,
      [`POSVIS-TEST-${Date.now()}`, 'POS Catalog Visibility Verify Test Customer', '0000000000', 'test', 'PRIVATE_PRICE', 0, 0, 'SOLAR']
    );
    testCustomerId = custIns.insertId;

    const cpc = await PriceMatrixAgent.createCustomerPriceCategory(testCustomerId, beefCat.id, {});
    testCategoryId = cpc.id;

    // Must be today-or-earlier: customerCatalogForOrder's effective-price resolution filters
    // out any Price Book whose effective_from is still in the future relative to the real clock.
    const EFFECTIVE_DATE = new Date().toISOString().slice(0,10);
    // Establish the price book the normal way (Đùi only) — this is what creates the
    // customer_product_catalogs row for Đùi (in_catalog upsert inside saveMatrix), giving this
    // customer a non-empty catalog so customerCatalogForOrder takes the CUSTOMER_CATALOG path
    // (not the ALL_PRODUCTS_FALLBACK path, which would mask this bug).
    await PriceMatrixAgent.saveMatrix(
      testCustomerId,
      [{ product_id: duiP.id, private_price: 200000, in_catalog: true }],
      null,
      { effective_from: EFFECTIVE_DATE, effective_calendar_type: 'SOLAR' },
      beefCat.id
    );
    const [[bookRow]] = await pool.query(`SELECT id FROM customer_price_books WHERE customer_id=? LIMIT 1`, [testCustomerId]);
    testBookId = bookRow.id;
    console.log(`Created price book id=${testBookId} with Đùi only`);

    // Mark Đùi "used in bill" so the book is a real "already-used" price book, per the report.
    const [orderIns] = await pool.query(
      `INSERT INTO orders(order_code,customer_id,order_date,status,payment_status,total_amount,paid_amount,debt_amount)
       VALUES(?,?,?,?,?,?,?,?)`,
      [`POSVIS-ORDER-${Date.now()}`, testCustomerId, EFFECTIVE_DATE, 'CONFIRMED', 'PAID', 400000, 400000, 0]
    );
    const testOrderId = orderIns.insertId;
    testOrderIds.push(testOrderId);
    await pool.query(
      `INSERT INTO order_items(order_id,product_id,product_name,unit,quantity,sale_price,total_price,price_type,price_book_id)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      [testOrderId, duiP.id, duiP.name, duiP.unit || 'kg', 2, 200000, 400000, 'PRICE_BOOK', testBookId]
    );
    console.log(`Created throwaway PAID order using Đùi (book is now "already used")`);

    // ── Baseline: BEFORE adding the new items, confirm they're genuinely absent from POS ──
    const before = await PriceMatrixAgent.customerCatalogForOrder(testCustomerId, beefCat.id);
    check('Baseline: Xg ống 4 absent from POS catalog before fix scenario', !before.products.some(p=>Number(p.product_id)===xgP.id));
    check('Baseline: Quýt lọc absent from POS catalog before fix scenario', !before.products.some(p=>Number(p.product_id)===qtP.id));

    // ── Step 1-2: add Xg ống 4 + Quýt lọc directly to the EXISTING book via updateBook (the
    //    "+ Thêm mặt hàng chưa có trong bảng giá" feature) — never touches customer_product_catalogs ──
    const book0 = await PriceMatrixAgent.getBook(testBookId);
    const existingPayload = book0.items.map(it => ({ product_id: it.product_id, sale_price: it.sale_price, note: it.note }));
    await PriceMatrixAgent.updateBook(testBookId, {
      items: [...existingPayload,
        { product_id: xgP.id, sale_price: 40000, note: null },
        { product_id: qtP.id, sale_price: 210000, note: null },
      ]
    }, null);

    // ── Step 3: reopen the book — both appear as existing rows ──
    const book1 = await PriceMatrixAgent.getBook(testBookId);
    const xgItem = book1.items.find(i => Number(i.product_id) === xgP.id);
    const qtItem = book1.items.find(i => Number(i.product_id) === qtP.id);
    check('3. Xg ống 4 appears as existing Price Book row at 40000', xgItem && Number(xgItem.sale_price) === 40000, JSON.stringify(xgItem));
    check('3. Quýt lọc appears as existing Price Book row at 210000', qtItem && Number(qtItem.sale_price) === 210000, JSON.stringify(qtItem));

    // ── Step 4-5: open Create Bill POS for same customer/category — both must appear,
    //    with a resolved PRICE_BOOK price (proves "manual quantity entry works") ──
    const after = await PriceMatrixAgent.customerCatalogForOrder(testCustomerId, beefCat.id);
    const xgPos = after.products.find(p=>Number(p.product_id)===xgP.id);
    const qtPos = after.products.find(p=>Number(p.product_id)===qtP.id);
    check('4. Xg ống 4 appears in POS catalog', !!xgPos, JSON.stringify(after.products.map(p=>p.product_name)));
    check('4. Quýt lọc appears in POS catalog', !!qtPos);
    check('5. Xg ống 4 resolves PRICE_BOOK price 40000 (manual qty entry would use this)', xgPos && xgPos.price_type==='PRICE_BOOK' && Number(xgPos.sale_price)===40000, JSON.stringify(xgPos));
    check('5. Quýt lọc resolves PRICE_BOOK price 210000', qtPos && qtPos.price_type==='PRICE_BOOK' && Number(qtPos.sale_price)===210000, JSON.stringify(qtPos));

    // ── Step 6-8: Excel import matching reads this exact `products` array (CreateOrder.jsx's
    //    `items` state, fed straight from customerCatalogForOrder) and does an EXACT name
    //    match — so both names now being present in `after.products` IS the fix for
    //    "Chưa khớp danh mục" / "Không mapping đúng tên hàng trong database". ──
    const namesInCatalog = new Set(after.products.map(p=>p.product_name));
    check('6-8. Excel column "Xg ống 4" now matches a name present in the POS catalog source', namesInCatalog.has('Xg ống 4'));
    check('6-8. Excel column "Quýt lọc" now matches a name present in the POS catalog source', namesInCatalog.has('Quýt lọc'));

    // ── Step 9: no duplicate product created ──
    const [[xgCount]] = await pool.query(`SELECT COUNT(*) c FROM products WHERE name='Xg ống 4' AND del_flg=0`);
    const [[qtCount]] = await pool.query(`SELECT COUNT(*) c FROM products WHERE name='Quýt lọc' AND del_flg=0`);
    check('9. No duplicate "Xg ống 4" product created', Number(xgCount.c) === 1, JSON.stringify(xgCount));
    check('9. No duplicate "Quýt lọc" product created', Number(qtCount.c) === 1, JSON.stringify(qtCount));

    // ── Step 11: existing locked row (Đùi, used in bill) remains unchanged ──
    const duiItem = book1.items.find(i => Number(i.product_id) === duiP.id);
    check('11. Đùi (locked, used in bill) unchanged — can_edit=false, price still 200000', duiItem && duiItem.can_edit===false && Number(duiItem.sale_price)===200000, JSON.stringify(duiItem));

    // ── Step 12: historical OrderItem unchanged ──
    const [[histDui]] = await pool.query(`SELECT sale_price,total_price FROM order_items WHERE order_id=? AND product_id=?`, [testOrderId, duiP.id]);
    check('12. Historical Đùi OrderItem unchanged', histDui && Number(histDui.sale_price)===200000 && Number(histDui.total_price)===400000, JSON.stringify(histDui));

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
      await pool.query(`DELETE FROM customer_product_catalogs WHERE customer_id=?`, [testCustomerId]);
      await pool.query(`DELETE FROM price_change_logs WHERE customer_id=?`, [testCustomerId]);
      await pool.query(`DELETE FROM customer_product_prices WHERE customer_id=?`, [testCustomerId]);
      await pool.query(`DELETE FROM customers WHERE id=?`, [testCustomerId]);
    }
    console.log('Cleanup done (test customer + throwaway order + price book removed).');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
