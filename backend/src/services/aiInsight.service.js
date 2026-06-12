const db = require('../config/db');

function normalizeText(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/n代/g, 'no')
    .replace(/nợ/g, 'no')
    .replace(/còn/g, 'con')
    .replace(/khách/g, 'khach')
    .replace(/của/g, 'cua')
    .replace(/hôm/g, 'hom')
    .replace(/nay/g, 'nay')
    .replace(/nhiều/g, 'nhieu')
    .replace(/bao nhiêu/g, 'bao nhieu')
    .replace(/báo cáo/g, 'bao cao')
    .replace(/tóm tắt/g, 'tom tat')
    .replace(/tổng kết/g, 'tong ket')
    .replace(/điều hành/g, 'dieu hanh')
    .replace(/cần làm/g, 'can lam')
    .replace(/bán/g, 'ban')
    .replace(/thiếu/g, 'thieu')
    .replace(/hàng/g, 'hang')
    .replace(/sắp/g, 'sap')
    .replace(/hết/g, 'het')
    .replace(/công nợ/g, 'cong no')
    .replace(/doanh thu/g, 'doanh thu')
    .replace(/\s+/g, ' ');
}

function formatMoney(value) {
  return Number(value || 0).toLocaleString('vi-VN');
}

function formatQty(value) {
  return Number(value || 0).toLocaleString('vi-VN', { maximumFractionDigits: 3 });
}

async function tableColumns(tableName) {
  const [rows] = await db.query(`
    SELECT COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
  `, [tableName]);
  return new Set(rows.map(r => r.COLUMN_NAME));
}

function notDeletedWhere(alias, columns) {
  return columns.has('del_flg') ? ` AND ${alias}.del_flg = 0 ` : '';
}

function isInsightMessage(message) {
  const text = normalizeText(message);

  return (
    text.includes('dashboard') ||
    text.includes('tom tat') ||
    text.includes('tong ket') ||
    text.includes('dieu hanh') ||
    text.includes('hom nay ban') ||
    text.includes('hom nay sao') ||
    text.includes('can lam gi') ||
    text.includes('doanh thu') ||
    text.includes('bao cao') ||
    text.includes('con no') ||
    text.includes('cong no') ||
    text.includes('no bao nhieu') ||
    text.includes('top khach') ||
    text.includes('no nhieu') ||
    text.includes('bill hom nay') ||
    /\bno\b.*\bbao nhieu\b/i.test(text)
  );
}

function isDashboardSummaryMessage(message) {
  const text = normalizeText(message);
  return (
    text.includes('dashboard') ||
    text.includes('tom tat') ||
    text.includes('tong ket') ||
    text.includes('dieu hanh') ||
    text.includes('hom nay ban sao') ||
    text.includes('hom nay sao') ||
    text.includes('can lam gi') ||
    text === 'hom nay ban sao'
  );
}

function extractCustomerName(message) {
  const text = normalizeText(message);

  const patterns = [
    /(?:khach)\s+([a-zA-ZÀ-ỹ0-9\s]+?)\s+(?:con no|no|bill)/i,
    /^([a-zA-ZÀ-ỹ0-9\s]+?)\s+(?:con no|no|bill)/i,
    /bill\s+(?:hom nay)\s+(?:cua)\s+([a-zA-ZÀ-ỹ0-9\s]+)/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) return match[1].trim();
  }
  return null;
}

async function findCustomer(name) {
  if (!name) return null;

  const cCols = await tableColumns('customers');
  const del = notDeletedWhere('c', cCols);

  const [rows] = await db.query(`
    SELECT c.id, c.name, c.phone, ${cCols.has('billing_calendar_type') ? 'c.billing_calendar_type' : "'SOLAR' AS billing_calendar_type"}
    FROM customers c
    WHERE 1=1 ${del}
      AND c.name LIKE ?
    ORDER BY
      CASE
        WHEN LOWER(c.name) = LOWER(?) THEN 1
        WHEN LOWER(c.name) LIKE LOWER(?) THEN 2
        ELSE 3
      END
    LIMIT 1
  `, [`%${name}%`, name, `%${name}%`]);

  return rows[0] || null;
}

