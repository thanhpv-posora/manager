const db = require('../config/db');
const PaymentAgent = require('../agents/PaymentAgent');

function normalizeText(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/đ/g, 'd')
    .replace(/,/g, '.');
}

function parseMoney(text) {
  const raw = String(text || '').toLowerCase();

  const match = raw.match(/([0-9]+(?:[.,][0-9]+)?)\s*(k|ngàn|nghìn|nghin|tr|triệu|trieu|m|000)?/i);
  if (!match) return 0;

  const value = Number(String(match[1]).replace(',', '.'));
  const unit = String(match[2] || '').toLowerCase();

  if (!Number.isFinite(value) || value <= 0) return 0;

  if (unit === 'k' || unit === 'ngàn' || unit === 'nghìn' || unit === 'nghin') {
    return Math.round(value * 1000);
  }

  if (unit === 'tr' || unit === 'triệu' || unit === 'trieu' || unit === 'm') {
    return Math.round(value * 1000000);
  }

  // Nếu nhập số lớn như 500000 thì giữ nguyên.
  return Math.round(value);
}

function detectPaymentMethod(message) {
  const text = normalizeText(message);

  if (/(ck|chuyen khoan|chuyển khoản|bank|ngan hang|ngân hàng)/i.test(text)) {
    return 'BANK_TRANSFER';
  }

  if (/(tm|tien mat|tiền mặt|cash)/i.test(text)) {
    return 'CASH';
  }

  // Mặc định câu "trả 500k" là tiền mặt.
  return 'CASH';
}

function isPaymentMessage(message) {
  const text = normalizeText(message);

  return /(trả|tra|thu|thanh toán|thanh toan|ck|chuyen khoan|chuyển khoản|tm|tien mat|tiền mặt)/i.test(text)
    && /[0-9]/.test(text);
}

function parsePaymentMessage(message) {
  const original = String(message || '').trim();
  const text = normalizeText(original);

  const keywordMatch = text.match(/\b(trả|tra|thu|thanh toán|thanh toan|ck|chuyen khoan|chuyển khoản|tm|tien mat|tiền mặt)\b/i);
  if (!keywordMatch) {
    throw new Error('Chưa hiểu câu thu tiền. Ví dụ: HongHien trả 500k hoặc HongHien ck 2tr');
  }

  const customerName = text.substring(0, keywordMatch.index).trim();
  if (!customerName) {
    throw new Error('Thiếu tên khách hàng trong câu thu tiền');
  }

  const afterKeyword = text.substring(keywordMatch.index + keywordMatch[0].length).trim();
  const amount = parseMoney(afterKeyword);
  if (amount <= 0) {
    throw new Error('Không đọc được số tiền thu');
  }

  return {
    customer_name: customerName,
    amount,
    payment_method: detectPaymentMethod(text)
  };
}

async function findCustomerByName(customerName) {
  const [rows] = await db.query(`
    SELECT
      id,
      name,
      phone,
      billing_calendar_type
    FROM customers
    WHERE del_flg = 0
      AND name LIKE ?
    ORDER BY
      CASE
        WHEN LOWER(name) = LOWER(?) THEN 1
        WHEN LOWER(name) LIKE LOWER(?) THEN 2
        ELSE 3
      END,
      id ASC
    LIMIT 1
  `, [
    `%${customerName}%`,
    customerName,
    `%${customerName}%`
  ]);

  if (!rows.length) {
    throw new Error(`Không tìm thấy khách: ${customerName}`);
  }

  return rows[0];
}

async function previewPayment(message) {
  const parsed = parsePaymentMessage(message);
  const customer = await findCustomerByName(parsed.customer_name);

  const [unpaidOrders] = await db.query(`
    SELECT
      id,
      order_code,
      order_date,
      total_amount,
      paid_amount,
      debt_amount,
      payment_status,
      calendar_type,
      lunar_date_text
    FROM orders
    WHERE customer_id = ?
      AND status <> 'CANCELLED'
      AND debt_amount > 0
    ORDER BY order_date ASC, id ASC
    LIMIT 20
  `, [customer.id]);

  let remaining = parsed.amount;
  const allocations = [];

  for (const order of unpaidOrders) {
    if (remaining <= 0) break;

    const applied = Math.min(remaining, Number(order.debt_amount || 0));
    if (applied > 0) {
      allocations.push({
        order_id: order.id,
        order_code: order.order_code,
        before_debt: Number(order.debt_amount || 0),
        applied,
        after_debt: Math.max(0, Number(order.debt_amount || 0) - applied)
      });
      remaining -= applied;
    }
  }

  return {
    intent: 'PAYMENT_PREVIEW',
    parsed,
    customer,
    amount: parsed.amount,
    payment_method: parsed.payment_method,
    allocations,
    over_amount: remaining > 0 ? remaining : 0,
    requires_confirm: true,
    confirm_message: 'Xác nhận thu tiền?'
  };
}

async function confirmPaymentFromPreview(preview, user = null) {
  const parsed = preview.parsed || preview;
  const customer = preview.customer || await findCustomerByName(parsed.customer_name);

  const cashAmount = parsed.payment_method === 'BANK_TRANSFER' ? 0 : Number(parsed.amount || 0);
  const bankAmount = parsed.payment_method === 'BANK_TRANSFER' ? Number(parsed.amount || 0) : 0;

  const result = await PaymentAgent.create({
    customer_id: customer.id,
    payment_date: new Date().toISOString().slice(0, 10),
    amount: Number(parsed.amount || 0),
    payment_method: parsed.payment_method,
    cash_amount: cashAmount,
    bank_amount: bankAmount,
    payment_calendar_type: customer.billing_calendar_type === 'LUNAR' ? 'LUNAR' : 'SOLAR',
    note: 'Thu tiền từ AI chat'
  }, user || { id: null, role: 'ADMIN' });

  return {
    intent: 'PAYMENT_CONFIRMED',
    customer,
    parsed,
    result
  };
}

async function createPaymentFromMessage(message, options = {}) {
  const preview = await previewPayment(message);

  if (options.confirm === true) {
    const confirmed = await confirmPaymentFromPreview(preview, options.user);
    return {
      ...preview,
      confirmed
    };
  }

  return preview;
}

module.exports = {
  isPaymentMessage,
  parsePaymentMessage,
  previewPayment,
  confirmPaymentFromPreview,
  createPaymentFromMessage
};
