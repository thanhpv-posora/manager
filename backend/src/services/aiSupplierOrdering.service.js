const db = require('../config/db');
const aiInventoryPredictionService = require('./aiInventoryPrediction.service');
const PurchasePriceResolver = require('./PurchasePriceResolver');
const SupplierPurchaseCatalogResolver = require('./SupplierPurchaseCatalogResolver');
const InventoryPurchaseAgent = require('../agents/InventoryPurchaseAgent');
const { formatQty } = require('../utils/quantityFormat');

function n(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function roundQty(qty, multiple = 0) {
  const value = n(qty);
  const m = n(multiple);
  if (value <= 0) return 0;
  if (m > 0) return Math.ceil(value / m) * m;
  return Math.ceil(value * 100) / 100;
}

function formatMoney(value) {
  return n(value).toLocaleString('vi-VN', { maximumFractionDigits: 0 });
}

async function buildSupplierOrderDraft(options = {}) {
  const lookbackDays = Number(options.lookback_days || 14);
  const forecastDays = Number(options.forecast_days || 7);
  const safetyDays = Number(options.safety_days || 3);
  const createdBy = options.created_by || null;

  const suggestion = await aiInventoryPredictionService.suggestSupplierOrders({
    lookback_days: lookbackDays,
    forecast_days: forecastDays,
    safety_days: safetyDays
  });

  const items = [];
  for (const row of suggestion.data || []) {
    const rule = await PurchasePriceResolver.resolveDefaultSupplierRule(row.product_id);
    const rawQty = n(row.suggested_order_qty);
    const minQty = rule.min_order_qty > 0 ? rule.min_order_qty : 0;
    const qty = roundQty(Math.max(rawQty, minQty), rule.order_multiple_qty);
    const price = rule.purchase_price;
    items.push({
      product_id: row.product_id,
      product_name: row.product_name,
      unit: row.unit || 'kg',
      supplier_id: rule.supplier_id,
      supplier_name: rule.supplier_name,
      quantity: qty,
      raw_suggested_qty: rawQty,
      purchase_price: price,
      total_price: qty * price,
      stock_quantity: row.stock_quantity,
      low_stock_threshold: row.low_stock_threshold,
      sold_qty: row.sold_qty,
      avg_daily_sale: row.avg_daily_sale,
      target_days: row.target_days,
      target_qty: row.target_qty,
      projected_stock: row.projected_stock,
      days_until_out: row.days_until_out,
      risk: row.risk,
      min_order_qty: rule.min_order_qty,
      order_multiple_qty: rule.order_multiple_qty,
      lead_time_days: rule.lead_time_days,
      blocking_reason: rule.supplier_id ? null : 'Chưa gán nhà cung cấp cho sản phẩm'
    });
  }

  const supplierGroups = [];
  const groupMap = new Map();
  for (const item of items) {
    const key = item.supplier_id ? String(item.supplier_id) : 'UNMAPPED';
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        supplier_id: item.supplier_id,
        supplier_name: item.supplier_name || 'Chưa gán nhà cung cấp',
        items: [],
        total_amount: 0,
        can_confirm: Boolean(item.supplier_id)
      });
    }
    const group = groupMap.get(key);
    group.items.push(item);
    group.total_amount += item.total_price;
    if (!item.supplier_id) group.can_confirm = false;
  }
  for (const group of groupMap.values()) {
    group.total_amount = Number(group.total_amount.toFixed(2));
    supplierGroups.push(group);
  }

  const canConfirm = items.length > 0 && items.every(item => item.supplier_id);
  const totalAmount = items.reduce((sum, item) => sum + item.total_price, 0);

  return {
    intent: 'AI_SUPPLIER_ORDER_DRAFT',
    params: { lookback_days: lookbackDays, forecast_days: forecastDays, safety_days: safetyDays },
    created_by: createdBy,
    order_date: new Date().toISOString().slice(0, 10),
    items,
    supplier_groups: supplierGroups,
    total_amount: Number(totalAmount.toFixed(2)),
    can_confirm: canConfirm,
    requires_confirm: canConfirm,
    confirm_message: canConfirm ? 'Xác nhận tạo phiếu mua hàng?' : 'Chưa thể xác nhận vì còn sản phẩm chưa gán nhà cung cấp.',
    text: buildDraftText(items, supplierGroups, canConfirm)
  };
}

