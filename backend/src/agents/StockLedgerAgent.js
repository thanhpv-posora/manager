'use strict';
const pool = require('../config/db');

// StockLedgerAgent — S5.2 / S5.2-C
//
// READ-ONLY. This agent never writes to stock_transactions or products.
// InventoryMovementService remains the sole writer of stock (see its header
// comment). This agent only SELECTs from stock_transactions and joins
// reference documents/product/user names for display — it never aggregates
// rows into fewer rows (every stock_transactions row stays its own ledger
// row) and never recalculates or rewrites products.stock_quantity.
//
// S5.2-C: affect_stock is a write-time column on stock_transactions itself
// (InventoryMovementService sets it explicitly on every INSERT — see that
// file's header comment). CEO review rejected deriving it here at read time
// from current product mode/flags/note text: an audit ledger must reflect
// the business decision made at movement creation time, not whatever the
// product looks like today. This agent reads st.affect_stock verbatim and
// never re-derives it.

const MOVEMENT_TYPES = ['IN', 'OUT', 'ADJUSTMENT_INCREASE', 'ADJUSTMENT_DECREASE'];
const REFERENCE_TYPES = ['LOT', 'SALE', 'MANUAL', 'RECEIVE_VOUCHER', 'OPENING_BALANCE'];
const STOCK_EFFECTS = ['AFFECTING', 'NOT_AFFECTING', 'ALL'];

class StockLedgerAgent {
  constructor() {
    this.version = '2.0.0';
    this.responsibility = 'S5.2 — read-only Stock Ledger over stock_transactions. No writes, no stock recalculation. affect_stock is read verbatim from the row, never re-derived.';
  }

  async list(query = {}) {
    const { product_id, type, reference_type, date_from, date_to, page = 1, limit = 50 } = query;
    const stockEffect = STOCK_EFFECTS.includes(query.stock_effect) ? query.stock_effect : 'AFFECTING';

    const pageNum = Math.max(1, Number(page) || 1);
    // Match InventoryPurchaseAgent.list()'s pagination convention: Number(limit)
    // taken as-is (no falsy-zero substitution), so an explicit limit=0 is honored
    // (LIMIT 0) instead of silently becoming 50. The upper-bound cap is additive
    // safety, not part of that convention, so it's kept.
    const limitNum = Math.min(500, Number(limit));
    const offset = (pageNum - 1) * limitNum;

    // product_id is safe to push into the ledger CTE's source rows: restricting
    // to one product's full history doesn't change that product's own running
    // balance (no other product's rows ever contribute to it).
    const cteConds = [];
    const cteParams = [];
    if (product_id) { cteConds.push('st.product_id = ?'); cteParams.push(product_id); }
    const cteWhereSql = cteConds.length ? `WHERE ${cteConds.join(' AND ')}` : '';

    // type / reference_type / date / stock_effect filters must NOT be pushed
    // into the base CTE — doing so would remove rows the window function
    // needs to sum in order to report a correct cumulative balance_after for
    // the rows that remain visible. They are applied only to the ledger's
    // *output*, after the running balance has already been computed over the
    // product's full (unfiltered) history.
    const outerConds = [];
    const outerParams = [];
    if (type && MOVEMENT_TYPES.includes(type)) { outerConds.push('type = ?'); outerParams.push(type); }
    if (reference_type && REFERENCE_TYPES.includes(reference_type)) { outerConds.push('reference_type = ?'); outerParams.push(reference_type); }
    if (date_from) { outerConds.push('transaction_date >= ?'); outerParams.push(date_from); }
    if (date_to) { outerConds.push('transaction_date <= ?'); outerParams.push(date_to); }
    if (stockEffect === 'AFFECTING') outerConds.push('affect_stock = 1');
    else if (stockEffect === 'NOT_AFFECTING') outerConds.push('affect_stock = 0');
    const outerWhereSql = outerConds.length ? `WHERE ${outerConds.join(' AND ')}` : '';

    // Count applies every filter directly against the base table — affect_stock
    // is a real column now, so no join/derivation is needed just to count rows.
    const countConds = [];
    const countParams = [];
    if (product_id) { countConds.push('product_id = ?'); countParams.push(product_id); }
    if (type && MOVEMENT_TYPES.includes(type)) { countConds.push('type = ?'); countParams.push(type); }
    if (reference_type && REFERENCE_TYPES.includes(reference_type)) { countConds.push('reference_type = ?'); countParams.push(reference_type); }
    if (date_from) { countConds.push('transaction_date >= ?'); countParams.push(date_from); }
    if (date_to) { countConds.push('transaction_date <= ?'); countParams.push(date_to); }
    if (stockEffect === 'AFFECTING') countConds.push('affect_stock = 1');
    else if (stockEffect === 'NOT_AFFECTING') countConds.push('affect_stock = 0');
    const countWhereSql = countConds.length ? `WHERE ${countConds.join(' AND ')}` : '';

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) total FROM stock_transactions ${countWhereSql}`,
      countParams
    );

    const [rows] = await pool.query(
      `WITH base AS (
         SELECT
           st.id,
           st.product_id,
           p.name AS product_name,
           p.product_code AS product_code,
           st.transaction_date,
           st.type,
           st.quantity,
           st.reference_type,
           st.reference_id,
           CASE st.reference_type
             WHEN 'SALE' THEN o.order_code
             WHEN 'RECEIVE_VOUCHER' THEN ir.receive_code
             WHEN 'LOT' THEN pl.lot_code
             ELSE NULL
           END AS reference_no,
           st.note,
           st.created_by,
           u.full_name AS created_by_name,
           st.created_at,
           st.affect_stock
         FROM stock_transactions st
         LEFT JOIN products p ON p.id = st.product_id
         LEFT JOIN users u ON u.id = st.created_by
         LEFT JOIN orders o ON st.reference_type = 'SALE' AND o.id = st.reference_id
         LEFT JOIN inventory_receives ir ON st.reference_type = 'RECEIVE_VOUCHER' AND ir.id = st.reference_id
         LEFT JOIN purchase_lots pl ON st.reference_type = 'LOT' AND pl.id = st.reference_id
         ${cteWhereSql}
       ),
       ledger AS (
         SELECT
           base.*,
           SUM(
             CASE
               WHEN affect_stock = 0 THEN 0
               WHEN type IN ('IN', 'ADJUSTMENT_INCREASE') THEN quantity
               WHEN type IN ('OUT', 'ADJUSTMENT_DECREASE') THEN -quantity
               ELSE 0
             END
           ) OVER (
             PARTITION BY product_id
             ORDER BY transaction_date, id
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) AS running_balance
         FROM base
       )
       SELECT
         id, product_id, product_name, product_code, transaction_date, type, quantity,
         reference_type, reference_id, reference_no, note, created_by, created_by_name, created_at,
         affect_stock,
         CASE WHEN affect_stock = 1 THEN running_balance ELSE NULL END AS balance_after
       FROM ledger
       ${outerWhereSql}
       ORDER BY transaction_date DESC, id DESC
       LIMIT ? OFFSET ?`,
      [...cteParams, ...outerParams, limitNum, offset]
    );

    return { items: rows, total: Number(total), page: pageNum, limit: limitNum, stock_effect: stockEffect };
  }
}

module.exports = new StockLedgerAgent();
