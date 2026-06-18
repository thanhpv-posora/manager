const db = require('../config/db');
const aiInventoryPredictionService = require('./aiInventoryPrediction.service');

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

function formatQty(value) {
  return n(value).toLocaleString('vi-VN', { maximumFractionDigits: 2 });
}

function formatMoney(value) {
  return n(value).toLocaleString('vi-VN', { maximumFractionDigits: 0 });
}

async function getSupplierRule(productId) {
  const [rows] = await db.query(`
    SELECT
      p.id product_id,
      p.default_purchase_price,
      p.default_supplier_id,
      ps.supplier_id linked_supplier_id,
      ps.purchase_price linked_purchase_price,
      ps.min_order_qty,
      ps.order_multiple_qty,
      ps.lead_time_days,
      s1.name linked_supplier_name,
      s2.name default_supplier_name
    FROM products p
    LEFT JOIN product_supplier_links ps
      ON ps.product_id = p.id
     AND ps.is_active = 1
     AND ps.is_default = 1
    LEFT JOIN suppliers s1
      ON s1.id = ps.supplier_id
     AND s1.del_flg = 0
     AND s1.is_active = 1
    LEFT JOIN suppliers s2
      ON s2.id = p.default_supplier_id
     AND s2.del_flg = 0
     AND s2.is_active = 1
    WHERE p.id = ?
    LIMIT 1
  `, [productId]);

  const row = rows[0] || {};
  const supplierId = row.linked_supplier_id || row.default_supplier_id || null;
  const supplierName = row.linked_supplier_name || row.default_supplier_name || null;
  const purchasePrice = n(row.linked_purchase_price || row.default_purchase_price);

  return {
    supplier_id: supplierId,
    supplier_name: supplierName,
    purchase_price: purchasePrice,
    min_order_qty: n(row.min_order_qty),
    order_multiple_qty: n(row.order_multiple_qty),
    lead_time_days: n(row.lead_time_days)
  };
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
    const rule = await getSupplierRule(row.product_id);
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

async function getTableColumns(conn, tableName) {
  const allowed = new Set(['purchase_orders', 'purchase_order_items', 'audit_logs']);
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

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const poColumns = await getTableColumns(conn, 'purchase_orders');
    const poiColumns = await getTableColumns(conn, 'purchase_order_items');
    const auditColumns = await getTableColumns(conn, 'audit_logs').catch(() => new Set());

    const createdOrders = [];
    const groups = new Map();
    for (const item of items) {
      const key = String(item.supplier_id);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }

    for (const [supplierId, groupItems] of groups.entries()) {
      const orderCode = `PO${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}${Math.floor(Math.random() * 1000)}`;
      const totalAmount = groupItems.reduce((sum, item) => sum + n(item.total_price), 0);
      const leadDays = Math.max(...groupItems.map(i => n(i.lead_time_days)), 0);
      const note = `AI tạo từ dự báo tồn kho: ${draft.params.lookback_days} ngày bán, ${draft.params.forecast_days} ngày tới + ${draft.params.safety_days} ngày an toàn`;
      const userId = user.id || draft.created_by || null;

      const poPayload = {};
      addValueIfColumn(poPayload, poColumns, 'order_code', orderCode);
      addValueIfColumn(poPayload, poColumns, 'purchase_order_code', orderCode);
      addValueIfColumn(poPayload, poColumns, 'code', orderCode);
      addValueIfColumn(poPayload, poColumns, 'po_code', orderCode);
      addValueIfColumn(poPayload, poColumns, 'supplier_id', Number(supplierId));
      addValueIfColumn(poPayload, poColumns, 'order_date', new Date());
      addValueIfColumn(poPayload, poColumns, 'purchase_date', new Date());
      addValueIfColumn(poPayload, poColumns, 'expected_date', new Date(Date.now() + leadDays * 86400000));
      addValueIfColumn(poPayload, poColumns, 'status', 'DRAFT');
      addValueIfColumn(poPayload, poColumns, 'source', 'AI_SUPPLIER_ORDER');
      addValueIfColumn(poPayload, poColumns, 'total_amount', Number(totalAmount.toFixed(2)));
      addValueIfColumn(poPayload, poColumns, 'note', note);
      addValueIfColumn(poPayload, poColumns, 'created_by', userId);
      addValueIfColumn(poPayload, poColumns, 'del_flg', 0);

      if (!poColumns.has('supplier_id')) {
        throw new Error('Bảng purchase_orders thiếu cột supplier_id nên chưa thể tạo phiếu mua hàng thật');
      }

      const [poResult] = await insertDynamic(conn, 'purchase_orders', poPayload);
      const poId = poResult.insertId;

      for (const item of groupItems) {
        const itemPayload = {};
        addValueIfColumn(itemPayload, poiColumns, 'purchase_order_id', poId);
        addValueIfColumn(itemPayload, poiColumns, 'product_id', item.product_id);
        addValueIfColumn(itemPayload, poiColumns, 'product_name', item.product_name);
        addValueIfColumn(itemPayload, poiColumns, 'unit', item.unit || 'kg');
        addValueIfColumn(itemPayload, poiColumns, 'quantity', item.quantity);
        addValueIfColumn(itemPayload, poiColumns, 'purchase_price', item.purchase_price || 0);
        addValueIfColumn(itemPayload, poiColumns, 'price', item.purchase_price || 0);
        addValueIfColumn(itemPayload, poiColumns, 'unit_price', item.purchase_price || 0);
        addValueIfColumn(itemPayload, poiColumns, 'total_price', item.total_price || 0);
        addValueIfColumn(itemPayload, poiColumns, 'amount', item.total_price || 0);
        addValueIfColumn(itemPayload, poiColumns, 'received_quantity', 0);
        addValueIfColumn(itemPayload, poiColumns, 'note', `AI forecast: tồn ${item.stock_quantity}, TB/ngày ${item.avg_daily_sale}, risk ${item.risk}`);

        if (!poiColumns.has('purchase_order_id') || !poiColumns.has('product_id')) {
          throw new Error('Bảng purchase_order_items thiếu cột purchase_order_id hoặc product_id');
        }

        await insertDynamic(conn, 'purchase_order_items', itemPayload);
      }

      if (auditColumns.size > 0) {
        const auditPayload = {};
        addValueIfColumn(auditPayload, auditColumns, 'user_id', userId);
        addValueIfColumn(auditPayload, auditColumns, 'action', 'AI_CREATE_PURCHASE_ORDER_DRAFT');
        addValueIfColumn(auditPayload, auditColumns, 'entity_type', 'purchase_orders');
        addValueIfColumn(auditPayload, auditColumns, 'entity_id', poId);
        addValueIfColumn(auditPayload, auditColumns, 'note', `Tạo nháp PO ${orderCode} từ AI Supplier Ordering v2`);
        if (Object.keys(auditPayload).length > 0) {
          await insertDynamic(conn, 'audit_logs', auditPayload).catch(() => null);
        }
      }

      createdOrders.push({
        purchase_order_id: poId,
        order_code: orderCode,
        supplier_id: Number(supplierId),
        item_count: groupItems.length,
        total_amount: Number(totalAmount.toFixed(2))
      });
    }

    await conn.commit();

    return {
      intent: 'CONFIRM_AI_SUPPLIER_ORDER_DRAFT',
      message: `Đã tạo ${createdOrders.length} phiếu mua hàng nháp trong DB.`,
      purchase_orders: createdOrders
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  buildSupplierOrderDraft,
  confirmSupplierOrderDraft
};