function buildDraftText(items, supplierGroups, canConfirm) {
  if (items.length === 0) {
    return 'Chưa cần tạo phiếu mua hàng: chưa có mặt hàng TRACK_STOCK nào thiếu theo dự báo.';
  }

  const lines = ['Đã lập nháp đề xuất mua hàng theo dữ liệu thật:'];
  let index = 1;
  for (const group of supplierGroups) {
    lines.push(`Nhà cung cấp: ${group.supplier_name}`);
    for (const item of group.items) {
      const priceText = item.purchase_price > 0 ? `, giá nhập ${formatMoney(item.purchase_price)}` : ', chưa có giá nhập';
      const blockText = item.blocking_reason ? ` (${item.blocking_reason})` : '';
      lines.push(`${index}. ${item.product_name}: nhập ${formatQty(item.quantity)} ${item.unit}${priceText}${blockText}`);
      index += 1;
    }
  }
  lines.push(canConfirm ? 'Nói "ok" để tạo phiếu mua hàng trong DB.' : 'Cần gán nhà cung cấp trước khi tạo phiếu mua hàng.');
  return lines.join('\n');
}

// S4.2-fix: purchase_orders / purchase_order_items are no longer written directly from
// this service — InventoryPurchaseAgent is the sole approved writer for those tables (it also
// re-resolves purchase_price server-side). Only audit_logs is still introspected/inserted here.
async function getTableColumns(conn, tableName) {
  const allowed = new Set(['audit_logs']);
  if (!allowed.has(tableName)) throw new Error(`Table không được phép introspect: ${tableName}`);
  const [rows] = await conn.query(`SHOW COLUMNS FROM ${tableName}`);
  return new Set(rows.map(r => r.Field));
}

function addValueIfColumn(payload, columns, column, value) {
  if (columns.has(column)) payload[column] = value;
}

async function insertDynamic(conn, tableName, payload) {
  const columns = Object.keys(payload);
  if (columns.length === 0) throw new Error(`Không có cột hợp lệ để insert vào ${tableName}`);
  const sql = `INSERT INTO ${tableName} (${columns.map(c => `\`${c}\``).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
  const values = columns.map(c => payload[c]);
  return conn.query(sql, values);
}

// S4.2-fix: the AI draft's purchase_price (from PurchasePriceResolver.resolveDefaultSupplierRule,
// computed at forecast time) is only ever a preview shown to the user before confirm. At confirm
// time there is no human typing a manual price — so unlike the staff-facing manual PO builder,
// a missing catalog price here must block the item rather than silently reuse the AI's own
// precomputed number. Checked against the category-scoped catalog resolver, same chain
// InventoryPurchaseAgent uses, before any purchase order is created.
async function assertItemsHaveResolvablePrice(items, purchaseDate) {
  const unresolved = [];
  for (const item of items) {
    const supplierId = Number(item.supplier_id);
    let resolved = null;
    try {
      const [[map]] = await db.query(`SELECT partner_id FROM supplier_partner_map WHERE supplier_id=?`, [supplierId]);
      const [[product]] = await db.query(`SELECT category_id FROM products WHERE id=?`, [item.product_id]);
      const calendarType = await InventoryPurchaseAgent._resolveCalendarType({
        partner_id: map ? map.partner_id : null,
        supplier_id: supplierId
      });
      resolved = await SupplierPurchaseCatalogResolver.resolveSinglePrice(
        map ? map.partner_id : null, supplierId, item.product_id, product ? product.category_id : null, purchaseDate, calendarType
      );
    } catch (e) {
      // Any failure to verify (including suppliers on a LUNAR billing calendar, which the
      // purchase-catalog resolver cannot yet look up without an explicit lunar date text —
      // a pre-existing gap, not something this fix should silently work around) means the
      // price cannot be confirmed as authoritative. Block rather than guess.
      resolved = null;
    }
    if (!resolved) unresolved.push(item.product_name);
  }
  if (unresolved.length > 0) {
    throw new Error(
      'Chưa có giá nhập xác thực (bảng giá riêng NCC hoặc giá đã chốt) cho: ' + unresolved.join(', ') +
      '. AI không tự đặt giá — vui lòng tạo phiếu mua hàng thủ công và nhập giá cho các sản phẩm này.'
    );
  }
}

