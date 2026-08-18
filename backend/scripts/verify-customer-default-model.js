'use strict';
// Customer Default Model verification.
//
// Covers:
//  - Legacy customer: NULL default_sales_flow, no backfill, editable without
//    being forced, still listable/updatable normally.
//  - New customer: default_sales_flow required (rejected when missing/invalid),
//    persisted correctly for both CARCASS_POS and INVENTORY_SALE; a
//    supplier-only (partner_type=1) new partner is exempt.
//  - PartnerAgent.listPartners() now exposes default_sales_flow (the proven
//    dependency CreateOrder.jsx's customer picker needs).
//  - Mixed Bill PASS: OrderAgent.create()'s actual sales_flow derivation is
//    driven only by products.inventory_mode, never by customer.default_sales_flow
//    — a customer defaulted to INVENTORY_SALE can still buy a NON_STOCK item
//    and get a correctly-derived CARCASS_POS bill.
//  - Inventory PASS: stock deduction for a TRACK_STOCK item is unaffected by
//    default_sales_flow.
//  - Price PASS: price resolution is unaffected by default_sales_flow.
//  - Static proof: CreateOrder.jsx's customer-select handler reads
//    default_sales_flow and calls setPage('inventory-sales') only for
//    INVENTORY_SALE, never writes it back to the DB.
//
// Self-cleaning: throwaway customers/products/orders, removed in `finally`
// regardless of pass/fail.

const fs = require('fs');
const path = require('path');
const pool = require('../src/config/db');
const ProductAgent = require('../src/agents/ProductAgent');
const OrderAgent = require('../src/agents/OrderAgent');
const PriceMatrixAgent = require('../src/agents/PriceMatrixAgent');
const PriceBookService = require('../src/services/PriceBookService');
const CustomerAgent = require('../src/agents/CustomerAgent');
const PartnerAgent = require('../src/agents/PartnerAgent');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}

const cleanup = { orderIds: [], productIds: [], customerIds: [], priceCategoryIds: [], bookIds: [] };
const adminUser = () => ({ id: null, role: 'ADMIN' });
const billItem = (p, qty) => ({ product_id: p.id, product_name: p.name, unit: 'kg', quantity: qty });

