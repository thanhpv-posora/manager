'use strict';
const pool = require('../config/db');

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