async function confirmSupplierOrderDraft(draft, user = {}) {
  if (!draft || draft.intent !== 'AI_SUPPLIER_ORDER_DRAFT') {
    throw new Error('Dữ liệu nháp nhập hàng không hợp lệ');
  }

  const items = Array.isArray(draft.items) ? draft.items : [];
  if (items.length === 0) throw new Error('Nháp nhập hàng không có sản phẩm');
  const unmapped = items.filter(item => !item.supplier_id);
  if (unmapped.length > 0) {
    throw new Error('Còn sản phẩm chưa gán nhà cung cấp: ' + unmapped.map(i => i.product_name).join(', '));
  }

  const userId = user.id || draft.created_by || null;
  const purchaseDate = new Date().toISOString().slice(0, 10);

  await assertItemsHaveResolvablePrice(items, purchaseDate);

  const groups = new Map();
  for (const item of items) {
    const key = String(item.supplier_id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const createdOrders = [];
  for (const [supplierId, groupItems] of groups.entries()) {
    const note = `AI tạo từ dự báo tồn kho: ${draft.params.lookback_days} ngày bán, ${draft.params.forecast_days} ngày tới + ${draft.params.safety_days} ngày an toàn`;

    // InventoryPurchaseAgent is the sole approved writer for purchase_orders / purchase_order_items.
    // Its addItem() re-resolves purchase_price server-side (SupplierPurchaseCatalogResolver,
    // category-scoped) — the draft's purchase_price below is passed only as the manual-entry
    // value the agent falls back to if resolution ever comes back empty, which
    // assertItemsHaveResolvablePrice above has already ruled out for every item in this batch.
    const po = await InventoryPurchaseAgent.create({
      supplier_id: Number(supplierId),
      purchase_date: purchaseDate,
      note
    }, userId);

    for (const item of groupItems) {
      await InventoryPurchaseAgent.addItem(po.id, {
        product_id: item.product_id,
        quantity: item.quantity,
        purchase_price: item.purchase_price || 0,
        note: `AI forecast: tồn ${formatQty(item.stock_quantity)}, TB/ngày ${formatQty(item.avg_daily_sale)}, risk ${item.risk}`
      }, userId);
    }

    const created = await InventoryPurchaseAgent.get(po.id);

    try {
      const conn = await db.getConnection();
      try {
        const auditColumns = await getTableColumns(conn, 'audit_logs').catch(() => new Set());
        if (auditColumns.size > 0) {
          const auditPayload = {};
          addValueIfColumn(auditPayload, auditColumns, 'user_id', userId);
          addValueIfColumn(auditPayload, auditColumns, 'action', 'AI_CREATE_PURCHASE_ORDER_DRAFT');
          addValueIfColumn(auditPayload, auditColumns, 'entity_type', 'purchase_orders');
          addValueIfColumn(auditPayload, auditColumns, 'entity_id', po.id);
          addValueIfColumn(auditPayload, auditColumns, 'note', `Tạo nháp PO ${po.order_code} từ AI Supplier Ordering v2`);
          if (Object.keys(auditPayload).length > 0) {
            await insertDynamic(conn, 'audit_logs', auditPayload);
          }
        }
      } finally {
        conn.release();
      }
    } catch (e) { /* audit log failure must not block PO creation */ }

    createdOrders.push({
      purchase_order_id: po.id,
      order_code: po.order_code,
      supplier_id: Number(supplierId),
      item_count: groupItems.length,
      total_amount: Number(created ? created.total_amount : 0)
    });
  }

  return {
    intent: 'CONFIRM_AI_SUPPLIER_ORDER_DRAFT',
    message: `Đã tạo ${createdOrders.length} phiếu mua hàng nháp trong DB.`,
    purchase_orders: createdOrders
  };
}

module.exports = {
  buildSupplierOrderDraft,
  confirmSupplierOrderDraft
};
