'use strict';
const pool = require('../config/db');
const SupplierPurchaseCatalogResolver = require('../services/SupplierPurchaseCatalogResolver');

function makeLabel(unitName, conversionQty) {
  const qty = Number(conversionQty);
  const formatted = Number.isInteger(qty) ? String(qty) : String(qty);
  return `${unitName} (${formatted}kg)`;
}

class SupplierPurchaseOptionAgent {
  async listUnits() {
    const [rows] = await pool.query(
      `SELECT id, code, name
       FROM units
       WHERE is_active = 1
       ORDER BY code ASC`
    );
    return rows;
  }

  // partnerId takes priority over supplierId; accepts either
  async listBySupplierProduct(partnerId, supplierId, productId) {
    let whereClause, whereVal;
    if (partnerId) {
      whereClause = 'spo.partner_id = ?';
      whereVal    = partnerId;
    } else {
      whereClause = 'spo.supplier_id = ?';
      whereVal    = supplierId;
    }
    const [rows] = await pool.query(
      `SELECT spo.id, spo.supplier_id, spo.partner_id, spo.product_id,
              spo.unit_id, u.code unit_code, u.name unit_name,
              spo.default_conversion_qty,
              spo.requires_actual_weight,
              spo.display_order, spo.is_active,
              spo.created_at, spo.updated_at
       FROM supplier_purchase_options spo
       JOIN units u ON u.id = spo.unit_id
       WHERE ${whereClause} AND spo.product_id = ? AND spo.is_active = 1
       ORDER BY spo.display_order ASC, spo.id ASC`,
      [whereVal, productId]
    );
    return rows.map(r => ({
      ...r,
      display_label: makeLabel(r.unit_name, r.default_conversion_qty)
    }));
  }