async function dailyRevenue() {
  const oCols = await tableColumns('orders');
  const del = notDeletedWhere('o', oCols);
  const totalExpr = oCols.has('total_amount') ? 'total_amount' : '0';
  const paidExpr = oCols.has('paid_amount') ? 'paid_amount' : '0';
  const debtExpr = oCols.has('debt_amount') ? 'debt_amount' : '0';
  const dateCol = oCols.has('order_date') ? 'order_date' : (oCols.has('created_at') ? 'created_at' : 'id');

  const [rows] = await db.query(`
    SELECT
      COUNT(*) AS total_orders,
      COALESCE(SUM(${totalExpr}), 0) AS total_amount,
      COALESCE(SUM(${paidExpr}), 0) AS paid_amount,
      COALESCE(SUM(${debtExpr}), 0) AS debt_amount
    FROM orders o
    WHERE 1=1 ${del}
      AND DATE(o.${dateCol}) = CURDATE()
  `);

  const data = rows[0] || {};
  return {
    intent: 'INSIGHT_DAILY_REVENUE',
    data,
    text: `Hôm nay có ${data.total_orders || 0} bill, tổng ${formatMoney(data.total_amount)}đ, đã thu ${formatMoney(data.paid_amount)}đ, ghi nợ ${formatMoney(data.debt_amount)}đ.`
  };
}

async function customerDebt(customerName) {
  const customer = await findCustomer(customerName);
  if (!customer) throw new Error(`Không tìm thấy khách: ${customerName}`);

  const oCols = await tableColumns('orders');
  const del = notDeletedWhere('o', oCols);
  const debtExpr = oCols.has('debt_amount') ? 'debt_amount' : '0';

  const [rows] = await db.query(`
    SELECT COALESCE(SUM(${debtExpr}), 0) AS debt_amount, COUNT(*) AS unpaid_orders
    FROM orders o
    WHERE 1=1 ${del}
      AND o.customer_id = ?
      AND ${debtExpr} > 0
  `, [customer.id]);

  const data = rows[0] || {};
  return {
    intent: 'INSIGHT_CUSTOMER_DEBT',
    customer,
    data,
    text: `${customer.name} còn nợ ${formatMoney(data.debt_amount)}đ trên ${data.unpaid_orders || 0} bill chưa tất toán.`
  };
}

async function topDebtors(limit = 10) {
  const oCols = await tableColumns('orders');
  const cCols = await tableColumns('customers');
  const oDel = notDeletedWhere('o', oCols);
  const cDel = notDeletedWhere('c', cCols);
  const debtExpr = oCols.has('debt_amount') ? 'o.debt_amount' : '0';

  const [rows] = await db.query(`
    SELECT c.id, c.name, c.phone, COALESCE(SUM(${debtExpr}), 0) AS debt_amount, COUNT(o.id) AS unpaid_orders
    FROM customers c
    JOIN orders o ON o.customer_id = c.id ${oDel} AND ${debtExpr} > 0
    WHERE 1=1 ${cDel}
    GROUP BY c.id, c.name, c.phone
    HAVING debt_amount > 0
    ORDER BY debt_amount DESC
    LIMIT ?
  `, [Number(limit)]);

  return {
    intent: 'INSIGHT_TOP_DEBTORS',
    data: rows,
    text: rows.length === 0
      ? 'Hiện chưa có khách nào còn nợ.'
      : 'Top khách nợ nhiều nhất:\n' + rows.map((row, index) => `${index + 1}. ${row.name}: ${formatMoney(row.debt_amount)}đ (${row.unpaid_orders} bill)`).join('\n')
  };
}

