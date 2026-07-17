'use strict';
// S1H — Product Domain Integrity Guard verification.
//
// Business rule: once a product has participated in a business transaction
// (order_items, purchase_order_items, inventory_receive_items, or
// stock_transactions), products.sales_flow and products.inventory_mode become
// immutable. Price Book references alone do NOT count as business history.
//
// Required cases (per ticket):
//   PASS — New Product, change sales_flow
//   PASS — New Product, change inventory_mode
//   FAIL — Product used in Order, change sales_flow
//   FAIL — Product used in Receive, change inventory_mode
//   FAIL — Product with Stock Ledger, change inventory_mode
//   PASS — Edit Product name / note (barcode: no such column in this schema —
//          product_code, its closest analog, is not part of the updateProduct
//          SET clause and was already immutable before this ticket)
// Bonus: Product used in a Purchase Order (purchase_order_items) — the 4th
// history table named in the ticket's Business History section.
//
// Self-cleaning: throwaway products only, removed in `finally`. No shared
// fixtures (customers/categories) are touched.

const pool = require('../src/config/db');
const ProductAgent = require('../src/agents/ProductAgent');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}

const cleanup = { productIds: [], orderIds: [], customerIds: [], purchaseOrderIds: [], supplierIds: [], receiveIds: [] };

async function makeProduct(salesFlow, inventoryMode) {
  const tag = `S1H ${salesFlow}/${inventoryMode} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await ProductAgent.addProduct({ name: tag, unit: 'kg', sales_flow: salesFlow, inventory_mode: inventoryMode });
  const [[created]] = await pool.query(`SELECT * FROM products WHERE name=? LIMIT 1`, [tag]);
  cleanup.productIds.push(created.id);
  return created;
}

// order_items/purchase_order_items/inventory_receive_items carry real FK
// constraints to orders/purchase_orders/inventory_receives (customer_id ->
// customers, supplier_id -> suppliers) — throwaway parent rows are needed to
// simulate "business history", not just a bare product_id row.
async function makeOrder() {
  const tag = `S1H-ORD-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const [cust] = await pool.query(
    `INSERT INTO customers(customer_code,name,billing_calendar_type,price_mode) VALUES(?,?,?,?)`,
    [`S1H-CUST-${tag}`, `S1H Test Customer ${tag}`, 'SOLAR', 'COMMON_PRICE']
  );
  cleanup.customerIds.push(cust.insertId);
  const [ord] = await pool.query(
    `INSERT INTO orders(order_code,customer_id,order_date) VALUES(?,?,CURDATE())`,
    [tag, cust.insertId]
  );
  cleanup.orderIds.push(ord.insertId);
  return ord.insertId;
}

async function makePurchaseOrder() {
  const tag = `S1H-PO-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const [sup] = await pool.query(
    `INSERT INTO suppliers(supplier_code,name) VALUES(?,?)`,
    [`S1H-SUP-${tag}`, `S1H Test Supplier ${tag}`]
  );
  cleanup.supplierIds.push(sup.insertId);
  const [po] = await pool.query(
    `INSERT INTO purchase_orders(purchase_code,supplier_id,purchase_date) VALUES(?,?,CURDATE())`,
    [tag, sup.insertId]
  );
  cleanup.purchaseOrderIds.push(po.insertId);
  return { purchaseOrderId: po.insertId, supplierId: sup.insertId };
}

async function makeInventoryReceive() {
  const tag = `S1H-RCV-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const { purchaseOrderId, supplierId } = await makePurchaseOrder();
  const [rcv] = await pool.query(
    `INSERT INTO inventory_receives(receive_code,purchase_order_id,receive_date,supplier_id) VALUES(?,?,CURDATE(),?)`,
    [tag, purchaseOrderId, supplierId]
  );
  cleanup.receiveIds.push(rcv.insertId);
  return rcv.insertId;
}

async function expectReject(label, fn) {
  try {
    await fn();
    check(label, false, 'expected rejection but update succeeded');
  } catch (e) {
    const is400 = (e.status === 400 || e.statusCode === 400);
    const hasMessage = /Không được thay đổi Luồng bán hoặc Chế độ tồn/.test(e.message || '');
    check(label, is400 && hasMessage, `status=${e.status || e.statusCode} message="${e.message}"`);
  }
}

async function expectAllow(label, fn) {
  try {
    await fn();
    check(label, true);
  } catch (e) {
    check(label, false, `unexpected rejection: ${e.message}`);
  }
}

