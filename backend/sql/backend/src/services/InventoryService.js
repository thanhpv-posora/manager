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

    // Agent rule:
    // STOCK        : hàng có tồn thật như gà/vịt/thịt đông lạnh => kiểm tồn.
    // NON_STOCK   : bò xô/nguyên con, không biết từng phần trước => không kiểm tồn từng mã.
    // CARCASS_PART: đùi/búp/nạm/sườn... phát sinh khi pha lóc bò xô => không kiểm tồn từng mã.
    // allow_negative_stock=1: cho phép bán không chặn tồn.
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

  async adjustOrderItem(conn, productId, oldQty, newQty) {
    const [rows] = await conn.query(`SELECT inventory_mode,allow_negative_stock FROM products WHERE id=?`, [productId]);
    const mode = rows[0]?.inventory_mode || 'STOCK';
    if(mode === 'NON_STOCK' || mode === 'CARCASS_PART' || Number(rows[0]?.allow_negative_stock) === 1) return;
    await conn.query(`UPDATE products SET stock_quantity = stock_quantity + ? - ? WHERE id=?`, [oldQty, newQty, productId]);
  }
}
module.exports = new InventoryService();
