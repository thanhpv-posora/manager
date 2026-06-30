'use strict';
const pool = require('../config/db');
const PriceBookService = require('./PriceBookService');

// SupplierPurchaseCatalogResolver — S4-006
//
// Priority chain for supplier purchase catalog:
//   1. customer_price_books / customer_price_book_items (partner_id = customers.id, partner_type=1)
//      — this is where the CEO configures products via the Price Matrix UI ("Bảng giá riêng NCC")
//   2. product_supplier_links (legacy fallback for suppliers not yet in Price Matrix)
//
// Effective date normalization reuses PriceBookService.resolveEffectiveMeta()
// (same SOLAR/LUNAR calendar logic as customer price matrix).
//
// NOTE: PurchasePriceResolver remains SOLE OWNER of product_supplier_links reads
// for single-product price lookups. This resolver owns the catalog (multi-product)
// read path only — a different access pattern that returns SPOs alongside prices.

class SupplierPurchaseCatalogResolver {
  /**
   * Resolve the full purchase catalog for a supplier on a given effective date.
   *
   * @param {number|null} partnerId     customers.id of the supplier partner (partner_type & 1 = 1)
   * @param {number|null} supplierId    suppliers.id (legacy; optional when partner has a price book)
   * @param {string} purchaseDate       ISO 'YYYY-MM-DD'
   * @param {string} calendarType       'SOLAR' | 'LUNAR'
   * @returns {Promise<{supplier_id, partner_id, catalog_source, effective_from, effective_calendar_type, items[]}>}
   */
  async resolveCatalog(partnerId, supplierId, purchaseDate, calendarType) {
    const { resolvedSupplierId, resolvedPartnerId } = await this._resolveIds(partnerId, supplierId);

    const meta = PriceBookService.resolveEffectiveMeta({
      effective_from: purchaseDate || new Date().toISOString().slice(0, 10),
      effective_calendar_type: calendarType || 'SOLAR',
    });

    // 1. PRIMARY — Price Matrix book (customer_price_books keyed on partner_id)
    let productRows = [];
    let catalogSource = 'PRICE_BOOK';

    if (resolvedPartnerId) {
      productRows = await this._loadFromPriceBook(resolvedPartnerId, meta);
    }

    // 2. FALLBACK — product_supplier_links (legacy; used when no price book configured)
    if (!productRows.length) {
      if (!resolvedSupplierId) {
        return { supplier_id: null, partner_id: resolvedPartnerId, ...meta, catalog_source: 'NONE', items: [] };
      }
      productRows = await this._loadFromSupplierLinks(resolvedSupplierId);
      catalogSource = 'SUPPLIER_LINKS';
    }

    if (!productRows.length) {
      return { supplier_id: resolvedSupplierId, partner_id: resolvedPartnerId, ...meta, catalog_source: catalogSource, items: [] };
    }

    // 3. Batch-load SPOs for the resolved product set
    const productIds = productRows.map(r => r.product_id);
    const spoFilter = resolvedPartnerId ? 'spo.partner_id = ?' : 'spo.supplier_id = ?';
    const spoVal    = resolvedPartnerId || resolvedSupplierId;
    const [spoRows] = await pool.query(
      `SELECT spo.id, spo.product_id,
              spo.default_conversion_qty conversion_qty,
              spo.requires_actual_weight, spo.display_order,
              u.code unit_code, u.name unit_name
       FROM supplier_purchase_options spo
       JOIN units u ON u.id = spo.unit_id
       WHERE ${spoFilter} AND spo.product_id IN (?) AND spo.is_active = 1
       ORDER BY spo.display_order ASC, spo.id ASC`,
      [spoVal, productIds]
    );

    // 4. Group SPOs by product_id
    const sposByProduct = {};
    for (const spo of spoRows) {
      if (!sposByProduct[spo.product_id]) sposByProduct[spo.product_id] = [];
      sposByProduct[spo.product_id].push({
        id: spo.id,
        unit_code: spo.unit_code,
        unit_name: spo.unit_name,
        conversion_qty: Number(spo.conversion_qty),
        requires_actual_weight: spo.requires_actual_weight,
        label: `${spo.unit_name} (${Number(spo.conversion_qty)}kg)`,
      });
    }

    // 5. Assemble catalog items (default SPO = first by display_order)
    const items = productRows.map(r => {
      const spos       = sposByProduct[r.product_id] || [];
      const defaultSpo = spos[0] || null;
      return {
        product_id:                     r.product_id,
        product_name:                   r.product_name,
        product_code:                   r.product_code,
        category_name:                  r.category_name || null,
        inventory_mode:                 r.inventory_mode,
        purchase_price:                 Number(r.purchase_price || 0),
        spos,
        default_spo_id:                 defaultSpo?.id              || null,
        default_spo_label:              defaultSpo?.label           || null,
        default_conversion_qty:         defaultSpo?.conversion_qty  || null,
        default_requires_actual_weight: defaultSpo?.requires_actual_weight || 0,
        default_unit_code:              defaultSpo?.unit_code || r.default_unit || 'kg',
      };
    });

    return { supplier_id: resolvedSupplierId, partner_id: resolvedPartnerId, ...meta, catalog_source: catalogSource, items };
  }

