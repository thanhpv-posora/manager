'use strict';
// S8.0 F3/F5 — verifies:
//   F3: order item quantity must be > 0 (reject 0/negative/null) at all four
//       entry points — OrderAgent.create/addItem/updateItem, and
//       order.service.js confirmOrderDraft (the AI "backward compatible"
//       direct-confirm path, which bypasses createOrderDraft()'s own check).
//   F5: order.service.js confirmOrderDraft() must persist order_items.
//       inventory_mode/stock_checked from the real InventoryService result,
//       exactly like the POS path (OrderAgent.create()) — no hardcoded
//       null/null/0, no duplicated policy logic.
//
// Self-cleaning: throwaway customer + products + orders, removed in `finally`.

const pool = require('../src/config/db');
const OrderAgent = require('../src/agents/OrderAgent');
const ProductAgent = require('../src/agents/ProductAgent');
const { confirmOrderDraft } = require('../src/services/order.service');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}

async function makeProduct(mode, qty) {
  await ProductAgent.addProduct({
    name: `S8.0 F3F5 ${mode} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    unit: 'kg', inventory_mode: mode, stock_quantity: qty, allow_negative_stock: 0,
    default_sale_price: 50000,
  });
  const [[created]] = await pool.query(`SELECT * FROM products WHERE name LIKE 'S8.0 F3F5 ${mode} %' ORDER BY id DESC LIMIT 1`);
  return created;
}

async function main() {
  const productIds = [];
  const orderIds = [];
  let customerId = null;
  const user = { id: null };
  const today = new Date().toISOString().slice(0, 10);

  try {
    const [custIns] = await pool.query(
      `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type)
       VALUES(?,?,?,?,?,?,?,?)`,
      [`S80-CUST-${Date.now()}`, 'S8.0 F3F5 Test Customer', '0', 'test', 'PRIVATE_PRICE', 0, 0, 'SOLAR']
    );
    customerId = custIns.insertId;

    // ══════════════════════ F3 — OrderAgent.create() ══════════════════════
    {
      const p = await makeProduct('TRACK_STOCK', 100);
      productIds.push(p.id);
      const basePayload = (qty) => ({
        customer_id: customerId, order_date: today,
        items: [{ product_id: p.id, product_name: 'x', unit: 'kg', quantity: qty, sale_price: 10000, manual_price: true }],
      });
      for (const bad of [0, -5, null, undefined]) {
        let threw = null;
        try { await OrderAgent.create(basePayload(bad), user); } catch (e) { threw = e; }
        check(`create(): rejects quantity=${bad}`, !!threw, threw && threw.message);
      }
      const r = await OrderAgent.create(basePayload(5), user);
      orderIds.push(r.order_id);
      check('create(): still accepts a valid positive quantity', !!r.order_id);
    }

    // ══════════════════════ F3 — OrderAgent.addItem() ══════════════════════
    {
      const p1 = await makeProduct('TRACK_STOCK', 100);
      const p2 = await makeProduct('TRACK_STOCK', 100);
      productIds.push(p1.id, p2.id);
      const r = await OrderAgent.create({
        customer_id: customerId, order_date: today,
        items: [{ product_id: p1.id, product_name: 'x', unit: 'kg', quantity: 5, sale_price: 10000, manual_price: true }],
      }, user);
      orderIds.push(r.order_id);
      for (const bad of [0, -5, null, undefined]) {
        let threw = null;
        try { await OrderAgent.addItem(r.order_id, { product_id: p2.id, quantity: bad, sale_price: 10000 }, user); } catch (e) { threw = e; }
        check(`addItem(): rejects quantity=${bad}`, !!threw, threw && threw.message);
      }
    }

    // ══════════════════════ F3 — OrderAgent.updateItem() ══════════════════════
    {
      const p = await makeProduct('TRACK_STOCK', 100);
      productIds.push(p.id);
      const r = await OrderAgent.create({
        customer_id: customerId, order_date: today,
        items: [{ product_id: p.id, product_name: 'x', unit: 'kg', quantity: 5, sale_price: 10000, manual_price: true }],
      }, user);
      orderIds.push(r.order_id);
      const [[item]] = await pool.query(`SELECT * FROM order_items WHERE order_id=?`, [r.order_id]);
      for (const bad of [0, -5, null, undefined]) {
        let threw = null;
        try { await OrderAgent.updateItem(r.order_id, item.id, { quantity: bad, sale_price: 10000 }, user); } catch (e) { threw = e; }
        check(`updateItem(): rejects quantity=${bad}`, !!threw, threw && threw.message);
      }
      const after = await pool.query(`SELECT quantity FROM order_items WHERE id=?`, [item.id]);
      check('updateItem(): rejected edits left the original quantity untouched', Number(after[0][0].quantity) === 5, after[0][0].quantity);
    }

    // ══════════════════════ F3 — confirmOrderDraft() (AI backward-compatible direct confirm) ══════════════════════
    {
      const p = await makeProduct('TRACK_STOCK', 100);
      productIds.push(p.id);
      const basePayload = (qty) => ({
        customer: { id: customerId },
        items: [{ product_id: p.id, product_name: p.name, unit: 'kg', quantity: qty }],
        bill_date: today,
      });
      for (const bad of [0, -5, null, undefined]) {
        let threw = null;
        try { await confirmOrderDraft(basePayload(bad)); } catch (e) { threw = e; }
        check(`confirmOrderDraft(): rejects quantity=${bad}`, !!threw, threw && threw.message);
      }
    }

    // ══════════════════════ F5 — confirmOrderDraft() persists real inventory_mode/stock_checked ══════════════════════
    {
      const pTrack = await makeProduct('TRACK_STOCK', 100);
      const pCarcass = await makeProduct('CARCASS_PART', 0);
      const pNonStock = await makeProduct('NON_STOCK', 0);
      productIds.push(pTrack.id, pCarcass.id, pNonStock.id);

      const result = await confirmOrderDraft({
        customer: { id: customerId },
        items: [
          { product_id: pTrack.id, product_name: pTrack.name, unit: 'kg', quantity: 5 },
          { product_id: pCarcass.id, product_name: pCarcass.name, unit: 'kg', quantity: 3 },
          { product_id: pNonStock.id, product_name: pNonStock.name, unit: 'kg', quantity: 2 },
        ],
        bill_date: today,
      });
      orderIds.push(result.order_id);

      const [rows] = await pool.query(`SELECT product_id, inventory_mode, stock_checked FROM order_items WHERE order_id=?`, [result.order_id]);
      const byProduct = Object.fromEntries(rows.map(r => [r.product_id, r]));

      check('F5: TRACK_STOCK row has inventory_mode=TRACK_STOCK persisted (not null)', byProduct[pTrack.id]?.inventory_mode === 'TRACK_STOCK', JSON.stringify(byProduct[pTrack.id]));
      check('F5: TRACK_STOCK row has stock_checked=1 (real stock check happened)', Number(byProduct[pTrack.id]?.stock_checked) === 1, byProduct[pTrack.id]?.stock_checked);

      check('F5: CARCASS_PART row has inventory_mode=CARCASS_PART persisted (not null)', byProduct[pCarcass.id]?.inventory_mode === 'CARCASS_PART', JSON.stringify(byProduct[pCarcass.id]));
      check('F5: CARCASS_PART row has stock_checked=0 (no real stock check)', Number(byProduct[pCarcass.id]?.stock_checked) === 0, byProduct[pCarcass.id]?.stock_checked);

      check('F5: NON_STOCK row has inventory_mode=NON_STOCK persisted (not null)', byProduct[pNonStock.id]?.inventory_mode === 'NON_STOCK', JSON.stringify(byProduct[pNonStock.id]));
      check('F5: NON_STOCK row has stock_checked=0', Number(byProduct[pNonStock.id]?.stock_checked) === 0, byProduct[pNonStock.id]?.stock_checked);

      const afterTrack = await pool.query(`SELECT stock_quantity FROM products WHERE id=?`, [pTrack.id]);
      check('F5: TRACK_STOCK balance actually deducted (100→95), inventory write still happened', Number(afterTrack[0][0].stock_quantity) === 95, afterTrack[0][0].stock_quantity);
    }

  } finally {
    for (const oid of orderIds) {
      if (!oid) continue;
      await pool.query(`DELETE FROM order_items WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM debt_transactions WHERE order_id=?`, [oid]).catch(() => {});
      await pool.query(`DELETE FROM orders WHERE id=?`, [oid]).catch(() => {});
    }
    for (const id of productIds) {
      await pool.query(`DELETE FROM stock_transactions WHERE product_id=?`, [id]).catch(() => {});
      await pool.query(`DELETE FROM products WHERE id=?`, [id]).catch(() => {});
    }
    if (customerId) {
      await pool.query(`DELETE FROM customer_product_catalogs WHERE customer_id=?`, [customerId]).catch(() => {});
      await pool.query(`DELETE FROM customer_product_prices WHERE customer_id=?`, [customerId]).catch(() => {});
      await pool.query(`DELETE FROM customers WHERE id=?`, [customerId]).catch(() => {});
    }
    console.log('Cleanup done.');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