async function customerTodayBills(customerName) {
  const customer = await findCustomer(customerName);
  if (!customer) throw new Error(`Không tìm thấy khách: ${customerName}`);

  const oCols = await tableColumns('orders');
  const del = notDeletedWhere('o', oCols);
  const dateCol = oCols.has('order_date') ? 'order_date' : 'created_at';
  const orderCode = oCols.has('order_code') ? 'o.order_code' : 'CAST(o.id AS CHAR) AS order_code';

  const [rows] = await db.query(`
    SELECT o.id, ${orderCode}, o.${dateCol} AS order_date,
      ${oCols.has('calendar_type') ? 'o.calendar_type' : "'SOLAR' AS calendar_type"},
      ${oCols.has('lunar_date_text') ? 'o.lunar_date_text' : 'NULL AS lunar_date_text'},
      ${oCols.has('total_amount') ? 'o.total_amount' : '0 AS total_amount'},
      ${oCols.has('paid_amount') ? 'o.paid_amount' : '0 AS paid_amount'},
      ${oCols.has('debt_amount') ? 'o.debt_amount' : '0 AS debt_amount'},
      ${oCols.has('payment_status') ? 'o.payment_status' : "'UNKNOWN' AS payment_status"}
    FROM orders o
    WHERE 1=1 ${del}
      AND o.customer_id = ?
      AND DATE(o.${dateCol}) = CURDATE()
    ORDER BY o.id DESC
  `, [customer.id]);

  const total = rows.reduce((sum, row) => sum + Number(row.total_amount || 0), 0);
  const debt = rows.reduce((sum, row) => sum + Number(row.debt_amount || 0), 0);
  return {
    intent: 'INSIGHT_CUSTOMER_TODAY_BILLS',
    customer,
    data: { bills: rows, total_amount: total, debt_amount: debt },
    text: rows.length === 0
      ? `Hôm nay ${customer.name} chưa có bill.`
      : `Hôm nay ${customer.name} có ${rows.length} bill, tổng ${formatMoney(total)}đ, còn nợ ${formatMoney(debt)}đ.`
  };
}