async function main() {
  console.log('=== S1H Product Domain Integrity Guard verification ===\n');
  try {

    // --- PASS: New Product, change sales_flow ---
    {
      const p = await makeProduct('CARCASS_POS', 'NON_STOCK');
      await expectAllow(
        'PASS: new product (no history) — change sales_flow CARCASS_POS -> INVENTORY_SALE',
        () => ProductAgent.updateProduct(p.id, { name: p.name, unit: 'kg', sales_flow: 'INVENTORY_SALE', inventory_mode: 'TRACK_STOCK' })
      );
      const [[after]] = await pool.query(`SELECT sales_flow,inventory_mode FROM products WHERE id=?`, [p.id]);
      check('  -> sales_flow actually persisted as INVENTORY_SALE', after.sales_flow === 'INVENTORY_SALE', after);
    }

    // --- PASS: New Product, change inventory_mode ---
    {
      const p = await makeProduct('CARCASS_POS', 'NON_STOCK');
      await expectAllow(
        'PASS: new product (no history) — change inventory_mode NON_STOCK -> CARCASS_PART',
        () => ProductAgent.updateProduct(p.id, { name: p.name, unit: 'kg', sales_flow: 'CARCASS_POS', inventory_mode: 'CARCASS_PART' })
      );
      const [[after]] = await pool.query(`SELECT sales_flow,inventory_mode FROM products WHERE id=?`, [p.id]);
      check('  -> inventory_mode actually persisted as CARCASS_PART', after.inventory_mode === 'CARCASS_PART', after);
    }

    // --- FAIL: Product used in Order, change sales_flow ---
    {
      const p = await makeProduct('CARCASS_POS', 'NON_STOCK');
      const orderId = await makeOrder();
      await pool.query(
        `INSERT INTO order_items(order_id,product_id,product_name,unit,quantity,sale_price,total_price) VALUES(?,?,?,?,?,?,?)`,
        [orderId, p.id, p.name, 'kg', 1, 1000, 1000]
      );
      await expectReject(
        'FAIL: product used in order_items — change sales_flow CARCASS_POS -> INVENTORY_SALE',
        () => ProductAgent.updateProduct(p.id, { name: p.name, unit: 'kg', sales_flow: 'INVENTORY_SALE', inventory_mode: 'TRACK_STOCK' })
      );
      const [[after]] = await pool.query(`SELECT sales_flow FROM products WHERE id=?`, [p.id]);
      check('  -> sales_flow unchanged in DB', after.sales_flow === 'CARCASS_POS', after);
      await pool.query(`DELETE FROM order_items WHERE product_id=?`, [p.id]);
    }

    // --- FAIL: Product used in Receive, change inventory_mode ---
    {
      const p = await makeProduct('CARCASS_POS', 'NON_STOCK');
      const receiveId = await makeInventoryReceive();
      await pool.query(
        `INSERT INTO inventory_receive_items(receive_id,product_id) VALUES(?,?)`,
        [receiveId, p.id]
      );
      await expectReject(
        'FAIL: product used in inventory_receive_items — change inventory_mode NON_STOCK -> CARCASS_PART',
        () => ProductAgent.updateProduct(p.id, { name: p.name, unit: 'kg', sales_flow: 'CARCASS_POS', inventory_mode: 'CARCASS_PART' })
      );
      const [[after]] = await pool.query(`SELECT inventory_mode FROM products WHERE id=?`, [p.id]);
      check('  -> inventory_mode unchanged in DB', after.inventory_mode === 'NON_STOCK', after);
      await pool.query(`DELETE FROM inventory_receive_items WHERE product_id=?`, [p.id]);
    }

    // --- FAIL: Product with Stock Ledger, change inventory_mode ---
    {
      const p = await makeProduct('CARCASS_POS', 'NON_STOCK');
      await pool.query(
        `INSERT INTO stock_transactions(product_id,transaction_date,type,quantity,reference_type) VALUES(?,CURDATE(),'IN',1,'MANUAL')`,
        [p.id]
      );
      await expectReject(
        'FAIL: product with stock_transactions ledger — change inventory_mode NON_STOCK -> CARCASS_PART',
        () => ProductAgent.updateProduct(p.id, { name: p.name, unit: 'kg', sales_flow: 'CARCASS_POS', inventory_mode: 'CARCASS_PART' })
      );
      const [[after]] = await pool.query(`SELECT inventory_mode FROM products WHERE id=?`, [p.id]);
      check('  -> inventory_mode unchanged in DB', after.inventory_mode === 'NON_STOCK', after);
      await pool.query(`DELETE FROM stock_transactions WHERE product_id=?`, [p.id]);
    }

    // --- Bonus: Product used in a Purchase Order, change inventory_mode ---
    {
      const p = await makeProduct('CARCASS_POS', 'NON_STOCK');
      const { purchaseOrderId } = await makePurchaseOrder();
      await pool.query(
        `INSERT INTO purchase_order_items(purchase_order_id,product_id,product_name,unit,quantity,purchase_price,total_price) VALUES(?,?,?,?,?,?,?)`,
        [purchaseOrderId, p.id, p.name, 'kg', 1, 1000, 1000]
      );
      await expectReject(
        'BONUS-FAIL: product used in purchase_order_items — change inventory_mode NON_STOCK -> CARCASS_PART',
        () => ProductAgent.updateProduct(p.id, { name: p.name, unit: 'kg', sales_flow: 'CARCASS_POS', inventory_mode: 'CARCASS_PART' })
      );
      await pool.query(`DELETE FROM purchase_order_items WHERE product_id=?`, [p.id]);
    }

    // --- PASS: Edit Product name / note on a USED product (fields unchanged) ---
    {
      const p = await makeProduct('CARCASS_POS', 'NON_STOCK');
      const orderId = await makeOrder();
      await pool.query(
        `INSERT INTO order_items(order_id,product_id,product_name,unit,quantity,sale_price,total_price) VALUES(?,?,?,?,?,?,?)`,
        [orderId, p.id, p.name, 'kg', 1, 1000, 1000]
      );
      const newName = p.name + ' EDITED';
      await expectAllow(
        'PASS: used product — edit name only (sales_flow/inventory_mode resent unchanged)',
        () => ProductAgent.updateProduct(p.id, { name: newName, unit: 'kg', note: 'ghi chú mới', sales_flow: 'CARCASS_POS', inventory_mode: 'NON_STOCK' })
      );
      const [[after]] = await pool.query(`SELECT name,note,sales_flow,inventory_mode FROM products WHERE id=?`, [p.id]);
      check('  -> name persisted', after.name === newName, after);
      check('  -> note persisted', after.note === 'ghi chú mới', after);
      check('  -> sales_flow/inventory_mode still untouched', after.sales_flow === 'CARCASS_POS' && after.inventory_mode === 'NON_STOCK', after);
      await pool.query(`DELETE FROM order_items WHERE product_id=?`, [p.id]);
    }

    // --- PASS: Legacy product WITHOUT history remains fully editable ---
    {
      const p = await makeProduct('INVENTORY_SALE', 'TRACK_STOCK');
      await expectAllow(
        'PASS: legacy-style product, no history — change both sales_flow and inventory_mode',
        () => ProductAgent.updateProduct(p.id, { name: p.name, unit: 'kg', sales_flow: 'CARCASS_POS', inventory_mode: 'NON_STOCK' })
      );
    }

  } finally {
    for (const id of cleanup.productIds) {
      await pool.query(`DELETE FROM order_items WHERE product_id=?`, [id]).catch(() => {});
      await pool.query(`DELETE FROM purchase_order_items WHERE product_id=?`, [id]).catch(() => {});
      await pool.query(`DELETE FROM inventory_receive_items WHERE product_id=?`, [id]).catch(() => {});
      await pool.query(`DELETE FROM stock_transactions WHERE product_id=?`, [id]).catch(() => {});
      await pool.query(`DELETE FROM products WHERE id=?`, [id]).catch(() => {});
    }
    for (const id of cleanup.receiveIds) {
      await pool.query(`DELETE FROM inventory_receives WHERE id=?`, [id]).catch(() => {});
    }
    for (const id of cleanup.purchaseOrderIds) {
      await pool.query(`DELETE FROM purchase_orders WHERE id=?`, [id]).catch(() => {});
    }
    for (const id of cleanup.supplierIds) {
      await pool.query(`DELETE FROM suppliers WHERE id=?`, [id]).catch(() => {});
    }
    for (const id of cleanup.orderIds) {
      await pool.query(`DELETE FROM orders WHERE id=?`, [id]).catch(() => {});
    }
    for (const id of cleanup.customerIds) {
      await pool.query(`DELETE FROM customers WHERE id=?`, [id]).catch(() => {});
    }
    console.log('Cleanup done.');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
