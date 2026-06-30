'use strict';
const pool = require('../config/db');

// PurchasePriceResolver — S4-003A/B
//
// SOLE OWNER of all SQL reads against product_supplier_links.
// No other file may query product_supplier_links directly.
//
// Resolution chain (supplier-specific + explicit-supplier context):
//   Step 1 — TODO: supplier_agreements (future contract-level table)
//             Supplier Agreement with date-range and contracted unit price.
//             → exact negotiated price for an active contract period
//
//   Step 2 — product_supplier_links (Negotiated Link Price)
//             supplier_id + product_id + is_active = 1
//             → standing negotiated price per supplier-product pair
//
//   Step 3 — TODO: latest purchase_order_items.purchase_price
//             Most recently confirmed PO for this supplier+product.
//             → informal last-agreed price reference
//
//   Step 4 — products.default_purchase_price (Default Purchase Price)
//             Product-level fallback, supplier-agnostic.
//             Used only by resolveDefaultSupplierRule().
//
//   Step 5 — null (manual entry required in UI)
//
// NOTE on data that must NOT be used as general purchase prices:
//   - suppliers.male_price / female_price / fragment_price → cattle lot settlement only
//   - supplier_purchase_options                            → unit conversion metadata, no price
//   - purchase_order_items.purchase_price                  → PO snapshot, not a lookup source

function _n(value) {
  const v = Number(value || 0);
  return Number.isFinite(v) ? v : 0;
}

class PurchasePriceResolver {
  /**
   * Resolve purchase price for an explicit supplier + product pair.
   * Resolution: product_supplier_links → null.
   *
   * @param {number} supplierId
   * @param {number} productId
   * @param {string} [date]  ISO 'YYYY-MM-DD' — reserved for future Supplier Agreement date-range lookup
   * @returns {Promise<number|null>}
   */
  async resolveSupplierPrice(supplierId, productId, date) {
    // TODO Step 1: query supplier_agreements for supplierId + productId + date
    //              (table not yet created; see resolution chain above)

    // Step 2: product_supplier_links — negotiated link price
    const [[link]] = await pool.query(
      `SELECT purchase_price FROM product_supplier_links
       WHERE supplier_id = ? AND product_id = ? AND is_active = 1
       LIMIT 1`,
      [supplierId, productId]
    );
    if (link && _n(link.purchase_price) > 0) return _n(link.purchase_price);

    // TODO Step 3: query latest confirmed purchase_order_items price for this supplier+product

    return null;
  }

  /**
   * Batch resolve negotiated prices for one supplier across multiple products.
   * Resolution: product_supplier_links → null (per product).
   * Used by GET /api/supplier-purchase-price.
   *
   * @param {number} supplierId
   * @param {number[]} productIds
   * @returns {Promise<Record<number, number|null>>}  productId → price or null
   */
  async resolveForSupplierItems(supplierId, productIds) {
    if (!productIds.length) return {};
    const [rows] = await pool.query(
      `SELECT product_id, purchase_price FROM product_supplier_links
       WHERE supplier_id = ? AND product_id IN (?) AND is_active = 1`,
      [supplierId, productIds]
    );
    const map = {};
    for (const row of rows) {
      const price = _n(row.purchase_price);
      if (price > 0) map[row.product_id] = price;
    }
    for (const id of productIds) {
      if (!(id in map)) map[id] = null;
    }
    return map;
  }

  /**
   * Resolve the default supplier rule for a product — used by AI Supplier Ordering.
   * Identifies the default supplier, negotiated price, and ordering constraints.
   *
   * Resolution for price:
   *   Step 2 product_supplier_links.purchase_price (is_default = 1)
   *   → Step 4 products.default_purchase_price
   *   → 0
   *
   * @param {number} productId
   * @returns {Promise<{
   *   supplier_id: number|null,
   *   supplier_name: string|null,
   *   purchase_price: number,
   *   min_order_qty: number,
   *   order_multiple_qty: number,
   *   lead_time_days: number
   * }>}
   */
  /**
   * Upsert a negotiated price in product_supplier_links.
   * Used when a buyer adds an ad-hoc product to a PO and opts to save it to the supplier matrix.
   *
   * @param {number} supplierId
   * @param {number} productId
   * @param {number} purchasePrice
   * @returns {Promise<{ action: 'created'|'updated', supplier_id, product_id, purchase_price }>}
   */
  async upsertLink(supplierId, productId, purchasePrice) {
    if (!supplierId || !productId)
      throw Object.assign(new Error('Thiếu supplier_id hoặc product_id'), { status: 400 });
    const price = _n(purchasePrice);
    if (price <= 0)
      throw Object.assign(new Error('Giá nhập phải lớn hơn 0'), { status: 400 });

    const [[existing]] = await pool.query(
      `SELECT id FROM product_supplier_links WHERE supplier_id = ? AND product_id = ? LIMIT 1`,
      [supplierId, productId]
    );
    if (existing) {
      await pool.query(
        `UPDATE product_supplier_links SET purchase_price = ?, is_active = 1, updated_at = NOW() WHERE id = ?`,
        [price, existing.id]
      );
      return { action: 'updated', supplier_id: supplierId, product_id: productId, purchase_price: price };
    }
    const [r] = await pool.query(
      `INSERT INTO product_supplier_links (supplier_id, product_id, purchase_price, is_active, is_default) VALUES (?, ?, ?, 1, 1)`,
      [supplierId, productId, price]
    );
    return { action: 'created', id: r.insertId, supplier_id: supplierId, product_id: productId, purchase_price: price };
  }

  async resolveDefaultSupplierRule(productId) {
    const [[row]] = await pool.query(
      `SELECT
         ps.supplier_id      linked_supplier_id,
         ps.purchase_price   linked_purchase_price,
         ps.min_order_qty,
         ps.order_multiple_qty,
         ps.lead_time_days,
         s1.name             linked_supplier_name,
         p.default_supplier_id,
         p.default_purchase_price,
         s2.name             default_supplier_name
       FROM products p
       LEFT JOIN product_supplier_links ps
         ON ps.product_id = p.id AND ps.is_active = 1 AND ps.is_default = 1
       LEFT JOIN suppliers s1
         ON s1.id = ps.supplier_id AND s1.del_flg = 0 AND s1.is_active = 1
       LEFT JOIN suppliers s2
         ON s2.id = p.default_supplier_id AND s2.del_flg = 0 AND s2.is_active = 1
       WHERE p.id = ?
       LIMIT 1`,
      [productId]
    );

    if (!row) {
      return { supplier_id: null, supplier_name: null, purchase_price: 0, min_order_qty: 0, order_multiple_qty: 0, lead_time_days: 0 };
    }

    return {
      supplier_id:        row.linked_supplier_id || row.default_supplier_id || null,
      supplier_name:      row.linked_supplier_name || row.default_supplier_name || null,
      purchase_price:     _n(row.linked_purchase_price || row.default_purchase_price),
      min_order_qty:      _n(row.min_order_qty),
      order_multiple_qty: _n(row.order_multiple_qty),
      lead_time_days:     _n(row.lead_time_days),
    };
  }
}

module.exports = new PurchasePriceResolver();
