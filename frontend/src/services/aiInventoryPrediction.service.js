const db = require('../config/db');

function n(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function formatQty(value) {
  return n(value).toLocaleString('vi-VN', { maximumFractionDigits: 2 });
}

function normalizeDays(value, fallback = 7) {
  const days = Number(value || fallback);
  if (!Number.isFinite(days)) return fallback;
  return Math.max(1, Math.min(90, Math.round(days)));
}

async function getInventoryPrediction(options = {}) {
  const lookbackDays = normalizeDays(options.lookback_days, 14);
  const forecastDays = normalizeDays(options.forecast_days, 7);

  const [rows] = await db.query(`
    SELECT
      p.id AS product_id,
      p.name AS product_name,
      p.unit,
      p.stock_quantity,
      p.low_stock_threshold,
      CASE
        WHEN p.inventory_mode = 'STOCK' THEN 'TRACK_STOCK'
        ELSE p.inventory_mode
      END AS inventory_mode,
      COALESCE(SUM(CASE
        WHEN o.order_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        THEN oi.quantity ELSE 0 END), 0) AS sold_qty,
      COALESCE(COUNT(DISTINCT CASE
        WHEN o.order_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        THEN o.id ELSE NULL END), 0) AS order_count
    FROM products p
    LEFT JOIN order_items oi
      ON oi.product_id = p.id
    LEFT JOIN orders o
      ON o.id = oi.order_id
     AND o.del_flg = 0
     AND o.status <> 'CANCELLED'
    WHERE p.del_flg = 0
      AND p.is_active = 1
      AND p.inventory_mode IN ('TRACK_STOCK', 'STOCK')
    GROUP BY
      p.id, p.name, p.unit, p.stock_quantity, p.low_stock_threshold, p.inventory_mode
    ORDER BY p.name ASC
  `, [lookbackDays, lookbackDays]);

  const data = rows.map((row) => {
    const soldQty = n(row.sold_qty);
    const avgDailySale = soldQty / lookbackDays;
    const forecastNeed = avgDailySale * forecastDays;
    const projectedStock = n(row.stock_quantity) - forecastNeed;
    const daysUntilOut = avgDailySale > 0
      ? n(row.stock_quantity) / avgDailySale
      : null;

    let risk = 'OK';
    if (avgDailySale > 0 && projectedStock <= 0) risk = 'OUT_SOON';
    else if (projectedStock <= n(row.low_stock_threshold)) risk = 'LOW_SOON';

    return {
      product_id: row.product_id,
      product_name: row.product_name,
      unit: row.unit || 'kg',
      inventory_mode: row.inventory_mode,
      stock_quantity: n(row.stock_quantity),
      low_stock_threshold: n(row.low_stock_threshold),
      lookback_days: lookbackDays,
      forecast_days: forecastDays,
      sold_qty: soldQty,
      avg_daily_sale: Number(avgDailySale.toFixed(3)),
      forecast_need: Number(forecastNeed.toFixed(3)),
      projected_stock: Number(projectedStock.toFixed(3)),
      days_until_out: daysUntilOut === null ? null : Number(daysUntilOut.toFixed(1)),
      risk
    };
  });

  const risky = data
    .filter((row) => row.risk !== 'OK')
    .sort((a, b) => {
      const score = { OUT_SOON: 1, LOW_SOON: 2, OK: 3 };
      return score[a.risk] - score[b.risk] || a.projected_stock - b.projected_stock;
    });

  return {
    intent: 'AI_INVENTORY_PREDICTION',
    params: { lookback_days: lookbackDays, forecast_days: forecastDays },
    data,
    risky,
    text: risky.length === 0
      ? `Dự báo ${forecastDays} ngày tới: chưa thấy sản phẩm TRACK_STOCK nào có nguy cơ hết hoặc dưới ngưỡng.`
      : `Dự báo ${forecastDays} ngày tới, các mặt hàng cần chú ý:\n` + risky.slice(0, 10).map((row, index) => {
          const dayText = row.days_until_out === null ? 'chưa có tốc độ bán' : `ước còn ${formatQty(row.days_until_out)} ngày`;
          return `${index + 1}. ${row.product_name}: tồn ${formatQty(row.stock_quantity)} ${row.unit}, bán TB ${formatQty(row.avg_daily_sale)} ${row.unit}/ngày, cần ${formatQty(row.forecast_need)} ${row.unit}, dự kiến còn ${formatQty(row.projected_stock)} ${row.unit} (${dayText}, ${row.risk}).`;
        }).join('\n')
  };
}

async function suggestSupplierOrders(options = {}) {
  const forecastDays = normalizeDays(options.forecast_days, 7);
  const safetyDays = normalizeDays(options.safety_days, 3);
  const prediction = await getInventoryPrediction({
    lookback_days: options.lookback_days || 14,
    forecast_days: forecastDays + safetyDays
  });

  const suggestions = prediction.data
    .map((row) => {
      const targetQty = row.avg_daily_sale * (forecastDays + safetyDays);
      const suggestedQty = Math.max(0, targetQty - row.stock_quantity);
      return {
        ...row,
        target_days: forecastDays + safetyDays,
        target_qty: Number(targetQty.toFixed(3)),
        suggested_order_qty: Number(suggestedQty.toFixed(3))
      };
    })
    .filter((row) => row.suggested_order_qty > 0)
    .sort((a, b) => b.suggested_order_qty - a.suggested_order_qty);

  return {
    intent: 'AI_SUPPLIER_ORDER_SUGGESTION',
    params: {
      lookback_days: prediction.params.lookback_days,
      forecast_days: forecastDays,
      safety_days: safetyDays
    },
    data: suggestions,
    text: suggestions.length === 0
      ? `Chưa cần đề xuất nhập thêm cho ${forecastDays} ngày bán + ${safetyDays} ngày an toàn.`
      : `Đề xuất nhập hàng cho ${forecastDays} ngày bán + ${safetyDays} ngày an toàn:\n` + suggestions.slice(0, 10).map((row, index) => {
          return `${index + 1}. ${row.product_name}: nên nhập khoảng ${formatQty(row.suggested_order_qty)} ${row.unit} (tồn ${formatQty(row.stock_quantity)}, mục tiêu ${formatQty(row.target_qty)}).`;
        }).join('\n')
  };
}

module.exports = {
  getInventoryPrediction,
  suggestSupplierOrders
};