  async create(data) {
    const { partner_id, supplier_id, product_id, unit_id, default_conversion_qty,
            requires_actual_weight, display_order } = data;

    if (!partner_id && !supplier_id)
      throw Object.assign(new Error('Thiếu partner_id hoặc supplier_id'), { status: 400 });
    if (!product_id) throw Object.assign(new Error('Thiếu product_id'), { status: 400 });
    if (!unit_id)    throw Object.assign(new Error('Thiếu unit_id'),    { status: 400 });
    const conv = Number(default_conversion_qty || 0);
    if (conv <= 0) throw Object.assign(new Error('default_conversion_qty phải lớn hơn 0'), { status: 400 });

    const { resolvedPartnerId, resolvedSupplierId } = await this._resolvePartner(partner_id, supplier_id);

    const [products] = await pool.query(`SELECT id FROM products WHERE id = ? AND del_flg = 0`, [product_id]);
    if (!products.length) throw Object.assign(new Error('Không tìm thấy sản phẩm'), { status: 404 });
    const [units] = await pool.query(`SELECT id FROM units WHERE id = ? AND is_active = 1`, [unit_id]);
    if (!units.length) throw Object.assign(new Error('Không tìm thấy đơn vị hoặc đơn vị đã bị tắt'), { status: 404 });

    const [result] = await pool.query(
      `INSERT INTO supplier_purchase_options
         (supplier_id, partner_id, product_id, unit_id, default_conversion_qty,
          requires_actual_weight, display_order, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [resolvedSupplierId, resolvedPartnerId, product_id, unit_id, conv,
       requires_actual_weight ? 1 : 0, Number(display_order || 0)]
    );
    return { message: 'Đã tạo tùy chọn mua hàng nhà cung cấp', id: result.insertId };
  }

  async update(id, data) {
    const [existing] = await pool.query(`SELECT id FROM supplier_purchase_options WHERE id = ?`, [id]);
    if (!existing.length) throw Object.assign(new Error('Không tìm thấy tùy chọn'), { status: 404 });

    const { unit_id, default_conversion_qty, requires_actual_weight,
            display_order, is_active } = data;

    if (!unit_id) throw Object.assign(new Error('Thiếu unit_id'), { status: 400 });
    const conv = Number(default_conversion_qty || 0);
    if (conv <= 0) throw Object.assign(new Error('default_conversion_qty phải lớn hơn 0'), { status: 400 });

    const [units] = await pool.query(`SELECT id FROM units WHERE id = ? AND is_active = 1`, [unit_id]);
    if (!units.length) throw Object.assign(new Error('Không tìm thấy đơn vị hoặc đơn vị đã bị tắt'), { status: 404 });

    const resolvedActive = is_active !== undefined ? (is_active ? 1 : 0) : null;
    await pool.query(
      `UPDATE supplier_purchase_options
       SET unit_id = ?, default_conversion_qty = ?,
           requires_actual_weight = ?,
           display_order = ?, is_active = COALESCE(?, is_active)
       WHERE id = ?`,
      [unit_id, conv, requires_actual_weight ? 1 : 0, Number(display_order || 0), resolvedActive, id]
    );
    return { message: 'Đã cập nhật tùy chọn mua hàng nhà cung cấp' };
  }

  async disable(id) {
    const [existing] = await pool.query(`SELECT id FROM supplier_purchase_options WHERE id = ?`, [id]);
    if (!existing.length) throw Object.assign(new Error('Không tìm thấy tùy chọn'), { status: 404 });
    await pool.query(`UPDATE supplier_purchase_options SET is_active = 0 WHERE id = ?`, [id]);
    return { message: 'Đã tắt tùy chọn mua hàng nhà cung cấp' };
  }

  // ── Bulk configuration ("Cấu hình quy cách nhập hàng loạt") ────────────────
  //
  // Product source: reuses SupplierPurchaseCatalogResolver.resolveCatalog() —
  // the same, already-shipped/approved "Supplier Product Catalog" resolution
  // (Price Matrix "Bảng giá riêng NCC" book, else product_supplier_links
  // fallback) already used by the working GET /supplier-catalog endpoint and
  // the Purchase Order "+ Thêm sản phẩm" flow. Deliberately called with
  // today's date + SOLAR (matching that endpoint's own default) — this screen
  // configures UNITS, not prices, so it never needs a caller-supplied
  // purchase date/calendar type and is not exposed to the LUNAR
  // resolveEffectiveMeta() validation path that caused an earlier, unrelated
  // defect in the bulk price-book-load feature. If the supplier has no
  // catalog yet (catalog_source: 'NONE'), this returns an empty product list
  // rather than ever falling back to "every product in the category" —
  // callers must be guided to configure the supplier's catalog first.
  async bulkList(partnerId, categoryId) {
    if (!partnerId) throw Object.assign(new Error('Thiếu nhà cung cấp'), { status: 400 });
    if (!categoryId) throw Object.assign(new Error('Thiếu nhóm hàng'), { status: 400 });
    const { resolvedPartnerId, resolvedSupplierId } = await this._resolvePartner(partnerId, null);

    const todayIso = new Date().toISOString().slice(0, 10);
    const catalog = await SupplierPurchaseCatalogResolver.resolveCatalog(
      resolvedPartnerId, resolvedSupplierId, todayIso, 'SOLAR', Number(categoryId)
    );
    if (!catalog.items.length) {
      return { catalog_source: catalog.catalog_source, products: [] };
    }

    const productIds = catalog.items.map(i => i.product_id);
    const [spoRows] = await pool.query(
      `SELECT spo.id, spo.product_id, spo.unit_id, u.code unit_code, u.name unit_name,
              spo.default_conversion_qty, spo.requires_actual_weight, spo.display_order, spo.is_active
       FROM supplier_purchase_options spo
       JOIN units u ON u.id = spo.unit_id
       WHERE spo.partner_id = ? AND spo.product_id IN (?) AND spo.is_active = 1
       ORDER BY spo.display_order ASC, spo.id ASC`,
      [resolvedPartnerId, productIds]
    );
    const spoByProduct = {};
    for (const r of spoRows) {
      (spoByProduct[r.product_id] ||= []).push({
        ...r,
        default_conversion_qty: Number(r.default_conversion_qty),
        display_label: makeLabel(r.unit_name, r.default_conversion_qty),
      });
    }

    const products = catalog.items.map(item => {
      const spos = spoByProduct[item.product_id] || [];
      return {
        product_id: item.product_id,
        product_name: item.product_name,
        product_code: item.product_code,
        spo_count: spos.length,
        // Only exposed for the unambiguous 0-or-1-option case — the bulk row
        // is directly editable then. 2+ options are never surfaced for inline
        // bulk editing (see file header / story's "Có {n} đơn vị" +
        // "Xem/chỉnh nhiều đơn vị" requirement) so the fast path can never
        // silently overwrite one of several coexisting units.
        spo: spos.length === 1 ? spos[0] : null,
      };
    });
    return { catalog_source: catalog.catalog_source, products };
  }

  // Batch validate-then-write, single transaction, all-or-nothing — never one
  // request per row. Every product_id/unit_id is re-validated server-side
  // against the database (never trusted from the frontend): the product must
  // be active/not-deleted, belong to the selected category, and be part of
  // this supplier's own resolved catalog (same set bulkList() would return) —
  // a manipulated request naming a product from an unrelated supplier or
  // category is rejected exactly like an invalid conversion value. Duplicate
  // rule: matched by the exact (partner_id, product_id, unit_id) triple — a
  // match is updated in place; no match is inserted new. A product with other
  // existing units for DIFFERENT unit_ids is never touched, matching "the
  // bulk row edits only the explicitly selected unit; other units remain
  // unchanged" — no "default option" concept needed or invented.
  async bulkSave(partnerId, categoryId, rows, userId) {
    if (!partnerId) throw Object.assign(new Error('Thiếu nhà cung cấp'), { status: 400 });
    if (!categoryId) throw Object.assign(new Error('Thiếu nhóm hàng'), { status: 400 });
    if (!Array.isArray(rows) || !rows.length) throw Object.assign(new Error('Không có dòng nào để lưu'), { status: 400 });

    const { resolvedPartnerId, resolvedSupplierId } = await this._resolvePartner(partnerId, null);
    const catCategoryId = Number(categoryId);

    // Re-derive this supplier's own catalog product-id set fresh, server-side —
    // never trust the frontend's claim that a product belongs to this supplier.
    const todayIso = new Date().toISOString().slice(0, 10);
    const catalog = await SupplierPurchaseCatalogResolver.resolveCatalog(
      resolvedPartnerId, null, todayIso, 'SOLAR', catCategoryId
    );
    const catalogProductIds = new Set(catalog.items.map(i => i.product_id));

    const productIds = [...new Set(rows.map(r => Number(r.product_id)).filter(Boolean))];
    const unitIds = [...new Set(rows.map(r => Number(r.unit_id)).filter(Boolean))];
    const [productRows] = productIds.length
      ? await pool.query(`SELECT id, name, category_id, is_active, del_flg FROM products WHERE id IN (?)`, [productIds])
      : [[]];
    const productById = new Map(productRows.map(p => [Number(p.id), p]));
    const [unitRows] = unitIds.length
      ? await pool.query(`SELECT id, is_active FROM units WHERE id IN (?)`, [unitIds])
      : [[]];
    const activeUnitIds = new Set(unitRows.filter(u => Number(u.is_active) === 1).map(u => Number(u.id)));

    // ── Validate every row up front — a single invalid row blocks the whole batch ──
    const invalid = [];
    for (const r of rows) {
      const pid = Number(r.product_id);
      const uid = Number(r.unit_id);
      const conv = Number(r.default_conversion_qty);
      const order = Number(r.display_order ?? 0);
      const label = r.product_name || `ID ${pid}`;
      const p = productById.get(pid);
      if (!pid) { invalid.push({ product_id: pid, product_name: label, reason: 'Thiếu mã sản phẩm' }); continue; }
      if (!uid) { invalid.push({ product_id: pid, product_name: label, reason: 'Thiếu đơn vị' }); continue; }
      if (!(conv > 0)) { invalid.push({ product_id: pid, product_name: label, reason: 'Kg quy đổi phải lớn hơn 0' }); continue; }
      if (!(order >= 0)) { invalid.push({ product_id: pid, product_name: label, reason: 'Thứ tự phải >= 0' }); continue; }
      if (!p || Number(p.del_flg) === 1 || Number(p.is_active) !== 1) { invalid.push({ product_id: pid, product_name: label, reason: 'Sản phẩm không tồn tại hoặc đã ngừng hoạt động' }); continue; }
      if (Number(p.category_id) !== catCategoryId) { invalid.push({ product_id: pid, product_name: label, reason: 'Sản phẩm không thuộc nhóm hàng đã chọn' }); continue; }
      if (!catalogProductIds.has(pid)) { invalid.push({ product_id: pid, product_name: label, reason: 'Sản phẩm không thuộc danh mục của nhà cung cấp này' }); continue; }
      if (!activeUnitIds.has(uid)) { invalid.push({ product_id: pid, product_name: label, reason: 'Đơn vị không hợp lệ hoặc đã bị tắt' }); continue; }
    }
    if (invalid.length) {
      throw Object.assign(
        new Error(`Có ${invalid.length} mặt hàng không hợp lệ, chưa lưu dòng nào: ${invalid.map(x => `${x.product_name} (${x.reason})`).join('; ')}`),
        { status: 400, statusCode: 400, code: 'BULK_PURCHASE_OPTION_INVALID_ROWS', invalid }
      );
    }

    // ── All valid — batch load existing options for exact-triple dedup, then write in one transaction ──
    const [existingRows] = await pool.query(
      `SELECT id, product_id, unit_id, default_conversion_qty, requires_actual_weight, display_order
       FROM supplier_purchase_options
       WHERE partner_id = ? AND product_id IN (?) AND is_active = 1`,
      [resolvedPartnerId, productIds]
    );
    const existingByKey = new Map(existingRows.map(r => [`${r.product_id}:${r.unit_id}`, r]));

    let savedCount = 0, skippedCount = 0;
    const savedProductIds = [];
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const r of rows) {
        const pid = Number(r.product_id);
        const uid = Number(r.unit_id);
        const conv = Number(r.default_conversion_qty);
        const reqWeight = r.requires_actual_weight ? 1 : 0;
        const order = Number(r.display_order ?? 0);
        const existing = existingByKey.get(`${pid}:${uid}`);
        if (existing &&
            Number(existing.default_conversion_qty) === conv &&
            Number(existing.requires_actual_weight) === reqWeight &&
            Number(existing.display_order) === order) {
          skippedCount++;
          continue;
        }
        if (existing) {
          await conn.query(
            `UPDATE supplier_purchase_options SET default_conversion_qty=?, requires_actual_weight=?, display_order=? WHERE id=?`,
            [conv, reqWeight, order, existing.id]
          );
        } else {
          await conn.query(
            `INSERT INTO supplier_purchase_options
               (supplier_id, partner_id, product_id, unit_id, default_conversion_qty, requires_actual_weight, display_order, is_active)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
            [resolvedSupplierId, resolvedPartnerId, pid, uid, conv, reqWeight, order]
          );
        }
        savedCount++;
        savedProductIds.push(pid);
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }

    return {
      message: `Đã lưu ${savedCount} quy cách nhập. Bỏ qua ${skippedCount} mặt hàng không thay đổi.`,
      saved_count: savedCount,
      skipped_count: skippedCount,
      saved_product_ids: savedProductIds,
    };
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
}

module.exports = new SupplierPurchaseOptionAgent();
