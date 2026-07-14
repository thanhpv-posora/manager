'use strict';
// Verifies S7.1's completed SoftDeleteAgent.refChecks (Customer, Category,
// Product, Supplier) — every reference table now listed for each entity must
// actually block a soft-delete when a row exists, and deletion must succeed
// once every reference is gone. No new framework — this only exercises the
// existing SoftDeleteAgent.softDelete()/hasReferences() mechanism.
//
// Self-cleaning: every fixture created here (customers, products, categories,
// suppliers, orders, price books, purchase orders, receives) is hard-deleted
// in `finally`, regardless of the soft-delete's own del_flg state.

const pool = require('../src/config/db');
const SoftDeleteAgent = require('../src/agents/SoftDeleteAgent');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}

const cleanup = { customers: [], products: [], categories: [], suppliers: [], orders: [], priceBooks: [], purchaseOrders: [], receives: [] };

async function expectBlocked(entityType, id, label, setupRef, clearRef) {
  await setupRef();
  let threw = null;
  try { await SoftDeleteAgent.softDelete(entityType, id, 'test reason', null); }
  catch (e) { threw = e; }
  check(`${entityType} blocked by "${label}"`, !!threw && threw.message.includes(label), threw && threw.message);
  await clearRef();
}

async function main() {
  try {
    // ── Shared helper fixtures (used to construct references FOR the entities under test) ──
    const [[helperCat]] = await pool.query(`SELECT id FROM product_categories LIMIT 1`);
    const [helperCust] = await pool.query(
      `INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type)
       VALUES(?,?,?,?,?,?,?,?)`,
      [`S71-HELPER-CUST-${Date.now()}`, 'S7.1 Helper Customer', '0', 'test', 'PRIVATE_PRICE', 0, 0, 'SOLAR']
    );
    const helperCustId = helperCust.insertId;
    cleanup.customers.push(helperCustId);
    const [helperProd] = await pool.query(
      `INSERT INTO products(product_code,name,unit,stock_quantity,inventory_mode,is_active,del_flg,category_id)
       VALUES(?,?,?,?,?,1,0,?)`,
      [`S71HELPERP${Date.now()}`, 'S7.1 Helper Product', 'kg', 0, 'TRACK_STOCK', helperCat.id]
    );
    const helperProdId = helperProd.insertId;
    cleanup.products.push(helperProdId);

    // ══════════════════════════════════════════════════════════
    // PRODUCT
    // ══════════════════════════════════════════════════════════
    {
      const mk = async () => {
        const [r] = await pool.query(`INSERT INTO products(product_code,name,unit,stock_quantity,inventory_mode,is_active,del_flg,category_id) VALUES(?,?,?,?,?,1,0,?)`,
          [`S71PROD${Date.now()}${Math.random().toString(36).slice(2,5)}`, 'S7.1 Product Test', 'kg', 0, 'TRACK_STOCK', helperCat.id]);
        return r.insertId;
      };

      // 1) order_items (existing check) — needs a real order
      {
        const id = await mk(); cleanup.products.push(id);
        let orderId;
        await expectBlocked('product', id, 'dòng bill',
          async () => {
            const [o] = await pool.query(`INSERT INTO orders(order_code,customer_id,order_date,status,payment_status,total_amount,paid_amount,debt_amount) VALUES(?,?,?,?,?,?,?,?)`,
              [`S71ORD${Date.now()}`, helperCustId, '2026-01-01', 'DELIVERED', 'UNPAID', 100, 0, 100]);
            orderId = o.insertId; cleanup.orders.push(orderId);
            await pool.query(`INSERT INTO order_items(order_id,product_id,product_name,unit,quantity,sale_price,total_price,price_type) VALUES(?,?,?,?,?,?,?,?)`,
              [orderId, id, 'x', 'kg', 1, 100, 100, 'MANUAL_PRICE']);
          },
          async () => { await pool.query(`DELETE FROM order_items WHERE order_id=?`, [orderId]); await pool.query(`DELETE FROM orders WHERE id=?`, [orderId]); cleanup.orders = cleanup.orders.filter(x=>x!==orderId); }
        );
      }

      // 2) stock_transactions (existing check)
      {
        const id = await mk(); cleanup.products.push(id);
        await expectBlocked('product', id, 'lịch sử kho',
          async () => { await pool.query(`INSERT INTO stock_transactions(product_id,transaction_date,type,quantity,reference_type,affect_stock) VALUES(?,?,?,?,?,?)`, [id, '2026-01-01', 'IN', 1, 'MANUAL', 1]); },
          async () => { await pool.query(`DELETE FROM stock_transactions WHERE product_id=?`, [id]); }
        );
      }

      // 3) customer_product_prices (existing check, keyed on product_id)
      {
        const id = await mk(); cleanup.products.push(id);
        await expectBlocked('product', id, 'giá riêng',
          async () => { await pool.query(`INSERT INTO customer_product_prices(customer_id,product_id,sale_price) VALUES(?,?,?)`, [helperCustId, id, 1000]); },
          async () => { await pool.query(`DELETE FROM customer_product_prices WHERE product_id=?`, [id]); }
        );
      }

      // 4) customer_price_book_items (NEW check)
      {
        const id = await mk(); cleanup.products.push(id);
        let bookId, itemId;
        await expectBlocked('product', id, 'bảng giá riêng khách hàng',
          async () => {
            const [b] = await pool.query(`INSERT INTO customer_price_books(customer_id,effective_from) VALUES(?,?)`, [helperCustId, '2026-01-01']);
            bookId = b.insertId; cleanup.priceBooks.push(bookId);
            const [it] = await pool.query(`INSERT INTO customer_price_book_items(price_book_id,customer_id,product_id,sale_price) VALUES(?,?,?,?)`, [bookId, helperCustId, id, 1000]);
            itemId = it.insertId;
          },
          async () => { await pool.query(`DELETE FROM customer_price_book_items WHERE id=?`, [itemId]); await pool.query(`DELETE FROM customer_price_books WHERE id=?`, [bookId]); cleanup.priceBooks = cleanup.priceBooks.filter(x=>x!==bookId); }
        );
      }

      // 5) Negative control: no references at all → delete succeeds
      {
        const id = await mk();
        const r = await SoftDeleteAgent.softDelete('product', id, 'test reason cleanup', null);
        check('product with NO references: soft-delete succeeds', !!r.message, JSON.stringify(r));
        cleanup.products.push(id);
      }
    }

    // ══════════════════════════════════════════════════════════
    // CATEGORY
    // ══════════════════════════════════════════════════════════
    {
      const mk = async () => {
        const [r] = await pool.query(`INSERT INTO product_categories(name,sort_order,is_active,del_flg) VALUES(?,?,1,0)`, [`S7.1 Cat ${Date.now()}${Math.random().toString(36).slice(2,5)}`, 0]);
        return r.insertId;
      };

      // 1) products (existing check)
      {
        const id = await mk(); cleanup.categories.push(id);
        let prodId;
        await expectBlocked('category', id, 'mặt hàng',
          async () => { const [p] = await pool.query(`INSERT INTO products(product_code,name,unit,stock_quantity,inventory_mode,is_active,del_flg,category_id) VALUES(?,?,?,?,?,1,0,?)`, [`S71CATP${Date.now()}`, 'x', 'kg', 0, 'TRACK_STOCK', id]); prodId = p.insertId; cleanup.products.push(prodId); },
          async () => { await pool.query(`DELETE FROM products WHERE id=?`, [prodId]); cleanup.products = cleanup.products.filter(x=>x!==prodId); }
        );
      }

      // 2) customer_price_categories (NEW check)
      {
        const id = await mk(); cleanup.categories.push(id);
        let cpcId;
        await expectBlocked('category', id, 'danh mục giá khách hàng',
          async () => { const [c] = await pool.query(`INSERT INTO customer_price_categories(customer_id,category_id,is_default,display_order) VALUES(?,?,0,1)`, [helperCustId, id]); cpcId = c.insertId; },
          async () => { await pool.query(`DELETE FROM customer_price_categories WHERE id=?`, [cpcId]); }
        );
      }

      // 3) customer_price_books (NEW check, keyed on category_id)
      {
        const id = await mk(); cleanup.categories.push(id);
        let bookId;
        await expectBlocked('category', id, 'bảng giá riêng',
          async () => { const [b] = await pool.query(`INSERT INTO customer_price_books(customer_id,effective_from,category_id) VALUES(?,?,?)`, [helperCustId, '2026-01-01', id]); bookId = b.insertId; },
          async () => { await pool.query(`DELETE FROM customer_price_books WHERE id=?`, [bookId]); }
        );
      }

      // 4) Negative control
      {
        const id = await mk();
        const r = await SoftDeleteAgent.softDelete('category', id, 'test reason cleanup', null);
        check('category with NO references: soft-delete succeeds', !!r.message, JSON.stringify(r));
        cleanup.categories.push(id);
      }
    }

    // ══════════════════════════════════════════════════════════
    // CUSTOMER
    // ══════════════════════════════════════════════════════════
    {
      const mk = async () => {
        const [r] = await pool.query(`INSERT INTO customers(customer_code,name,phone,address,price_mode,debt_limit,payment_term_days,billing_calendar_type) VALUES(?,?,?,?,?,?,?,?)`,
          [`S71CUST${Date.now()}${Math.random().toString(36).slice(2,5)}`, 'S7.1 Customer Test', '0', 'test', 'PRIVATE_PRICE', 0, 0, 'SOLAR']);
        return r.insertId;
      };

      // 1) orders (existing)
      {
        const id = await mk(); cleanup.customers.push(id);
        let orderId;
        await expectBlocked('customer', id, 'bill bán',
          async () => { const [o] = await pool.query(`INSERT INTO orders(order_code,customer_id,order_date,status,payment_status,total_amount,paid_amount,debt_amount) VALUES(?,?,?,?,?,?,?,?)`, [`S71CO${Date.now()}`, id, '2026-01-01', 'DELIVERED', 'UNPAID', 100, 0, 100]); orderId = o.insertId; },
          async () => { await pool.query(`DELETE FROM orders WHERE id=?`, [orderId]); }
        );
      }

      // 2) payments (existing)
      {
        const id = await mk(); cleanup.customers.push(id);
        let payId;
        await expectBlocked('customer', id, 'phiếu thu',
          async () => { const [p] = await pool.query(`INSERT INTO payments(payment_code,customer_id,payment_date,amount,payment_method) VALUES(?,?,?,?,?)`, [`S71PAY${Date.now()}`, id, '2026-01-01', 100, 'CASH']); payId = p.insertId; },
          async () => { await pool.query(`DELETE FROM payments WHERE id=?`, [payId]); }
        );
      }

      // 3) debt_transactions (existing)
      {
        const id = await mk(); cleanup.customers.push(id);
        let debtId;
        await expectBlocked('customer', id, 'công nợ',
          async () => { const [d] = await pool.query(`INSERT INTO debt_transactions(customer_id,transaction_date,type,amount) VALUES(?,?,?,?)`, [id, '2026-01-01', 'SALE', 100]); debtId = d.insertId; },
          async () => { await pool.query(`DELETE FROM debt_transactions WHERE id=?`, [debtId]); }
        );
      }

      // 4) customer_price_books (NEW, keyed on customer_id)
      {
        const id = await mk(); cleanup.customers.push(id);
        let bookId;
        await expectBlocked('customer', id, 'bảng giá riêng',
          async () => { const [b] = await pool.query(`INSERT INTO customer_price_books(customer_id,effective_from) VALUES(?,?)`, [id, '2026-01-01']); bookId = b.insertId; },
          async () => { await pool.query(`DELETE FROM customer_price_books WHERE id=?`, [bookId]); }
        );
      }

      // 5) customer_price_categories (NEW)
      {
        const id = await mk(); cleanup.customers.push(id);
        let cpcId;
        await expectBlocked('customer', id, 'danh mục giá khách hàng',
          async () => { const [c] = await pool.query(`INSERT INTO customer_price_categories(customer_id,category_id,is_default,display_order) VALUES(?,?,0,1)`, [id, helperCat.id]); cpcId = c.insertId; },
          async () => { await pool.query(`DELETE FROM customer_price_categories WHERE id=?`, [cpcId]); }
        );
      }

      // 6) customer_product_catalogs (NEW)
      {
        const id = await mk(); cleanup.customers.push(id);
        let catalogId;
        await expectBlocked('customer', id, 'danh mục mặt hàng khách hàng',
          async () => { const [c] = await pool.query(`INSERT INTO customer_product_catalogs(customer_id,product_id,sort_order,is_default,is_active,del_flg) VALUES(?,?,0,1,1,0)`, [id, helperProdId]); catalogId = c.insertId; },
          async () => { await pool.query(`DELETE FROM customer_product_catalogs WHERE id=?`, [catalogId]); }
        );
      }

      // 7) customer_product_prices (NEW, keyed on customer_id)
      {
        const id = await mk(); cleanup.customers.push(id);
        let priceId;
        await expectBlocked('customer', id, 'giá riêng (cũ)',
          async () => { const [p] = await pool.query(`INSERT INTO customer_product_prices(customer_id,product_id,sale_price) VALUES(?,?,?)`, [id, helperProdId, 1000]); priceId = p.insertId; },
          async () => { await pool.query(`DELETE FROM customer_product_prices WHERE id=?`, [priceId]); }
        );
      }

      // 8) Negative control
      {
        const id = await mk();
        const r = await SoftDeleteAgent.softDelete('customer', id, 'test reason cleanup', null);
        check('customer with NO references: soft-delete succeeds', !!r.message, JSON.stringify(r));
        cleanup.customers.push(id);
      }
    }

    // ══════════════════════════════════════════════════════════
    // SUPPLIER
    // ══════════════════════════════════════════════════════════
    {
      const mk = async () => {
        const [r] = await pool.query(`INSERT INTO suppliers(supplier_code,name,is_active,del_flg) VALUES(?,?,1,0)`, [`S71SUP${Date.now()}${Math.random().toString(36).slice(2,5)}`, 'S7.1 Supplier Test']);
        return r.insertId;
      };

      // 1) purchase_lots (existing)
      {
        const id = await mk(); cleanup.suppliers.push(id);
        let lotId;
        await expectBlocked('supplier', id, 'lô nhập',
          async () => { const [l] = await pool.query(`INSERT INTO purchase_lots(lot_code,lot_name,supplier_id,purchase_date) VALUES(?,?,?,?)`, [`S71LOT${Date.now()}`, 'x', id, '2026-01-01']); lotId = l.insertId; },
          async () => { await pool.query(`DELETE FROM purchase_lots WHERE id=?`, [lotId]); }
        );
      }

      // 2) supplier_purchase_options (NEW)
      {
        const id = await mk(); cleanup.suppliers.push(id);
        const [[unit]] = await pool.query(`SELECT id FROM units LIMIT 1`);
        let optId;
        await expectBlocked('supplier', id, 'quy cách nhập hàng',
          async () => { const [o] = await pool.query(`INSERT INTO supplier_purchase_options(supplier_id,product_id,unit_id,default_conversion_qty) VALUES(?,?,?,?)`, [id, helperProdId, unit.id, 1]); optId = o.insertId; },
          async () => { await pool.query(`DELETE FROM supplier_purchase_options WHERE id=?`, [optId]); }
        );
      }

      // 3) purchase_orders (NEW)
      {
        const id = await mk(); cleanup.suppliers.push(id);
        let poId;
        await expectBlocked('supplier', id, 'phiếu mua hàng',
          async () => { const [po] = await pool.query(`INSERT INTO purchase_orders(purchase_code,supplier_id,purchase_date) VALUES(?,?,?)`, [`S71PO${Date.now()}`, id, '2026-01-01']); poId = po.insertId; },
          async () => { await pool.query(`DELETE FROM purchase_orders WHERE id=?`, [poId]); }
        );
      }

      // 4) inventory_receives (NEW)
      {
        const id = await mk(); cleanup.suppliers.push(id);
        let poId, recvId;
        await expectBlocked('supplier', id, 'phiếu nhận hàng',
          async () => {
            const [po] = await pool.query(`INSERT INTO purchase_orders(purchase_code,supplier_id,purchase_date) VALUES(?,?,?)`, [`S71PO2${Date.now()}`, id, '2026-01-01']);
            poId = po.insertId;
            const [rv] = await pool.query(`INSERT INTO inventory_receives(receive_code,purchase_order_id,receive_date,supplier_id) VALUES(?,?,?,?)`, [`S71RV${Date.now()}`, poId, '2026-01-01', id]);
            recvId = rv.insertId;
          },
          async () => { await pool.query(`DELETE FROM inventory_receives WHERE id=?`, [recvId]); await pool.query(`DELETE FROM purchase_orders WHERE id=?`, [poId]); }
        );
      }

      // 5) Negative control
      {
        const id = await mk();
        const r = await SoftDeleteAgent.softDelete('supplier', id, 'test reason cleanup', null);
        check('supplier with NO references: soft-delete succeeds', !!r.message, JSON.stringify(r));
        cleanup.suppliers.push(id);
      }
    }

  } finally {
    for (const id of cleanup.receives) await pool.query(`DELETE FROM inventory_receives WHERE id=?`, [id]).catch(()=>{});
    for (const id of cleanup.purchaseOrders) await pool.query(`DELETE FROM purchase_orders WHERE id=?`, [id]).catch(()=>{});
    for (const id of cleanup.priceBooks) { await pool.query(`DELETE FROM customer_price_book_items WHERE price_book_id=?`, [id]).catch(()=>{}); await pool.query(`DELETE FROM customer_price_books WHERE id=?`, [id]).catch(()=>{}); }
    for (const id of cleanup.orders) { await pool.query(`DELETE FROM order_items WHERE order_id=?`, [id]).catch(()=>{}); await pool.query(`DELETE FROM debt_transactions WHERE order_id=?`, [id]).catch(()=>{}); await pool.query(`DELETE FROM orders WHERE id=?`, [id]).catch(()=>{}); }
    // catch-all sweep for any purchase_orders/inventory_receives left referencing test suppliers
    for (const id of cleanup.suppliers) {
      const [rvs] = await pool.query(`SELECT id FROM inventory_receives WHERE supplier_id=?`, [id]).catch(()=>[[]]);
      for (const rv of (rvs||[])) await pool.query(`DELETE FROM inventory_receives WHERE id=?`, [rv.id]).catch(()=>{});
      const [pos] = await pool.query(`SELECT id FROM purchase_orders WHERE supplier_id=?`, [id]).catch(()=>[[]]);
      for (const po of (pos||[])) await pool.query(`DELETE FROM purchase_orders WHERE id=?`, [po.id]).catch(()=>{});
      await pool.query(`DELETE FROM supplier_purchase_options WHERE supplier_id=?`, [id]).catch(()=>{});
      await pool.query(`DELETE FROM purchase_lots WHERE supplier_id=?`, [id]).catch(()=>{});
      await pool.query(`DELETE FROM suppliers WHERE id=?`, [id]).catch(()=>{});
    }
    for (const id of cleanup.categories) {
      await pool.query(`DELETE FROM customer_price_books WHERE category_id=?`, [id]).catch(()=>{});
      await pool.query(`DELETE FROM customer_price_categories WHERE category_id=?`, [id]).catch(()=>{});
      await pool.query(`DELETE FROM products WHERE category_id=? AND name LIKE 'S7.1%'`, [id]).catch(()=>{});
      await pool.query(`DELETE FROM product_categories WHERE id=?`, [id]).catch(()=>{});
    }
    for (const id of cleanup.customers) {
      await pool.query(`DELETE FROM customer_price_book_items WHERE customer_id=?`, [id]).catch(()=>{});
      await pool.query(`DELETE FROM customer_price_books WHERE customer_id=?`, [id]).catch(()=>{});
      await pool.query(`DELETE FROM customer_price_categories WHERE customer_id=?`, [id]).catch(()=>{});
      await pool.query(`DELETE FROM customer_product_catalogs WHERE customer_id=?`, [id]).catch(()=>{});
      await pool.query(`DELETE FROM customer_product_prices WHERE customer_id=?`, [id]).catch(()=>{});
      await pool.query(`DELETE FROM payments WHERE customer_id=?`, [id]).catch(()=>{});
      await pool.query(`DELETE FROM debt_transactions WHERE customer_id=?`, [id]).catch(()=>{});
      await pool.query(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE customer_id=?)`, [id]).catch(()=>{});
      await pool.query(`DELETE FROM orders WHERE customer_id=?`, [id]).catch(()=>{});
      await pool.query(`DELETE FROM customers WHERE id=?`, [id]).catch(()=>{});
    }
    for (const id of cleanup.products) {
      await pool.query(`DELETE FROM stock_transactions WHERE product_id=?`, [id]).catch(()=>{});
      await pool.query(`DELETE FROM customer_product_prices WHERE product_id=?`, [id]).catch(()=>{});
      await pool.query(`DELETE FROM customer_price_book_items WHERE product_id=?`, [id]).catch(()=>{});
      await pool.query(`DELETE FROM customer_product_catalogs WHERE product_id=?`, [id]).catch(()=>{});
      await pool.query(`DELETE FROM supplier_purchase_options WHERE product_id=?`, [id]).catch(()=>{});
      await pool.query(`DELETE FROM order_items WHERE product_id=?`, [id]).catch(()=>{});
      await pool.query(`DELETE FROM products WHERE id=?`, [id]).catch(()=>{});
    }
    await pool.query(`DELETE FROM delete_logs WHERE reason IN ('test reason','test reason cleanup')`).catch(()=>{});
    console.log('Cleanup done.');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
