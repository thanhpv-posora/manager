'use strict';
// Seeds opening stock for the demo TRACK_STOCK product (DEMO_PRD_STOCK)
// created by backend/sql/restore_demo_data.sql.
//
// WHY THIS IS A NODE SCRIPT AND NOT PART OF THE SQL FILE:
// products.stock_quantity is owned exclusively by InventoryMovementService
// (the Single Writer — INV-004/S6.1). Hand-writing the equivalent
// UPDATE+INSERT pair directly in SQL would work today, but would silently
// drift out of sync if that service's logic ever changes (e.g. a future
// warehouse_id requirement, a new invariant check). Calling
// InventoryService.opening() here means this script can never fall behind
// the real business logic.
//
// IDEMPOTENT: before posting, checks stock_transactions for an existing
// reference_type='OPENING_BALANCE' row for this product. If found, does
// nothing and reports the existing balance — safe to re-run.
//
// NOT EXECUTED as part of this task. Run manually, after restore_demo_data.sql,
// with: node backend/scripts/restore-demo-opening-stock.js

const pool = require('../src/config/db');
const InventoryService = require('../src/services/InventoryService');

const DEMO_PRODUCT_CODE = 'DEMO_PRD_STOCK';
const OPENING_QTY = 10; // demo quantity — arbitrary, clearly a test value (CTO decision 2026-07-28: 10, was 50)
const OPENING_NOTE = 'DEMO - Tồn kho ban đầu (restore-demo-opening-stock.js)';

async function main() {
  const [[product]] = await pool.query(
    `SELECT id, name, inventory_mode, sales_flow, stock_quantity FROM products WHERE product_code = ? AND del_flg = 0`,
    [DEMO_PRODUCT_CODE]
  );
  if (!product) {
    console.error(`FATAL: product ${DEMO_PRODUCT_CODE} not found. Run restore_demo_data.sql first.`);
    process.exit(1);
  }
  if (product.inventory_mode !== 'TRACK_STOCK') {
    console.error(`FATAL: ${DEMO_PRODUCT_CODE} has inventory_mode=${product.inventory_mode}, expected TRACK_STOCK. Refusing to post opening stock.`);
    process.exit(1);
  }

  const [existing] = await pool.query(
    `SELECT id, quantity, transaction_date FROM stock_transactions WHERE product_id = ? AND reference_type = 'OPENING_BALANCE' LIMIT 1`,
    [product.id]
  );
  if (existing.length) {
    console.log(`Opening balance already posted for ${DEMO_PRODUCT_CODE} (stock_transactions.id=${existing[0].id}, qty=${existing[0].quantity}, date=${existing[0].transaction_date}). Current stock_quantity=${product.stock_quantity}. Nothing to do.`);
    process.exit(0);
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await InventoryService.opening(conn, product.id, OPENING_QTY, new Date(), OPENING_NOTE, null);
    await conn.commit();
    console.log(`Posted opening stock: ${DEMO_PRODUCT_CODE} += ${OPENING_QTY} via InventoryService.opening(). Re-run this script anytime — it is idempotent (checks for an existing OPENING_BALANCE row first).`);
  } catch (e) {
    await conn.rollback();
    console.error('FATAL: opening stock post failed, rolled back.', e);
    process.exit(1);
  } finally {
    conn.release();
  }

  const [[after]] = await pool.query(`SELECT stock_quantity FROM products WHERE id = ?`, [product.id]);
  console.log(`Verification: products.stock_quantity for ${DEMO_PRODUCT_CODE} is now ${after.stock_quantity}.`);
  process.exit(0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