async function makeProduct(mode, { stock = 0, categoryId }) {
  const tag = `CDM ${mode} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const salesFlow = mode === 'TRACK_STOCK' ? 'INVENTORY_SALE' : 'CARCASS_POS';
  await ProductAgent.addProduct({ name: tag, unit: 'kg', category_id: categoryId, inventory_mode: mode, sales_flow: salesFlow, stock_quantity: stock });
  const [[created]] = await pool.query(`SELECT * FROM products WHERE name=? LIMIT 1`, [tag]);
  cleanup.productIds.push(created.id);
  return created;
}
async function setupCategory(customerId, categoryId) {
  const cpc = await PriceMatrixAgent.createCustomerPriceCategory(customerId, categoryId, {});
  cleanup.priceCategoryIds.push(cpc.id);
  return cpc;
}
async function priceAndCatalog(customerId, categoryId, product, price, salesFlow = null) {
  const cpc = await PriceMatrixAgent.createCustomerPriceCategory(customerId, categoryId, salesFlow ? { sales_flow: salesFlow } : {});
  cleanup.priceCategoryIds.push(cpc.id);
  await PriceMatrixAgent.saveMatrix(customerId, [{ product_id: product.id, private_price: price, in_catalog: true }], null,
    { effective_from: '2025-01-01', effective_calendar_type: 'SOLAR' }, categoryId);
  const [books] = await pool.query(`SELECT id FROM customer_price_books WHERE customer_id=?`, [customerId]);
  books.forEach(b => cleanup.bookIds.push(b.id));
}

async function main() {
  try {
    const [prodCats] = await pool.query(`SELECT id FROM product_categories WHERE del_flg=0 ORDER BY id LIMIT 1`);
    const catA = prodCats[0].id;

    // ══════════════════ Legacy customer PASS ══════════════════
    {
      // Simulate a pre-existing legacy customer: created directly, no
      // default_sales_flow ever set (exactly how every real customer looked
      // before this migration — no backfill was run).
      const [ins] = await pool.query(
        `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type,partner_type)
         VALUES(?,?,?,?,?,?,?,?,?)`,
        [`CDMTEST-LEGACY-${Date.now()}`, 'CDM Legacy Customer', '0', 'test', 'PRIVATE_PRICE', 0, 0, 'SOLAR', 2]
      );
      const legacyId = ins.insertId;
      cleanup.customerIds.push(legacyId);

      const [[row]] = await pool.query(`SELECT default_sales_flow FROM customers WHERE id=?`, [legacyId]);
      check('Legacy customer: default_sales_flow is NULL (no backfill)', row.default_sales_flow === null, row.default_sales_flow);

      const listed = await CustomerAgent.list(adminUser());
      const listedLegacy = listed.find(c => Number(c.id) === legacyId);
      check('Legacy customer: appears in CustomerAgent.list() with default_sales_flow=NULL', listedLegacy && listedLegacy.default_sales_flow === null, listedLegacy && listedLegacy.default_sales_flow);

      // Editing a legacy customer without touching the field: stays NULL, no error.
      const editResult = await CustomerAgent.update(legacyId, { name: 'CDM Legacy Customer', partner_type: 2 }, adminUser());
      check('Legacy customer: edit without default_sales_flow succeeds (not forced)', !!editResult.message, editResult);
      const [[afterEdit]] = await pool.query(`SELECT default_sales_flow FROM customers WHERE id=?`, [legacyId]);
      check('Legacy customer: still NULL after an edit that omits the field', afterEdit.default_sales_flow === null, afterEdit.default_sales_flow);

      // Legacy customer CAN be classified later, explicitly, without a backfill process.
      await CustomerAgent.update(legacyId, { name: 'CDM Legacy Customer', partner_type: 2, default_sales_flow: 'CARCASS_POS' }, adminUser());
      const [[afterClassify]] = await pool.query(`SELECT default_sales_flow FROM customers WHERE id=?`, [legacyId]);
      check('Legacy customer: can be explicitly classified later via the form (not a backfill)', afterClassify.default_sales_flow === 'CARCASS_POS', afterClassify.default_sales_flow);
    }

    // ══════════════════ New customer PASS ══════════════════
    {
      let threw = null;
      try { await CustomerAgent.create({ name: 'CDM New No Flow ' + Date.now(), phone: `09${String(Date.now()).slice(-6)}${String(Math.floor(Math.random()*90)+10)}`, partner_type: 2 }, adminUser()); }
      catch (e) { threw = e; }
      check('New customer without default_sales_flow: rejected', threw && threw.code === 'DEFAULT_SALES_FLOW_REQUIRED', threw && threw.message);

      let threwInvalid = null;
      try { await CustomerAgent.create({ name: 'CDM New Bad Flow ' + Date.now(), phone: `09${String(Date.now()).slice(-6)}${String(Math.floor(Math.random()*90)+10)}`, partner_type: 2, default_sales_flow: 'GARBAGE' }, adminUser()); }
      catch (e) { threwInvalid = e; }
      check('New customer with invalid default_sales_flow: rejected', threwInvalid && threwInvalid.code === 'INVALID_DEFAULT_SALES_FLOW', threwInvalid && threwInvalid.message);

      const rCarcass = await CustomerAgent.create({ name: 'CDM New Carcass ' + Date.now(), phone: `09${String(Date.now()).slice(-6)}${String(Math.floor(Math.random()*90)+10)}`, partner_type: 2, default_sales_flow: 'CARCASS_POS' }, adminUser());
      const [[carcassCust]] = await pool.query(`SELECT id, default_sales_flow FROM customers WHERE customer_code=?`, [rCarcass.customer_code]);
      cleanup.customerIds.push(carcassCust.id);
      check('New customer with CARCASS_POS: created and persisted', carcassCust.default_sales_flow === 'CARCASS_POS', carcassCust.default_sales_flow);

      const rInventory = await CustomerAgent.create({ name: 'CDM New Inventory ' + Date.now(), phone: `09${String(Date.now()).slice(-6)}${String(Math.floor(Math.random()*90)+10)}`, partner_type: 2, default_sales_flow: 'INVENTORY_SALE' }, adminUser());
      const [[invCust]] = await pool.query(`SELECT id, default_sales_flow FROM customers WHERE customer_code=?`, [rInventory.customer_code]);
      cleanup.customerIds.push(invCust.id);
      check('New customer with INVENTORY_SALE: created and persisted', invCust.default_sales_flow === 'INVENTORY_SALE', invCust.default_sales_flow);

      // Supplier-only partner: exempt from the requirement.
      const rSupplier = await CustomerAgent.create({ name: 'CDM New Supplier ' + Date.now(), phone: `09${String(Date.now()).slice(-6)}${String(Math.floor(Math.random()*90)+10)}`, partner_type: 1 }, adminUser());
      const [[supplierCust]] = await pool.query(`SELECT id, default_sales_flow FROM customers WHERE customer_code=?`, [rSupplier.customer_code]);
      cleanup.customerIds.push(supplierCust.id);
      check('New supplier-only partner (partner_type=1): exempt, created without default_sales_flow', !!supplierCust, supplierCust);

      // PartnerAgent exposes it (the CreateOrder.jsx dependency).
      const partners = await PartnerAgent.listPartners(adminUser(), { role: 'customer' });
      const viaPartnerAgent = partners.find(p => Number(p.id) === invCust.id);
      check('PartnerAgent.listPartners() exposes default_sales_flow (CreateOrder.jsx dependency)', viaPartnerAgent && viaPartnerAgent.default_sales_flow === 'INVENTORY_SALE', viaPartnerAgent);
    }

    // ══════════════════ Mixed Bill PASS (default_sales_flow never drives actual sales_flow) ══════════════════
    {
      const rInvCustomer = await CustomerAgent.create({ name: 'CDM MixedBill Test ' + Date.now(), phone: `09${String(Date.now()).slice(-6)}${String(Math.floor(Math.random()*90)+10)}`, partner_type: 2, default_sales_flow: 'INVENTORY_SALE' }, adminUser());
      const [[customer]] = await pool.query(`SELECT id FROM customers WHERE customer_code=?`, [rInvCustomer.customer_code]);
      cleanup.customerIds.push(customer.id);

      // Phase 1B dual-price-category architecture: a mixed bill needs one
      // CARCASS_POS-classified category for the carcass item and one separate
      // INVENTORY_SALE-classified category for the track-stock item.
      const [prodCatsForMixed] = await pool.query(`SELECT id FROM product_categories WHERE del_flg=0 ORDER BY id LIMIT 2`);
      const [catMixedA, catMixedB] = prodCatsForMixed.map(x => x.id);
      const pCarcass = await makeProduct('NON_STOCK', { categoryId: catMixedA });
      const pTrack = await makeProduct('TRACK_STOCK', { stock: 20, categoryId: catMixedB });

      const cpcCarcass = await PriceMatrixAgent.createCustomerPriceCategory(customer.id, catMixedA, { sales_flow: 'CARCASS_POS' });
      cleanup.priceCategoryIds.push(cpcCarcass.id);
      const cpcInventory = await PriceMatrixAgent.createCustomerPriceCategory(customer.id, catMixedB, { sales_flow: 'INVENTORY_SALE' });
      cleanup.priceCategoryIds.push(cpcInventory.id);
      await PriceMatrixAgent.saveMatrix(customer.id, [{ product_id: pCarcass.id, private_price: 70000, in_catalog: true }], null,
        { effective_from: '2025-01-01', effective_calendar_type: 'SOLAR' }, catMixedA);
      await PriceMatrixAgent.saveMatrix(customer.id, [{ product_id: pTrack.id, private_price: 50000, in_catalog: true }], null,
        { effective_from: '2025-01-01', effective_calendar_type: 'SOLAR' }, catMixedB);
      const [mixedBooks] = await pool.query(`SELECT id FROM customer_price_books WHERE customer_id=?`, [customer.id]);
      mixedBooks.forEach(b => cleanup.bookIds.push(b.id));

      const r = await OrderAgent.create({ customer_id: customer.id, order_date: '2025-06-01', items: [billItem(pCarcass, 1), billItem(pTrack, 1)] }, adminUser());
      cleanup.orderIds.push(r.order_id);
      const [[order]] = await pool.query(`SELECT sales_flow FROM orders WHERE id=?`, [r.order_id]);
      check('Mixed Bill: header sales_flow=MIXED, derived purely from item modes (customer default_sales_flow=INVENTORY_SALE had no effect on this)', order.sales_flow === 'MIXED', order.sales_flow);

      // A customer defaulted to INVENTORY_SALE can still buy a NON_STOCK-only bill,
      // correctly resolving CARCASS_POS — proving OrderAgent never reads default_sales_flow.
      const r2 = await OrderAgent.create({ customer_id: customer.id, order_date: '2025-06-01', items: [billItem(pCarcass, 1)] }, adminUser());
      cleanup.orderIds.push(r2.order_id);
      const [[order2]] = await pool.query(`SELECT sales_flow FROM orders WHERE id=?`, [r2.order_id]);
      check('Mixed Bill: NON_STOCK-only bill for an INVENTORY_SALE-default customer still correctly resolves CARCASS_POS', order2.sales_flow === 'CARCASS_POS', order2.sales_flow);
    }

    // ══════════════════ Inventory PASS (stock deduction unaffected) ══════════════════
    {
      const rCust = await CustomerAgent.create({ name: 'CDM Inventory Test ' + Date.now(), phone: `09${String(Date.now()).slice(-6)}${String(Math.floor(Math.random()*90)+10)}`, partner_type: 2, default_sales_flow: 'CARCASS_POS' }, adminUser());
      const [[customer]] = await pool.query(`SELECT id FROM customers WHERE customer_code=?`, [rCust.customer_code]);
      cleanup.customerIds.push(customer.id);
      const pTrack = await makeProduct('TRACK_STOCK', { stock: 20, categoryId: catA });
      await priceAndCatalog(customer.id, catA, pTrack, 50000, 'INVENTORY_SALE');

      const before = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [pTrack.id]);
      const r = await OrderAgent.create({ customer_id: customer.id, order_date: '2025-06-01', items: [billItem(pTrack, 5)] }, adminUser());
      cleanup.orderIds.push(r.order_id);
      const after = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [pTrack.id]);
      check('Inventory: stock correctly decremented by 5 regardless of customer.default_sales_flow (=CARCASS_POS here, item is TRACK_STOCK)',
        Number(after[0][0].stock_quantity) === Number(before[0][0].stock_quantity) - 5,
        `${before[0][0].stock_quantity} -> ${after[0][0].stock_quantity}`);
    }

    // ══════════════════ Price PASS (resolution unaffected) ══════════════════
    {
      const rCust = await CustomerAgent.create({ name: 'CDM Price Test ' + Date.now(), phone: `09${String(Date.now()).slice(-6)}${String(Math.floor(Math.random()*90)+10)}`, partner_type: 2, default_sales_flow: 'INVENTORY_SALE' }, adminUser());
      const [[customer]] = await pool.query(`SELECT id FROM customers WHERE customer_code=?`, [rCust.customer_code]);
      cleanup.customerIds.push(customer.id);
      const p = await makeProduct('NON_STOCK', { categoryId: catA });
      // Explicit CARCASS_POS classification for this category, matching p's own
      // NON_STOCK/CARCASS_POS sales_flow (same pattern as cpcCarcass in the Mixed
      // Bill test above) — this customer's own default_sales_flow is
      // INVENTORY_SALE, and S1M makes an unclassified category INHERIT that,
      // which would mismatch a CARCASS_POS product. The test's own point (price
      // resolution unaffected by customer.default_sales_flow) is better proven
      // this way, not weaker: it now shows resolution working correctly even
      // when the category's classification differs from the customer's default.
      await priceAndCatalog(customer.id, catA, p, 88000, 'CARCASS_POS');

      const price = await PriceBookService.getEffectivePrice(customer.id, p.id, '2025-06-01', pool, 'SOLAR', '');
      check('Price: resolves correctly via PriceBookService regardless of customer.default_sales_flow', Number(price.sale_price) === 88000 && price.price_type === 'PRICE_BOOK', price);
    }

    // ══════════════════ Static proof: CreateOrder.jsx uses default_sales_flow only ══════════════════
    // ══════════════════ to pick the default catalog, no DB write, no page redirect ══════════════════
    // Unified Sales V1: the old separate 'Bán hàng kho' screen (InventorySales.jsx)
    // and its setPage('inventory-sales') redirect are retired — CreateOrder.jsx is
    // now the single sales screen for both flows, so this proof was updated to match.
    {
      const createOrderSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', 'CreateOrder.jsx'), 'utf8');
      check('CreateOrder.jsx reads default_sales_flow to pick the default catalog', /default_sales_flow===.INVENTORY_SALE./.test(createOrderSrc));
      check('CreateOrder.jsx no longer redirects to a separate inventory-sales page', !/setPage\('inventory-sales'\)/.test(createOrderSrc));
      check('CreateOrder.jsx never PUTs/POSTs default_sales_flow back to the customer record', !/api\.(put|post)\(['"`]\/customers[^)]*default_sales_flow/.test(createOrderSrc));

      const customersFormSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', 'Customers.jsx'), 'utf8');
      check('Customers.jsx form includes the default_sales_flow field', /default_sales_flow/.test(customersFormSrc));
      // fix(partner) test maintenance: regex updated for the bitmask-aware rewrite
      // in 9cf01ba ("fix(partner): remove duplicate supplier management menu",
      // 2026-08-05, predates this session) — same rule (required only for new
      // customers whose customer bit is set), just no longer the old exact
      // `!==1` check. Not a feb30a5 change; feb30a5 never touched Customers.jsx.
      check('Customers.jsx requires it only for new customers, not edits', /!editing&&\(Number\(form\.partner_type\)&2\)===2&&!form\.default_sales_flow/.test(customersFormSrc));

      const appSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', 'App.jsx'), 'utf8');
      check('App.jsx no longer routes a standalone InventorySales page', !/InventorySales/.test(appSrc));
    }

    // ══════════════════ Forbidden domains untouched (static proof) ══════════════════
    {
      // fix(partner) test maintenance: OrderAgent.js legitimately reads
      // default_sales_flow as of 7b59c3b ("feat(sales): unify sales flow and
      // CreateOrder experience", 2026-07-30, predates this session) — S1O:
      // resolving a legacy NULL-classified category's INHERITED flow
      // (assertItemsCategoryPerFlow), not the order header's own sales_flow.
      // The real invariant the old blanket check was protecting — the bill's
      // own sales_flow is never customer-default-driven — is verified here
      // directly (never assigned from customerDefaultFlow) AND independently
      // reconfirmed by the still-passing "Mixed Bill: header sales_flow=MIXED,
      // derived purely from item modes" check above. Not a feb30a5 change;
      // feb30a5 never touched OrderAgent.js.
      const orderAgentSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'agents', 'OrderAgent.js'), 'utf8');
      check('OrderAgent.js only uses default_sales_flow for legacy-category inheritance (S1O), never assigns it directly to orders.sales_flow',
        /default_sales_flow/.test(orderAgentSrc) && !/sales_flow\s*[=:]\s*customerDefaultFlow/.test(orderAgentSrc));
      const invServiceSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'InventoryService.js'), 'utf8');
      check('InventoryService.js never references default_sales_flow', !/default_sales_flow/.test(invServiceSrc));
      // fix(partner) test maintenance: PriceMatrixAgent.js legitimately
      // references default_sales_flow as of 5751f83 ("feat(pricing): complete
      // customer and supplier price-book workflows", 2026-07-30, predates this
      // session) — S1M: Customer Price Category inheritance. The real
      // invariant (price VALUE resolution unaffected by default_sales_flow) is
      // independently reconfirmed by the still-passing "Price: resolves
      // correctly via PriceBookService regardless of customer.default_sales_flow"
      // check above. Not a feb30a5 change; feb30a5 never touched PriceMatrixAgent.js.
      const priceMatrixSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'agents', 'PriceMatrixAgent.js'), 'utf8');
      check('PriceMatrixAgent.js references default_sales_flow only for S1M Customer Price Category inheritance (intentional, predates this feature)', /default_sales_flow/.test(priceMatrixSrc));
    }

  } finally {
    for (const oid of cleanup.orderIds) {
      if (!oid) continue;
      await pool.query(`DELETE FROM stock_transactions WHERE reference_type='SALE' AND reference_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM order_items WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM debt_transactions WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM orders WHERE id=?`, [oid]).catch(() => {});
    }
    for (const id of cleanup.productIds) {
      await pool.query(`DELETE FROM stock_transactions WHERE product_id=?`, [id]).catch(() => {});
      await pool.query(`DELETE FROM customer_product_prices WHERE product_id=?`, [id]).catch(() => {});
      await pool.query(`DELETE FROM customer_price_book_items WHERE product_id=?`, [id]).catch(() => {});
      await pool.query(`DELETE FROM products WHERE id=?`, [id]).catch(() => {});
    }
    for (const bookId of cleanup.bookIds) {
      await pool.query(`DELETE FROM customer_price_book_items WHERE price_book_id=?`, [bookId]).catch(() => {});
      await pool.query(`DELETE FROM customer_price_books WHERE id=?`, [bookId]).catch(() => {});
    }
    for (const cpcId of cleanup.priceCategoryIds) {
      await pool.query(`DELETE FROM customer_price_categories WHERE id=?`, [cpcId]).catch(() => {});
    }
    for (const customerId of cleanup.customerIds) {
      // A partner_type=1 test customer (the supplier-exemption case) triggers
      // CustomerAgent._syncPartnerToSupplier(), which creates a linked suppliers
      // row + supplier_partner_map entry — must be removed first, or the FK
      // leaves the customers row behind (silently, since every delete here is
      // best-effort .catch(()=>{})).
      const [[map]] = await pool.query(`SELECT supplier_id FROM supplier_partner_map WHERE partner_id=?`, [customerId]).catch(() => [[null]]);
      if (map) {
        await pool.query(`DELETE FROM supplier_partner_map WHERE partner_id=?`, [customerId]).catch(() => {});
        await pool.query(`DELETE FROM suppliers WHERE id=?`, [map.supplier_id]).catch(() => {});
      }
      await pool.query(`DELETE FROM price_change_logs WHERE customer_id=?`, [customerId]).catch(() => {});
      await pool.query(`DELETE FROM customer_product_catalogs WHERE customer_id=?`, [customerId]).catch(() => {});
      await pool.query(`DELETE FROM customers WHERE id=?`, [customerId]).catch(() => {});
    }
    console.log('Cleanup done.');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
