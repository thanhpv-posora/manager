'use strict';
const pool = require('../config/db');
const { nextCode } = require('../utils/code');
const { normalizeInventoryMode } = require('../utils/inventoryMode');
const PurchaseReceiveTimelineService = require('../services/PurchaseReceiveTimelineService');
const SupplierPurchaseCatalogResolver = require('../services/SupplierPurchaseCatalogResolver');

class InventoryPurchaseAgent {
  constructor() {
    this.version = '1.2.0';
    this.responsibility = 'Inventory purchase order CRUD — Domain B (purchase_orders + purchase_order_items), partner_id primary (BP-003)';
  }

  async list(query) {
    const { partner_id, supplier_id, status, date_from, date_to, page = 1, limit = 50 } = query;
    const where = ['po.del_flg = 0'];
    const params = [];
    if (partner_id)       { where.push('po.partner_id = ?');   params.push(partner_id); }
    else if (supplier_id) { where.push('po.supplier_id = ?');  params.push(supplier_id); }
    if (status)    { where.push('po.status = ?');      params.push(status); }
    if (date_from) { where.push('po.purchase_date >= ?'); params.push(date_from); }
    if (date_to)   { where.push('po.purchase_date <= ?'); params.push(date_to); }
    const wSql = where.join(' AND ');
    const off = (Math.max(1, Number(page)) - 1) * Number(limit);
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) total FROM purchase_orders po WHERE ${wSql}`, params
    );
    const [rows] = await pool.query(
      `SELECT po.id, po.order_code, po.partner_id, po.supplier_id,
              COALESCE(p.name, s.name) supplier_name,
              po.purchase_date, po.status, po.total_amount,
              po.note, po.reference_no, po.created_at,
              (SELECT COUNT(*) FROM purchase_order_items WHERE purchase_order_id = po.id) item_count
       FROM purchase_orders po
       LEFT JOIN customers p ON p.id = po.partner_id
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       WHERE ${wSql}
       ORDER BY po.id DESC LIMIT ? OFFSET ?`,
      [...params, Number(limit), off]
    );
    return { items: rows, total: Number(total), page: Number(page), limit: Number(limit) };
  }

  async get(id) {
    const [[order]] = await pool.query(
      `SELECT po.id, po.order_code, po.partner_id, po.supplier_id,
              COALESCE(p.name, s.name) supplier_name,
              po.purchase_date, po.status, po.total_amount,
              po.note, po.reference_no, po.created_by, po.created_at, po.updated_at,
              po.short_close_reason, po.short_closed_by, po.short_closed_at
       FROM purchase_orders po
       LEFT JOIN customers p ON p.id = po.partner_id
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       WHERE po.id = ? AND po.del_flg = 0`,
      [id]
    );
    if (!order) return null;
    const [items] = await pool.query(
      `SELECT poi.id, poi.product_id, poi.product_name, poi.unit,
              poi.quantity, poi.received_quantity, poi.purchase_price, poi.total_price,
              poi.supplier_purchase_option_id,
              poi.expected_conversion_qty, poi.requires_actual_weight,
              poi.expected_stock_qty, poi.inventory_status, poi.note,
              poi.price_book_id, poi.price_book_item_id
       FROM purchase_order_items poi
       WHERE poi.purchase_order_id = ?
       ORDER BY poi.id ASC`,
      [id]
    );
    return { ...order, items };
  }

  // "Nạp bảng giá NCC" — resolve this PO's supplier's effective purchase
  // price book (by the PO's own purchase_date), for the bulk-entry dialog.
  // Read-only: never creates/modifies a price book. Returns
  // price_book_id=null + empty items when no effective book exists — the
  // caller shows "Nhà cung cấp chưa có bảng giá mua phù hợp với ngày nhập."
  // rather than falling back to any other price source.
  async priceBookForBulkEntry(id, categoryId) {
    const [[order]] = await pool.query(
      `SELECT id, partner_id, supplier_id, purchase_date, status FROM purchase_orders WHERE id=? AND del_flg=0`,
      [id]
    );
    if (!order) throw Object.assign(new Error('Không tìm thấy phiếu mua hàng'), { status: 404 });
    if (!order.partner_id) return { price_book_id: null, items: [] };

    const calendarType = await this._resolveCalendarType(order);
    return SupplierPurchaseCatalogResolver.resolvePriceBookForBulkEntry(
      order.partner_id, order.supplier_id, order.purchase_date, calendarType, categoryId ? Number(categoryId) : null
    );
  }

  // S4.3: Receive History Timeline — thin passthrough. Business query lives in
  // PurchaseReceiveTimelineService; this agent does not contain SQL for it.
  async timeline(id, params) {
    return PurchaseReceiveTimelineService.getTimeline(id, params);
  }

  async create(body, userId) {
    const { partner_id, supplier_id, purchase_date, note, reference_no } = body;
    if (!partner_id && !supplier_id)
      throw Object.assign(new Error('Thiếu nhà cung cấp'), { status: 400 });
    if (!purchase_date)
      throw Object.assign(new Error('Thiếu ngày nhập'), { status: 400 });

    const { resolvedPartnerId, resolvedSupplierId } = await this._resolvePartner(partner_id, supplier_id);

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const code = await nextCode(conn, 'purchase_orders', 'purchase_code', 'PO');
      const [r] = await conn.query(
        `INSERT INTO purchase_orders
           (purchase_code, order_code, supplier_id, partner_id, purchase_date, status, total_amount, note, reference_no, created_by)
         VALUES (?, ?, ?, ?, ?, 'DRAFT', 0, ?, ?, ?)`,
        [code, code, resolvedSupplierId, resolvedPartnerId, purchase_date, note || null, reference_no || null, userId || null]
      );
      await conn.commit();
      return { id: r.insertId, order_code: code };
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }

  async update(id, body, userId) {
    await this._requireDraft(id);
    const { partner_id, supplier_id, purchase_date, note, reference_no } = body;
    if (!partner_id && !supplier_id)
      throw Object.assign(new Error('Thiếu nhà cung cấp'), { status: 400 });
    if (!purchase_date)
      throw Object.assign(new Error('Thiếu ngày nhập'), { status: 400 });

    const { resolvedPartnerId, resolvedSupplierId } = await this._resolvePartner(partner_id, supplier_id);

    await pool.query(
      `UPDATE purchase_orders
       SET supplier_id=?, partner_id=?, purchase_date=?, note=?, reference_no=?
       WHERE id=?`,
      [resolvedSupplierId, resolvedPartnerId, purchase_date, note || null, reference_no || null, id]
    );
    return { message: 'Đã cập nhật phiếu nhập' };
  }

  async addItem(orderId, body, userId) {
    const order = await this._requireDraft(orderId);
    const snap = await this._buildItemSnapshot(body, order);
    const { note } = body;
    const [r] = await pool.query(
      `INSERT INTO purchase_order_items
         (purchase_order_id, product_id, product_name, unit, quantity, purchase_price, total_price,
          supplier_purchase_option_id, expected_conversion_qty, requires_actual_weight,
          expected_stock_qty, inventory_status, note, price_book_id, price_book_item_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'PENDING',?,?,?)`,
      [orderId, snap.product_id, snap.product_name, snap.unit, snap.qty, snap.price,
       snap.total_price, snap.spo_id, snap.expected_conversion_qty,
       snap.requires_actual_weight, snap.expected_stock_qty, note || null,
       snap.price_book_id, snap.price_book_item_id]
    );
    await this._recalcTotal(orderId);
    return { id: r.insertId, message: 'Đã thêm dòng hàng' };
  }

  async syncItems(orderId, rows, userId) {
    const order = await this._requireDraft(orderId);
    rows = Array.isArray(rows) ? rows : [];

    const [existing] = await pool.query(
      `SELECT id FROM purchase_order_items WHERE purchase_order_id = ?`, [orderId]
    );
    const existingIds = new Set(existing.map(r => r.id));
    const keptIds = new Set();
    let saved = 0;

    for (const row of rows) {
      const qty = Number(row.quantity || 0);
      if (!row.product_id || !(qty > 0)) continue;
      const snap = await this._buildItemSnapshot({
        product_id:                  row.product_id,
        supplier_purchase_option_id: row.supplier_purchase_option_id || null,
        quantity:                    qty,
        purchase_price:              Number(row.purchase_price || 0),
        price_book_id:               row.price_book_id || null,
        price_book_item_id:          row.price_book_item_id || null,
      }, order);
      if (row.item_id && existingIds.has(Number(row.item_id))) {
        await pool.query(
          `UPDATE purchase_order_items
           SET product_id=?, product_name=?, unit=?, quantity=?, purchase_price=?, total_price=?,
               supplier_purchase_option_id=?, expected_conversion_qty=?, requires_actual_weight=?,
               expected_stock_qty=?, inventory_status='PENDING', note=?,
               price_book_id=?, price_book_item_id=?
           WHERE id=?`,
          [snap.product_id, snap.product_name, snap.unit, snap.qty, snap.price, snap.total_price,
           snap.spo_id, snap.expected_conversion_qty, snap.requires_actual_weight,
           snap.expected_stock_qty, row.note || null, snap.price_book_id, snap.price_book_item_id, row.item_id]
        );
        keptIds.add(Number(row.item_id));
      } else {
        await pool.query(
          `INSERT INTO purchase_order_items
             (purchase_order_id, product_id, product_name, unit, quantity, purchase_price, total_price,
              supplier_purchase_option_id, expected_conversion_qty, requires_actual_weight,
              expected_stock_qty, inventory_status, note, price_book_id, price_book_item_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,'PENDING',?,?,?)`,
          [orderId, snap.product_id, snap.product_name, snap.unit, snap.qty, snap.price, snap.total_price,
           snap.spo_id, snap.expected_conversion_qty, snap.requires_actual_weight,
           snap.expected_stock_qty, row.note || null, snap.price_book_id, snap.price_book_item_id]
        );
      }
      saved++;
    }

    for (const ex of existing) {
      if (!keptIds.has(ex.id)) {
        await pool.query(`DELETE FROM purchase_order_items WHERE id=?`, [ex.id]);
      }
    }

    await this._recalcTotal(orderId);
    return { saved, message: `Đã lưu ${saved} dòng hàng` };
  }

  async updateItem(orderId, itemId, body, userId) {
    const order = await this._requireDraft(orderId);
    const [[ex]] = await pool.query(
      `SELECT id FROM purchase_order_items WHERE id=? AND purchase_order_id=?`, [itemId, orderId]
    );
    if (!ex) throw Object.assign(new Error('Không tìm thấy dòng hàng'), { status: 404 });
    const snap = await this._buildItemSnapshot(body, order);
    const { note } = body;
    await pool.query(
      `UPDATE purchase_order_items
       SET product_id=?, product_name=?, unit=?, quantity=?, purchase_price=?, total_price=?,
           supplier_purchase_option_id=?, expected_conversion_qty=?, requires_actual_weight=?,
           expected_stock_qty=?, inventory_status='PENDING', note=?
       WHERE id=?`,
      [snap.product_id, snap.product_name, snap.unit, snap.qty, snap.price, snap.total_price,
       snap.spo_id, snap.expected_conversion_qty, snap.requires_actual_weight,
       snap.expected_stock_qty, note || null, itemId]
    );
    await this._recalcTotal(orderId);
    return { message: 'Đã cập nhật dòng hàng' };
  }

  async deleteItem(orderId, itemId, userId) {
    await this._requireDraft(orderId);
    const [[ex]] = await pool.query(
      `SELECT id FROM purchase_order_items WHERE id=? AND purchase_order_id=?`, [itemId, orderId]
    );
    if (!ex) throw Object.assign(new Error('Không tìm thấy dòng hàng'), { status: 404 });
    await pool.query(`DELETE FROM purchase_order_items WHERE id=?`, [itemId]);
    await this._recalcTotal(orderId);
    return { message: 'Đã xóa dòng hàng' };
  }

  async updateStatus(id, status, userId) {
    if (!['CONFIRMED', 'CANCELLED'].includes(status))
      throw Object.assign(new Error('Trạng thái không hợp lệ. Chỉ CONFIRMED hoặc CANCELLED'), { status: 400 });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[row]] = await conn.query(
        `SELECT id, status FROM purchase_orders WHERE id=? AND del_flg=0 FOR UPDATE`, [id]
      );
      if (!row) throw Object.assign(new Error('Không tìm thấy phiếu nhập'), { status: 404 });

      if (status === 'CONFIRMED') {
        if (row.status !== 'DRAFT')
          throw Object.assign(new Error('Chỉ có thể xác nhận phiếu nhập ở trạng thái DRAFT'), { status: 400 });
        const [[{ cnt }]] = await conn.query(
          `SELECT COUNT(*) cnt FROM purchase_order_items WHERE purchase_order_id=?`, [id]
        );
        if (!Number(cnt))
          throw Object.assign(new Error('Phiếu chưa có dòng hàng, không thể xác nhận'), { status: 400 });
      }

      if (status === 'CANCELLED') {
        if (!['DRAFT', 'CONFIRMED'].includes(row.status))
          throw Object.assign(new Error('Không thể hủy phiếu ở trạng thái hiện tại'), { status: 400 });
        if (row.status === 'CONFIRMED') {
          const [[{ r_count }]] = await conn.query(
            `SELECT COUNT(*) r_count FROM inventory_receives
             WHERE purchase_order_id=? AND status='RECEIVED'`, [id]
          );
          if (Number(r_count) > 0)
            throw Object.assign(new Error('Phiếu đã có hàng nhập kho, không thể hủy'), { status: 400 });
          const [[{ rx_count }]] = await conn.query(
            `SELECT COUNT(*) rx_count FROM purchase_order_items
             WHERE purchase_order_id=? AND received_stock_qty > 0`, [id]
          );
          if (Number(rx_count) > 0)
            throw Object.assign(new Error('Phiếu đã có dòng hàng được nhận, không thể hủy'), { status: 400 });
        }
      }

      await conn.query(`UPDATE purchase_orders SET status=? WHERE id=?`, [status, id]);
      await conn.commit();
      return { message: status === 'CONFIRMED' ? 'Đã xác nhận phiếu nhập' : 'Đã hủy phiếu nhập' };
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }

  // S4.2-C / CEO review: Short Close — closes out the undelivered remainder of
  // a PO that has already had at least one partial receipt, without an
  // inventory movement. It must not be usable as a cancel: CONFIRMED with
  // zero received_stock_qty is rejected (use CANCELLED for that). Once
  // SHORT_CLOSED, InventoryReceiveService.receive() and this agent's own
  // CANCEL guard both key off purchase_orders.status, so neither further
  // receiving nor cancelling is separately re-checked here — status alone
  // already excludes SHORT_CLOSED from both of those status lists.
  async shortClose(id, reason, userId) {
    const trimmedReason = String(reason || '').trim();
    if (!trimmedReason)
      throw Object.assign(new Error('Cần nhập lý do đóng phần còn lại'), { status: 400 });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[row]] = await conn.query(
        `SELECT id, status FROM purchase_orders WHERE id=? AND del_flg=0 FOR UPDATE`, [id]
      );
      if (!row) throw Object.assign(new Error('Không tìm thấy phiếu nhập'), { status: 404 });
      if (!['CONFIRMED', 'PARTIAL_RECEIVED'].includes(row.status))
        throw Object.assign(
          new Error(`Không thể đóng phần còn lại ở trạng thái "${row.status}". Cần CONFIRMED hoặc PARTIAL_RECEIVED`),
          { status: 400 }
        );

      const [[{ total_received }]] = await conn.query(
        `SELECT COALESCE(SUM(received_stock_qty), 0) total_received
         FROM purchase_order_items WHERE purchase_order_id = ?`,
        [id]
      );
      if (Number(total_received) <= 0)
        throw Object.assign(
          new Error('Chỉ được đóng phần còn lại sau khi đã nhận hàng một phần'),
          { status: 400 }
        );

      await conn.query(
        `UPDATE purchase_orders
         SET status='SHORT_CLOSED', short_close_reason=?, short_closed_by=?, short_closed_at=NOW()
         WHERE id=?`,
        [trimmedReason, userId || null, id]
      );
      await conn.commit();
      return { message: 'Đã đóng phần còn lại của phiếu nhập' };
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }

  // ── Private ──────────────────────────────────────────────────────────────

  async _resolvePartner(partnerId, supplierId) {
    let resolvedPartnerId  = partnerId  ? Number(partnerId)  : null;
    let resolvedSupplierId = supplierId ? Number(supplierId) : null;

    if (resolvedPartnerId) {
      const [[partner]] = await pool.query(
        `SELECT id FROM customers WHERE id = ? AND (partner_type & 1) = 1 AND del_flg = 0`,
        [resolvedPartnerId]
      );
      if (!partner)
        throw Object.assign(new Error('Không tìm thấy nhà cung cấp (partner)'), { status: 404 });
      if (!resolvedSupplierId) {
        const [[map]] = await pool.query(
          `SELECT supplier_id FROM supplier_partner_map WHERE partner_id = ?`, [resolvedPartnerId]
        );
        if (map) resolvedSupplierId = map.supplier_id;
      }
    }

    if (resolvedSupplierId && !resolvedPartnerId) {
      const [[sup]] = await pool.query(
        `SELECT id FROM suppliers WHERE id = ? AND del_flg = 0`, [resolvedSupplierId]
      );
      if (!sup)
        throw Object.assign(new Error('Không tìm thấy nhà cung cấp'), { status: 404 });
      const [[map]] = await pool.query(
        `SELECT partner_id FROM supplier_partner_map WHERE supplier_id = ?`, [resolvedSupplierId]
      );
      if (map) resolvedPartnerId = map.partner_id;
    }

    if (!resolvedSupplierId)
      throw Object.assign(
        new Error('Nhà cung cấp chưa có mapping trong hệ thống. Liên hệ admin.'), { status: 400 }
      );

    return { resolvedPartnerId, resolvedSupplierId };
  }

  async _requireDraft(id) {
    const [[row]] = await pool.query(
      `SELECT id, status, partner_id, supplier_id, purchase_date FROM purchase_orders WHERE id=? AND del_flg=0`, [id]
    );
    if (!row) throw Object.assign(new Error('Không tìm thấy phiếu nhập'), { status: 404 });
    if (row.status !== 'DRAFT')
      throw Object.assign(new Error('Chỉ có thể chỉnh sửa phiếu nhập ở trạng thái DRAFT'), { status: 400 });
    return row;
  }

  // S4.2: calendar type for price-book lookup follows the partner/supplier's own billing
  // calendar (same convention as PriceBookService.customerCalendarType), default SOLAR.
  async _resolveCalendarType(order) {
    if (order.partner_id) {
      const [[c]] = await pool.query(`SELECT billing_calendar_type FROM customers WHERE id=?`, [order.partner_id]);
      if (c) return String(c.billing_calendar_type || 'SOLAR').toUpperCase() === 'LUNAR' ? 'LUNAR' : 'SOLAR';
    }
    if (order.supplier_id) {
      const [[s]] = await pool.query(`SELECT billing_calendar_type FROM suppliers WHERE id=?`, [order.supplier_id]);
      if (s) return String(s.billing_calendar_type || 'SOLAR').toUpperCase() === 'LUNAR' ? 'LUNAR' : 'SOLAR';
    }
    return 'SOLAR';
  }

  async _recalcTotal(orderId) {
    await pool.query(
      `UPDATE purchase_orders SET total_amount=(
         SELECT COALESCE(SUM(total_price),0) FROM purchase_order_items WHERE purchase_order_id=?
       ) WHERE id=?`,
      [orderId, orderId]
    );
  }

  // S4.2: purchase_price from the client is never trusted as authoritative on its own.
  // We always re-resolve via SupplierPurchaseCatalogResolver (price book primary,
  // product_supplier_links fallback), scoped to the product's own category. When a
  // catalog price exists, it overrides whatever the client sent. Only when neither
  // source has a price do we fall back to accepting the client's manual entry.
  async _buildItemSnapshot(body, order = null) {
    const { product_id, supplier_purchase_option_id, quantity, purchase_price, price_book_id, price_book_item_id } = body;
    if (!product_id) throw Object.assign(new Error('Thiếu sản phẩm'), { status: 400 });
    const qty        = Number(quantity);
    const clientPrice = Number(purchase_price);
    if (!(qty > 0))                     throw Object.assign(new Error('Số lượng phải lớn hơn 0'),  { status: 400 });
    if (isNaN(clientPrice) || clientPrice < 0) throw Object.assign(new Error('Giá nhập không hợp lệ'), { status: 400 });

    const [[prod]] = await pool.query(
      `SELECT id, name, inventory_mode, category_id FROM products WHERE id=? AND del_flg=0`, [product_id]
    );
    if (!prod) throw Object.assign(new Error('Không tìm thấy sản phẩm'), { status: 404 });
    // inventory_mode is not a gate for PO creation; stock movement is recorded at receive confirmation.
    // Store normalised mode on snapshot so receive agent can decide whether to update stock_quantity.
    prod.inventory_mode = normalizeInventoryMode(prod.inventory_mode);

    let price = clientPrice;
    if (order && (order.partner_id || order.supplier_id)) {
      const calendarType = await this._resolveCalendarType(order);
      const resolved = await SupplierPurchaseCatalogResolver.resolveSinglePrice(
        order.partner_id, order.supplier_id, product_id, prod.category_id, order.purchase_date, calendarType
      );
      if (resolved) price = resolved.price;
    }

    let unit = 'kg', expected_conversion_qty = 1, requires_actual_weight = 0;
    const spo_id = supplier_purchase_option_id || null;

    if (spo_id) {
      const [[opt]] = await pool.query(
        `SELECT spo.default_conversion_qty, spo.requires_actual_weight,
                u.code unit_code, u.name unit_name
         FROM supplier_purchase_options spo
         JOIN units u ON u.id = spo.unit_id
         WHERE spo.id=? AND spo.is_active=1`,
        [spo_id]
      );
      if (!opt) throw Object.assign(new Error('Quy cách nhập không tồn tại hoặc đã bị tắt'), { status: 404 });
      unit                    = opt.unit_name;
      expected_conversion_qty = Number(opt.default_conversion_qty);
      requires_actual_weight  = opt.requires_actual_weight;
    }

    const expected_stock_qty = qty * expected_conversion_qty;

    // Traceability only (which price book this row came from, if any) — never
    // trusted for the price itself, which is always the server-resolved
    // `price` above. Validated so a client can't attach an arbitrary/stale
    // book-item id to a row: it must actually exist and reference this exact
    // product. Once persisted, this is a snapshot like every other field on
    // this row — a later price-book edit never retroactively touches it.
    let priceBookId = null, priceBookItemId = null;
    if (price_book_item_id) {
      const [[bi]] = await pool.query(
        `SELECT id, price_book_id, product_id FROM customer_price_book_items WHERE id=?`,
        [price_book_item_id]
      );
      if (!bi || Number(bi.product_id) !== Number(product_id)) {
        throw Object.assign(new Error('Dòng bảng giá không hợp lệ hoặc không khớp sản phẩm'), { status: 400 });
      }
      if (price_book_id && Number(bi.price_book_id) !== Number(price_book_id)) {
        throw Object.assign(new Error('Dòng bảng giá không thuộc bảng giá đã chọn'), { status: 400 });
      }
      priceBookId = bi.price_book_id;
      priceBookItemId = bi.id;
    }

    return {
      product_id, product_name: prod.name, unit, qty, price,
      total_price: expected_stock_qty * price, spo_id,
      expected_conversion_qty, requires_actual_weight,
      expected_stock_qty, price_book_id: priceBookId, price_book_item_id: priceBookItemId,
    };
  }
}

module.exports = new InventoryPurchaseAgent();