async function dashboardSummary() {
  const oCols = await tableColumns('orders');
  const oiCols = await tableColumns('order_items');
  const pCols = await tableColumns('products');
  const cCols = await tableColumns('customers');

  const oDel = notDeletedWhere('o', oCols);
  const pDel = notDeletedWhere('p', pCols);
  const cDel = notDeletedWhere('c', cCols);
  const dateCol = oCols.has('order_date') ? 'order_date' : (oCols.has('created_at') ? 'created_at' : 'id');
  const totalExpr = oCols.has('total_amount') ? 'o.total_amount' : '0';
  const paidExpr = oCols.has('paid_amount') ? 'o.paid_amount' : '0';
  const debtExpr = oCols.has('debt_amount') ? 'o.debt_amount' : '0';

  const [todayRows] = await db.query(`
    SELECT COUNT(*) AS total_orders,
      COALESCE(SUM(${totalExpr}),0) AS total_amount,
      COALESCE(SUM(${paidExpr}),0) AS paid_amount,
      COALESCE(SUM(${debtExpr}),0) AS debt_amount
    FROM orders o
    WHERE 1=1 ${oDel}
      AND DATE(o.${dateCol}) = CURDATE()
  `);
  const today = todayRows[0] || {};

  let topProducts = [];
  if (oiCols.size && pCols.size && oiCols.has('order_id') && oiCols.has('product_id')) {
    const qtyExpr = oiCols.has('quantity') ? 'oi.quantity' : '0';
    const totalItemExpr = oiCols.has('total_price') ? 'oi.total_price' : (oiCols.has('total_amount') ? 'oi.total_amount' : '0');
    const productNameExpr = pCols.has('name') ? 'p.name' : (oiCols.has('product_name') ? 'oi.product_name' : "CONCAT('SP ', oi.product_id)");
    const unitExpr = pCols.has('unit') ? 'p.unit' : (oiCols.has('unit') ? 'oi.unit' : "''");
    const oiDel = oiCols.has('del_flg') ? ' AND oi.del_flg = 0 ' : '';
    const [rows] = await db.query(`
      SELECT oi.product_id, ${productNameExpr} AS product_name, ${unitExpr} AS unit,
        COALESCE(SUM(${qtyExpr}),0) AS sold_qty,
        COALESCE(SUM(${totalItemExpr}),0) AS total_amount
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id ${oDel}
      LEFT JOIN products p ON p.id = oi.product_id ${pDel}
      WHERE 1=1 ${oiDel}
        AND DATE(o.${dateCol}) = CURDATE()
      GROUP BY oi.product_id, product_name, unit
      ORDER BY sold_qty DESC
      LIMIT 5
    `);
    topProducts = rows;
  }

  let lowStock = [];
  if (pCols.size && pCols.has('stock_quantity')) {
    const thresholdExpr = pCols.has('low_stock_threshold') ? 'p.low_stock_threshold' : '0';
    const modeExpr = pCols.has('inventory_mode') ? 'p.inventory_mode' : "'TRACK_STOCK'";
    const activeWhere = pCols.has('is_active') ? ' AND p.is_active = 1 ' : '';
    const [rows] = await db.query(`
      SELECT p.id AS product_id, p.name AS product_name, p.unit,
        p.stock_quantity, ${thresholdExpr} AS low_stock_threshold, ${modeExpr} AS inventory_mode
      FROM products p
      WHERE 1=1 ${pDel} ${activeWhere}
        AND (${modeExpr} IN ('TRACK_STOCK','STOCK') OR ${modeExpr} IS NULL)
        AND p.stock_quantity <= ${thresholdExpr}
      ORDER BY p.stock_quantity ASC
      LIMIT 8
    `);
    lowStock = rows;
  }

  let debtors = [];
  if (oCols.has('customer_id') && cCols.size) {
    const [rows] = await db.query(`
      SELECT c.id, c.name, c.phone,
        COALESCE(SUM(${debtExpr}),0) AS debt_amount,
        COUNT(o.id) AS unpaid_orders
      FROM customers c
      JOIN orders o ON o.customer_id = c.id ${oDel} AND ${debtExpr} > 0
      WHERE 1=1 ${cDel}
      GROUP BY c.id, c.name, c.phone
      HAVING debt_amount > 0
      ORDER BY debt_amount DESC
      LIMIT 5
    `);
    debtors = rows;
  }

  const actions = [];
  if (Number(today.debt_amount || 0) > 0) actions.push(`Hôm nay phát sinh nợ ${formatMoney(today.debt_amount)}đ, nên kiểm tra thu tiền cuối ngày.`);
  if (lowStock.length > 0) actions.push(`Có ${lowStock.length} mặt hàng đang dưới ngưỡng, nên lập nháp nhập hàng.`);
  if (topProducts.length > 0) actions.push(`Mặt hàng bán mạnh nhất hôm nay: ${topProducts[0].product_name} (${formatQty(topProducts[0].sold_qty)} ${topProducts[0].unit || ''}).`);
  if (actions.length === 0) actions.push('Chưa có cảnh báo lớn, tiếp tục theo dõi bán hàng và tồn kho.');

  const text = [
    `Tóm tắt điều hành hôm nay: ${today.total_orders || 0} bill, doanh thu ${formatMoney(today.total_amount)}đ, đã thu ${formatMoney(today.paid_amount)}đ, công nợ mới ${formatMoney(today.debt_amount)}đ.`,
    topProducts.length ? `Bán chạy: ${topProducts.slice(0,3).map(x => `${x.product_name} ${formatQty(x.sold_qty)}${x.unit || ''}`).join(', ')}.` : 'Hôm nay chưa có dữ liệu bán chạy.',
    lowStock.length ? `Cảnh báo tồn kho: ${lowStock.slice(0,3).map(x => `${x.product_name} còn ${formatQty(x.stock_quantity)}${x.unit || ''}`).join(', ')}.` : 'Chưa có mặt hàng TRACK_STOCK dưới ngưỡng.',
    debtors.length ? `Công nợ cao: ${debtors.slice(0,3).map(x => `${x.name} ${formatMoney(x.debt_amount)}đ`).join(', ')}.` : 'Chưa có khách nợ đáng chú ý.'
  ].join('\n');

  return {
    intent: 'AI_DASHBOARD_SUMMARY',
    today,
    top_products: topProducts,
    low_stock: lowStock,
    top_debtors: debtors,
    recommended_actions: actions,
    text
  };
}

async function handleInsight(message) {
  const text = normalizeText(message);

  if (isDashboardSummaryMessage(message)) return dashboardSummary();

  if (text.includes('top') || text.includes('no nhieu')) return topDebtors(10);

  if (text.includes('bill hom nay')) {
    const customerName = extractCustomerName(message);
    if (customerName) return customerTodayBills(customerName);
  }

  if (text.includes('con no') || text.includes('cong no') || text.includes('no bao nhieu') || /\bno\b.*\bbao nhieu\b/i.test(text)) {
    const customerName = extractCustomerName(message);
    if (customerName) return customerDebt(customerName);
    return topDebtors(10);
  }

  return dailyRevenue();
}

module.exports = {
  isInsightMessage,
  isDashboardSummaryMessage,
  handleInsight,
  dashboardSummary
};