  // ── Private ──────────────────────────────────────────────────────────────

  // Query customer_price_books + customer_price_book_items using partner's customer_id.
  // Returns raw product rows (same shape as _loadFromSupplierLinks) or [].
  async _loadFromPriceBook(partnerId, meta) {
    let bookRows;
    if (meta.effective_calendar_type === 'LUNAR') {
      [bookRows] = await pool.query(
        `SELECT id FROM customer_price_books
         WHERE customer_id = ? AND COALESCE(status, 'ACTIVE') = 'ACTIVE'
           AND COALESCE(effective_calendar_type, 'SOLAR') = 'LUNAR'
           AND COALESCE(effective_lunar_sort, 0) <= ?
         ORDER BY COALESCE(effective_lunar_sort, 0) DESC, id DESC
         LIMIT 1`,
        [partnerId, meta.effective_lunar_sort]
      );
    } else {
      [bookRows] = await pool.query(
        `SELECT id FROM customer_price_books
         WHERE customer_id = ? AND COALESCE(status, 'ACTIVE') = 'ACTIVE'
           AND COALESCE(effective_calendar_type, 'SOLAR') = 'SOLAR'
           AND effective_from <= ?
         ORDER BY effective_from DESC, id DESC
         LIMIT 1`,
        [partnerId, meta.effective_from]
      );
    }

    if (!bookRows.length) return [];

    const [rows] = await pool.query(
      `SELECT bi.product_id, bi.sale_price AS purchase_price,
              p.name product_name, p.product_code,
              p.inventory_mode, p.unit default_unit,
              pc.name category_name,
              COALESCE(pc.sort_order, 9999) category_sort_order
       FROM customer_price_book_items bi
       JOIN products p ON p.id = bi.product_id AND p.del_flg = 0 AND p.is_active = 1
       LEFT JOIN product_categories pc ON pc.id = p.category_id
       WHERE bi.price_book_id = ?
       ORDER BY COALESCE(pc.sort_order, 9999), p.name`,
      [bookRows[0].id]
    );
    return rows;
  }

  // Legacy fallback: products linked via product_supplier_links.
  async _loadFromSupplierLinks(supplierId) {
    const [rows] = await pool.query(
      `SELECT psl.product_id, psl.purchase_price,
              p.name product_name, p.product_code,
              p.inventory_mode, p.unit default_unit,
              pc.name category_name,
              COALESCE(pc.sort_order, 9999) category_sort_order
       FROM product_supplier_links psl
       JOIN products p
         ON p.id = psl.product_id AND p.del_flg = 0 AND p.is_active = 1
         AND (p.inventory_mode = 'TRACK_STOCK' OR p.inventory_mode = 'STOCK')
       LEFT JOIN product_categories pc ON pc.id = p.category_id
       WHERE psl.supplier_id = ? AND psl.is_active = 1
       ORDER BY COALESCE(pc.sort_order, 9999), p.name`,
      [supplierId]
    );
    return rows;
  }

  // Resolve partner_id / supplier_id. Does NOT throw if supplier mapping is missing —
  // that only blocks the legacy fallback path; the price book path uses partner_id directly.
  async _resolveIds(partnerId, supplierId) {
    let resolvedPartnerId  = partnerId  ? Number(partnerId)  : null;
    let resolvedSupplierId = supplierId ? Number(supplierId) : null;

    if (resolvedPartnerId && !resolvedSupplierId) {
      const [[partner]] = await pool.query(
        `SELECT id FROM customers WHERE id = ? AND (partner_type & 1) = 1 AND del_flg = 0`,
        [resolvedPartnerId]
      );
      if (!partner) throw Object.assign(new Error('Không tìm thấy nhà cung cấp (partner)'), { status: 404 });
      const [[map]] = await pool.query(
        `SELECT supplier_id FROM supplier_partner_map WHERE partner_id = ?`, [resolvedPartnerId]
      );
      if (map) resolvedSupplierId = map.supplier_id;
      // resolvedSupplierId may remain null here — price book path handles it
    }

    if (!resolvedPartnerId && !resolvedSupplierId) {
      throw Object.assign(new Error('Cần cung cấp partner_id hoặc supplier_id.'), { status: 400 });
    }

    return { resolvedSupplierId, resolvedPartnerId };
  }
}

module.exports = new SupplierPurchaseCatalogResolver();
