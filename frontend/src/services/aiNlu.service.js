function stripCodeFence(text) {
  return String(text || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
}

function safeJsonParse(text) {
  try {
    return JSON.parse(stripCodeFence(text));
  } catch (err) {
    return null;
  }
}

function isEnabled() {
  return Boolean(process.env.OPENAI_API_KEY);
}

async function getNluBusinessContext() {
  try {
    const db = require('../config/db');

    const [customers] = await db.query(`
      SELECT id, name
      FROM customers
      WHERE del_flg = 0
      ORDER BY id DESC
      LIMIT 100
    `);

    const [products] = await db.query(`
      SELECT id, name, inventory_mode
      FROM products
      WHERE del_flg = 0
        AND is_active = 1
      ORDER BY id DESC
      LIMIT 200
    `);

    return {
      customers: customers.map((row) => row.name),
      products: products.map((row) => ({
        name: row.name,
        inventory_mode: row.inventory_mode
      }))
    };
  } catch (err) {
    console.warn('NLU business context unavailable:', err.message);
    return {
      customers: [],
      products: []
    };
  }
}

function normalizeIntent(intent) {
  if (!intent || typeof intent !== 'object') return null;

  const type = String(intent.intent || intent.type || '').toUpperCase();

  if (!type) return null;

  return {
    intent: type,
    confidence: Number(intent.confidence || 0),
    customer_name: intent.customer_name || intent.customer || null,
    items: Array.isArray(intent.items) ? intent.items.map((item) => ({
      product_name: item.product_name || item.product || item.name || '',
      quantity: Number(item.quantity || item.qty || 0),
      unit_input: item.unit_input || item.unit || 'kg'
    })).filter((item) => item.product_name && item.quantity > 0) : [],
    payment: intent.payment || null,
    edit: intent.edit || null,
    insight_type: intent.insight_type || null,
    raw: intent
  };
}

async function extractIntent(message, context = {}) {
  if (!isEnabled()) {
    return null;
  }

  const model = process.env.OPENAI_NLU_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';

  const systemPrompt = `
Bạn là MeatBiz NLU, chuyên chuyển câu nói tiếng Việt/ngôn ngữ đời thường trong ngành bán thịt bò thành JSON intent.
Dựa vào business_context gồm danh sách khách hàng và sản phẩm thật từ DB để hiểu tên khách/sản phẩm. Không hard-code tên khách hoặc sản phẩm.
Chỉ trả JSON object, không giải thích.

Intent hợp lệ:
- CREATE_ORDER: tạo bill bán hàng.
- ADD_ITEM: thêm món vào bill nháp hiện tại.
- REMOVE_ITEM: bỏ món khỏi bill nháp.
- CHANGE_QTY: đổi số lượng món trong bill nháp.
- CREATE_PAYMENT: thu tiền khách.
- BUSINESS_INSIGHT: hỏi báo cáo/công nợ/doanh thu.
- INVENTORY_CHECK: hỏi tồn kho sản phẩm.
- LOW_STOCK_ALERT: hỏi sản phẩm sắp hết/hết hàng.
- INVENTORY_PREDICTION: dự báo tồn kho / hàng nào sắp hết trong vài ngày tới.
- SUPPLIER_ORDER_SUGGESTION: đề xuất nhập hàng / đặt nhà cung cấp.
- CONFIRM: xác nhận lưu nháp.
- CANCEL: hủy nháp.
- REPEAT_ORDER: lặp lại bill gần nhất của khách.
- UNKNOWN: không hiểu.

Schema:
{
  "intent": "CREATE_ORDER|REPEAT_ORDER|ADD_ITEM|REMOVE_ITEM|CHANGE_QTY|CREATE_PAYMENT|BUSINESS_INSIGHT|INVENTORY_CHECK|LOW_STOCK_ALERT|INVENTORY_PREDICTION|SUPPLIER_ORDER_SUGGESTION|CONFIRM|CANCEL|UNKNOWN",
  "confidence": 0.0-1.0,
  "customer_name": "tên khách nếu có",
  "items": [{"product_name":"tên hàng","quantity": số, "unit_input":"kg"}],
  "payment": {"amount": số tiền VND, "method":"CASH|BANK_TRANSFER|MIXED"},
  "edit": {"product_name":"tên hàng", "quantity": số nếu có},
  "insight_type": "DAILY_REVENUE|CUSTOMER_DEBT|TOP_DEBTORS|CUSTOMER_TODAY_BILLS|GENERAL"
}

Quy ước:
- "ký", "kí", không nói đơn vị => kg.
- "500k" = 500000, "2tr" = 2000000, "1 triệu" = 1000000.
- "ck", "chuyển khoản" => BANK_TRANSFER.
- "trả", "tiền mặt" => CASH.
- "ok", "ok lưu", "đồng ý", "xác nhận" => CONFIRM.
- "hủy", "không lưu", "bỏ đi" => CANCEL.
- "còn nợ bao nhiêu", "nợ", "doanh thu", "top khách nợ", "bill hôm nay" => BUSINESS_INSIGHT.
- "còn bao nhiêu gà", "tồn kho vịt", "kiểm tra tồn gà" => INVENTORY_CHECK.
- "sản phẩm nào sắp hết", "hết hàng chưa" => LOW_STOCK_ALERT.
- "dự báo tồn kho", "tuần tới thiếu hàng gì", "7 ngày tới còn đủ không" => INVENTORY_PREDICTION.
- "nên nhập hàng gì", "đề xuất đặt nhà cung cấp", "mai nhập gì" => SUPPLIER_ORDER_SUGGESTION.
- "lấy như hôm qua", "lặp lại bill gần nhất", "như bữa trước" => REPEAT_ORDER.
- "thêm 1 gầu" => ADD_ITEM.
- "bỏ bon" => REMOVE_ITEM.
- "đổi bon 3" hoặc "sửa bon 3 ký" => CHANGE_QTY.
`.trim();

  const businessContext = await getNluBusinessContext();

  const userPrompt = JSON.stringify({
    message,
    context,
    business_context: businessContext
  });

  let response;
  const timeoutMs = Number(process.env.OPENAI_NLU_TIMEOUT_MS || 45000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    signal: controller.signal,
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    })
  });
  } catch (err) {
    console.error('OpenAI NLU fetch failed:', err.name === 'AbortError' ? `timeout ${timeoutMs}ms` : err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const detail = await response.text();
    console.error('OpenAI NLU error:', detail);
    return null;
  }

  const result = await response.json();
  const content = result?.choices?.[0]?.message?.content;
  const parsed = safeJsonParse(content);

  return normalizeIntent(parsed);
}

module.exports = {
  isEnabled,
  extractIntent
};
