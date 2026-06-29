'use strict';

function normalizeInventoryMode(value) {
  const mode = String(value || 'NON_STOCK').toUpperCase();
  if (mode === 'TRACK_STOCK' || mode === 'STOCK') return 'TRACK_STOCK';
  if (mode === 'CARCASS_PART') return 'CARCASS_PART';
  return 'NON_STOCK';
}

function normalizeNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

class InventoryService {
  async out(conn, productId, quantity, date, refType, refId, note, userId) {
    const [rows] = await conn.query(
      `SELECT id,name,inventory_mode,stock_quantity,allow_negative_stock
       FROM products
       WHERE id=? AND del_flg=0`,
      [productId]
    );
    if(!rows.length) throw new Error('Không tìm thấy mặt hàng');

    const p = rows[0];
    const mode = p.inventory_mode || 'STOCK';
    const qty = Number(quantity || 0);

    // STOCK/TRACK_STOCK : frozen/real goods → enforce balance.
    // NON_STOCK         : bò xô/whole carcass → skip balance, log movement.
    // CARCASS_PART      : deboned parts → skip balance, log movement.
    // allow_negative_stock=1 → always skip balance check.
    const skipStockCheck = mode === 'NON_STOCK' || mode === 'CARCASS_PART' || Number(p.allow_negative_stock) === 1;

    if(skipStockCheck) {
      await conn.query(
        `INSERT INTO stock_transactions(product_id,transaction_date,type,quantity,reference_type,reference_id,note,created_by)
         VALUES(?,?,'OUT',?,?,?,?,?)`,
        [productId,date,qty,refType,refId,`${note} / SKIP_STOCK_CHECK / ${mode}`,userId]
      );
      return {stock_checked:false, inventory_mode:mode};
    }

    if(Number(p.stock_quantity) < qty) {
      throw new Error(`Không đủ tồn kho cho "${p.name}". Tồn hiện tại: ${p.stock_quantity}, cần xuất: ${qty}. Nếu đây là hàng bò xô/pha lóc, vào Mặt hàng / sửa giá đổi mode sang CARCASS_PART hoặc bật Cho phép không kiểm tồn.`);
    }

    await conn.query(`UPDATE products SET stock_quantity=stock_quantity-? WHERE id=?`, [qty, productId]);
    await conn.query(
      `INSERT INTO stock_transactions(product_id,transaction_date,type,quantity,reference_type,reference_id,note,created_by)
       VALUES(?,?,'OUT',?,?,?,?,?)`,
      [productId,date,qty,refType,refId,note,userId]
    );
    return {stock_checked:true, inventory_mode:mode};
  }

  async in(conn, productId, quantity, date, refType, refId, note, userId) {
    const [rows] = await conn.query(
      `SELECT id, name, inventory_mode FROM products WHERE id = ? AND del_flg = 0`,
      [productId]
    );
    if (!rows.length) throw new Error('Không tìm thấy mặt hàng');
    const p = rows[0];
    const mode = normalizeInventoryMode(p.inventory_mode);
    const qty = Number(quantity || 0);
    if (qty <= 0) return { stock_added: false, inventory_mode: mode, qty_added: 0 };
    const skipBalance = mode === 'NON_STOCK' || mode === 'CARCASS_PART';
    if (!skipBalance) {
      await conn.query(`UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ?`, [qty, productId]);
    }
    await conn.query(
      `INSERT INTO stock_transactions(product_id,transaction_date,type,quantity,reference_type,reference_id,note,created_by)
       VALUES(?,?,'IN',?,?,?,?,?)`,
      [productId, date || new Date(), qty, refType || 'MANUAL', refId || null, note || null, userId || null]
    );
    return { stock_added: !skipBalance, inventory_mode: mode, qty_added: qty };
  }

  async adjustOrderItem(conn, productId, oldQty, newQty) {
    const [rows] = await conn.query(`SELECT inventory_mode,allow_negative_stock FROM products WHERE id=?`, [productId]);
    const mode = rows[0]?.inventory_mode || 'STOCK';
    if(mode === 'NON_STOCK' || mode === 'CARCASS_PART' || Number(rows[0]?.allow_negative_stock) === 1) return;
    await conn.query(`UPDATE products SET stock_quantity = stock_quantity + ? - ? WHERE id=?`, [oldQty, newQty, productId]);
  }

  // Single authoritative writer for AI/order-service sale paths.
  // Replaces the direct-write logic that previously lived in inventory.service.js.
  // Uses delta UPDATE (atomic) instead of the old absolute-value assignment (race condition).
  async applyOrderInventory(conn, orderId, items = [], options = {}) {
    const userId = options.user_id || null;
    const orderDate = options.order_date || null;
    const results = [];

    for (const item of items) {
      const [rows] = await conn.query(
        `SELECT id, name, stock_quantity, inventory_mode, allow_negative_stock
         FROM products WHERE id = ? AND del_flg = 0 LIMIT 1`,
        [item.product_id]
      );
      if (!rows.length) throw new Error(`Không tìm thấy sản phẩm ID=${item.product_id}`);

      const p = rows[0];
      const mode = normalizeInventoryMode(p.inventory_mode);
      const qty = normalizeNumber(item.quantity);
      const beforeQty = normalizeNumber(p.stock_quantity);
      const allowNeg = Number(p.allow_negative_stock || 0);

      if (mode === 'NON_STOCK') {
        results.push({ product_id: p.id, product_name: p.name, inventory_mode: mode, action: 'NO_STOCK_SKIP' });
        continue;
      }

      // CARCASS_PART or allow_negative_stock: log movement, skip balance update.
      if (mode === 'CARCASS_PART' || allowNeg === 1) {
        await conn.query(
          `INSERT INTO stock_transactions(product_id,transaction_date,type,quantity,reference_type,reference_id,note,created_by)
           VALUES(?,?,'OUT',?,'SALE',?,?,?)`,
          [p.id, orderDate || new Date(), qty, orderId,
           mode === 'CARCASS_PART' ? 'AI sale from carcass part' : 'AI sale stock deduct',
           userId]
        );
        results.push({
          product_id: p.id, product_name: p.name, inventory_mode: mode,
          action: 'SKIP_STOCK_CHECK',
          qty_before: beforeQty, qty_change: qty, qty_after: beforeQty - qty
        });
        continue;
      }

      // TRACK_STOCK: validate then atomically deduct.
      if (beforeQty < qty) {
        throw new Error(`Không đủ tồn kho ${p.name}. Tồn hiện tại: ${beforeQty}, cần bán: ${qty}`);
      }

      await conn.query(
        `UPDATE products SET stock_quantity = stock_quantity - ?, updated_at = NOW() WHERE id = ?`,
        [qty, p.id]
      );
      await conn.query(
        `INSERT INTO stock_transactions(product_id,transaction_date,type,quantity,reference_type,reference_id,note,created_by)
         VALUES(?,?,'OUT',?,'SALE',?,?,?)`,
        [p.id, orderDate || new Date(), qty, orderId, 'AI sale stock deduct', userId]
      );

      results.push({
        product_id: p.id, product_name: p.name, inventory_mode: mode,
        action: 'OUT',
        qty_before: beforeQty, qty_change: qty, qty_after: beforeQty - qty
      });
    }

    return results;
  }
}

module.exports = new InventoryService();
