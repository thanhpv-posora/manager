'use strict';
// Verifies "Nạp bảng giá NCC" (load supplier purchase price book into a
// Purchase Order): effective-date resolution (including historical dates and
// deterministic tie-break), unavailable-item detection, price-book
// traceability persistence, and price-snapshot immutability after the
// source book changes.
//
// Self-cleaning: all throwaway rows removed in `finally`, FK-safe order.

const pool = require('../src/config/db');
const CustomerAgent = require('../src/agents/CustomerAgent');
const ProductAgent = require('../src/agents/ProductAgent');
const InventoryPurchaseAgent = require('../src/agents/InventoryPurchaseAgent');
const SupplierPurchaseCatalogResolver = require('../src/services/SupplierPurchaseCatalogResolver');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}

const user = { id: null };

async function main() {
  const productIds = [];
  const spoIds = [];
  const bookIds = [];
  const bookItemIds = [];
  const poIds = [];
  let partnerId = null, legacySupplierId = null, categoryId = null, unitId = null;

  try {
    const [[cat]] = await pool.query(`SELECT id FROM product_categories LIMIT 1`);
    categoryId = cat.id;
    const [[unit]] = await pool.query(`SELECT id FROM units WHERE code='kg' LIMIT 1`);
    unitId = unit.id;

    const partnerRes = await CustomerAgent.create({ name: `VERIFY PB Supplier ${Date.now()}`, partner_type: 1 }, user);
    const [[partnerRow]] = await pool.query(`SELECT id FROM customers WHERE customer_code=?`, [partnerRes.customer_code]);
    partnerId = partnerRow.id;
    const [[map]] = await pool.query(`SELECT supplier_id FROM supplier_partner_map WHERE partner_id=?`, [partnerId]);
    legacySupplierId = map.supplier_id;

    // Prerequisite Master Data row — every real price book in this system is
    // scoped by a CustomerPriceCategory (S4.3), including _buildItemSnapshot's
    // own resolveSinglePrice() call, which always passes the product's category.
    const [cpcR] = await pool.query(
      `INSERT INTO customer_price_categories (customer_id, category_id, is_default, display_order) VALUES (?,?,1,1)`,
      [partnerId, categoryId]
    );
    const customerPriceCategoryId = cpcR.insertId;

    async function makeProduct(name) {
      await ProductAgent.addProduct({ name: `VERIFY PB ${name} ${Date.now()}-${Math.random().toString(36).slice(2,6)}`, unit: 'kg', category_id: categoryId, inventory_mode: 'TRACK_STOCK', sales_flow: 'INVENTORY_SALE' });
      const [[p]] = await pool.query(`SELECT id FROM products WHERE name LIKE 'VERIFY PB ${name} %' ORDER BY id DESC LIMIT 1`);
      productIds.push(p.id);
      return p.id;
    }
    async function makeSpo(productId) {
      const [r] = await pool.query(
        `INSERT INTO supplier_purchase_options (supplier_id, product_id, unit_id, default_conversion_qty, is_active, partner_id)
         VALUES (?,?,?,1.0000,1,?)`, [legacySupplierId, productId, unitId, partnerId]
      );
      spoIds.push(r.insertId);
      return r.insertId;
    }
    async function makeBook(effectiveFrom, name) {
      const [r] = await pool.query(
        `INSERT INTO customer_price_books (customer_id, book_name, effective_from, effective_calendar_type, status, category_id, customer_price_category_id)
         VALUES (?,?,?,'SOLAR','ACTIVE',?,?)`, [partnerId, name, effectiveFrom, categoryId, customerPriceCategoryId]
      );
      bookIds.push(r.insertId);
      return r.insertId;
    }
    async function makeBookItem(bookId, productId, price) {
      const [r] = await pool.query(
        `INSERT INTO customer_price_book_items (price_book_id, customer_id, product_id, sale_price) VALUES (?,?,?,?)`,
        [bookId, partnerId, productId, price]
      );
      bookItemIds.push(r.insertId);
      return r.insertId;
    }

    const prod1 = await makeProduct('Nam');
    const prod2 = await makeProduct('Bap');
    const prod3NoSpo = await makeProduct('NoSpo');
    const spo1 = await makeSpo(prod1);
    const spo2 = await makeSpo(prod2);
    // prod3NoSpo intentionally has no SPO — should resolve as unavailable.

    // ── Case 1: basic resolution, no category scope ─────────────────────
    const bookOld = await makeBook('2020-01-01', 'Old book');
    await makeBookItem(bookOld, prod1, 100000);
    const bookNew = await makeBook('2026-01-01', 'New book');
    await makeBookItem(bookNew, prod1, 150000);
    await makeBookItem(bookNew, prod2, 200000);
    await makeBookItem(bookNew, prod3NoSpo, 50000);

    // ── Case 2: historical date must resolve the OLD book, not the newest ──
    const historical = await SupplierPurchaseCatalogResolver.resolvePriceBookForBulkEntry(partnerId, legacySupplierId, '2021-06-01', 'SOLAR', categoryId);
    check('Case 2: historical purchase_date resolves the OLDER book (not always-newest)', historical.price_book_id === bookOld, `got ${historical.price_book_id}, expected ${bookOld}`);
    check('Case 2: historical resolution has the old price (100000), not the new price', historical.items.find(i => i.product_id === prod1)?.purchase_price === 100000);

    // ── Case 3: current/future date resolves the NEW book ─────────────────
    const current = await SupplierPurchaseCatalogResolver.resolvePriceBookForBulkEntry(partnerId, legacySupplierId, '2026-07-29', 'SOLAR', categoryId);
    check('Case 3: current date resolves the NEWER book', current.price_book_id === bookNew, `got ${current.price_book_id}`);
    check('Case 3: 3 items returned (all book items, even the unavailable one)', current.items.length === 3, current.items.length);

    const item1 = current.items.find(i => i.product_id === prod1);
    const item2 = current.items.find(i => i.product_id === prod2);
    const item3 = current.items.find(i => i.product_id === prod3NoSpo);
    check('Case 3: item with valid SPO+price is available', item1.available === true && item1.supplier_purchase_option_id === spo1);
    check('Case 3: item with valid SPO+price is available (product 2)', item2.available === true && item2.supplier_purchase_option_id === spo2);
    check('Case 3: item with NO purchase unit is marked unavailable, not dropped', item3.available === false && item3.unavailable_reason.includes('đơn vị'), JSON.stringify(item3));

    // ── Case 4: "multiple valid price books for the same supplier+date" is
    // structurally IMPOSSIBLE, not just avoided by query convention — the
    // database itself enforces uq_cpb_customer_category_date_type(customer_
    // price_category_id, effective_from, effective_calendar_type) as a real
    // UNIQUE constraint. This proves the story's ambiguity concern ("do not
    // silently select the first record... REQUIRES_CTO_DECISION if unclear")
    // cannot occur within one category — confirmed here by attempting the
    // exact scenario and observing the DB itself reject it, not a guess.
    const bookTieA = await makeBook('2025-06-01', 'Tie A');
    await makeBookItem(bookTieA, prod1, 111);
    let dupBookThrew = null;
    try { await makeBook('2025-06-01', 'Tie B'); } catch (e) { dupBookThrew = e; }
    check('Case 4: DB UNIQUE constraint makes a same-category/same-date duplicate price book structurally impossible (not just avoided by app logic)', !!dupBookThrew && dupBookThrew.code === 'ER_DUP_ENTRY', dupBookThrew && dupBookThrew.message);
    // Remove the failed attempt's bookIds entry (insertId was never committed on a thrown duplicate-key error, nothing to clean up there) —
    // bookTieA itself is the only real row from this case and is cleaned up normally below.

    // ── Case 5: no effective price book for a very old date ───────────────
    const none = await SupplierPurchaseCatalogResolver.resolvePriceBookForBulkEntry(partnerId, legacySupplierId, '1999-01-01', 'SOLAR', categoryId);
    check('Case 5: no applicable book -> price_book_id null, empty items (never invents a price)', none.price_book_id === null && none.items.length === 0);

    // ── Case 6: inactive product still returned, marked unavailable ───────
    await pool.query(`UPDATE products SET is_active=0 WHERE id=?`, [prod2]);
    const afterInactive = await SupplierPurchaseCatalogResolver.resolvePriceBookForBulkEntry(partnerId, legacySupplierId, '2026-07-29', 'SOLAR', categoryId);
    const item2b = afterInactive.items.find(i => i.product_id === prod2);
    check('Case 6: inactive product marked unavailable with correct reason, still present', item2b && item2b.available === false && item2b.unavailable_reason.includes('hoạt động'));
    await pool.query(`UPDATE products SET is_active=1 WHERE id=?`, [prod2]);

    // ── Case 7: persistence — price_book_id/price_book_item_id saved, price server-resolved ──
    const [poR] = await pool.query(
      `INSERT INTO purchase_orders (purchase_code, supplier_id, partner_id, purchase_date, status, order_code, del_flg)
       VALUES (?,?,?,'2026-07-29','DRAFT',?,0)`,
      [`VPB${Date.now()}`, legacySupplierId, partnerId, `VPB${Date.now()}`]
    );
    const orderId = poR.insertId;
    poIds.push(orderId);

    const bookItem1Id = bookItemIds.find(async () => true); // placeholder, resolved below properly
    const resolvedNow = await InventoryPurchaseAgent.priceBookForBulkEntry(orderId, categoryId);
    check('Case 7: agent-level priceBookForBulkEntry resolves the same current book', resolvedNow.price_book_id === bookNew);
    const rowToApply = resolvedNow.items.find(i => i.product_id === prod1);

    const applyRes = await InventoryPurchaseAgent.addItem(orderId, {
      product_id: rowToApply.product_id,
      supplier_purchase_option_id: rowToApply.supplier_purchase_option_id,
      quantity: 10,
      purchase_price: 1, // deliberately WRONG client price — must be overridden server-side
      price_book_id: rowToApply.price_book_id,
      price_book_item_id: rowToApply.price_book_item_id,
    }, user.id);
    check('Case 7: addItem accepted the price-book row', !!applyRes.id);

    const savedOrder = await InventoryPurchaseAgent.get(orderId);
    const savedItem = savedOrder.items.find(i => i.id === applyRes.id);
    check('Case 7: server-resolved price used, NOT the client-sent price (1)', Number(savedItem.purchase_price) === 150000, savedItem.purchase_price);
    check('Case 7: price_book_id persisted for traceability', Number(savedItem.price_book_id) === bookNew);
    check('Case 7: price_book_item_id persisted for traceability', Number(savedItem.price_book_item_id) === rowToApply.price_book_item_id);

    // ── Case 8: price snapshot immutability — editing the source book price does not change the saved PO item ──
    await pool.query(`UPDATE customer_price_book_items SET sale_price=999999 WHERE id=?`, [rowToApply.price_book_item_id]);
    const savedOrderAfterEdit = await InventoryPurchaseAgent.get(orderId);
    const savedItemAfterEdit = savedOrderAfterEdit.items.find(i => i.id === applyRes.id);
    check('Case 8: saved PO item price UNCHANGED after the source price-book item was edited', Number(savedItemAfterEdit.purchase_price) === 150000, savedItemAfterEdit.purchase_price);

    // ── Case 9: mismatched price_book_item_id (wrong product) rejected ────
    let mismatchThrew = null;
    try {
      await InventoryPurchaseAgent.addItem(orderId, {
        product_id: prod2, // different product than the book item below
        supplier_purchase_option_id: spo2,
        quantity: 5,
        purchase_price: 100,
        price_book_item_id: rowToApply.price_book_item_id, // belongs to prod1, not prod2
      }, user.id);
    } catch (e) { mismatchThrew = e; }
    check('Case 9: mismatched price_book_item_id (wrong product) rejected', !!mismatchThrew, mismatchThrew && mismatchThrew.message);

  } finally {
    for (const id of poIds) {
      await pool.query(`DELETE FROM purchase_order_items WHERE purchase_order_id=?`, [id]);
      await pool.query(`DELETE FROM purchase_orders WHERE id=?`, [id]);
    }
    for (const id of bookItemIds) await pool.query(`DELETE FROM customer_price_book_items WHERE id=?`, [id]);
    for (const id of bookIds) await pool.query(`DELETE FROM customer_price_books WHERE id=?`, [id]);
    for (const id of spoIds) await pool.query(`DELETE FROM supplier_purchase_options WHERE id=?`, [id]);
    for (const id of productIds) await pool.query(`DELETE FROM products WHERE id=?`, [id]);
    if (partnerId) {
      await pool.query(`DELETE FROM customer_price_categories WHERE customer_id=?`, [partnerId]);
      const [[p]] = await pool.query(`SELECT customer_code FROM customers WHERE id=?`, [partnerId]);
      await pool.query(`DELETE FROM supplier_partner_map WHERE partner_id=?`, [partnerId]);
      if (p) await pool.query(`DELETE FROM suppliers WHERE supplier_code=?`, [p.customer_code]);
      await pool.query(`DELETE FROM customers WHERE id=?`, [partnerId]);
    }
    console.log('Cleanup done.');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
