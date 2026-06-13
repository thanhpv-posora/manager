const db = require('../config/db');
const { nanoid } = require('nanoid');
const { toLunarDateText } = require('../utils/lunar');
const inventoryService = require('./inventory.service');
const customerPolicyService = require('./customerPolicy.service');
const { normalizeVietnameseText, findBestMatch } = require('../utils/textNormalizer');

function todayYmd() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function normalizeCalendarType(value) {
  return String(value || 'SOLAR').toUpperCase() === 'LUNAR' ? 'LUNAR' : 'SOLAR';
}

function normalizeAmount(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function expandProductKeywordVariants(keyword) {
  const raw = String(keyword || '').trim();
  const normalized = normalizeVietnameseText(raw);
  const variants = new Set([raw, normalized]);

  const aliasMap = {
    bup: ['bap', 'bo bap', 'bò bắp', 'bắp'],
    búp: ['bap', 'bo bap', 'bò bắp', 'bắp'],
    bap: ['bo bap', 'bò bắp', 'bắp'],
    'bắp': ['bo bap', 'bò bắp'],
    gau: ['gầu', 'gầu bò', 'gau bo'],
    'gầu': ['gầu bò', 'gau bo'],
    nam: ['nạm'],
    'nạm': ['nam'],
    bon: ['bon'],
    xg: ['xương', 'xuong'],
    xuong: ['xương'],
    'xương': ['xuong'],
    'xuong ong': ['xương ống', 'xg ống', 'xg ong'],
    'xuong suon': ['xương sườn', 'xg sườn', 'xg suon'],
    'xuong uc': ['xương ức', 'xg ức', 'xg uc'],
    'xuong duoi': ['xương đuôi', 'xg đuôi', 'xg duoi'],
    'xuong cui gan': ['xương cùi gân', 'xg cùi gân', 'xg cui gan'],
    'gan pho': ['gân phở', 'gân phô', 'gan phở'],
    'gau nac': ['gầu nạc', 'gau nạc'],
    'gau mo': ['gầu mỡ', 'gau mỡ'],
    xuo: ['xô'],
    xo: ['xô']
  };

  for (const [key, values] of Object.entries(aliasMap)) {
    if (normalized === normalizeVietnameseText(key) || normalized.includes(normalizeVietnameseText(key))) {
      for (const v of values) variants.add(v);
    }
  }

  return Array.from(variants).filter(Boolean);
}

function canonicalProductKey(value) {
  let n = normalizeVietnameseText(String(value || '').trim()).toLowerCase();
  n = n
    .replace(/\bky\b|\bki\b|\bkg\b|\bcan\b/g, ' ')
    .replace(/\bxg\b/g, 'xuong')
    .replace(/\bbop\b|\bbup\b/g, 'bup')
    .replace(/\bgau\b/g, 'gau')
    .replace(/\s+/g, ' ')
    .trim();
  return n;
}

function canonicalProductAliases(keyword) {
  const key = canonicalProductKey(keyword);
  const aliases = {
    'xg ong': ['xg ong', 'xuong ong'],
    'xuong ong': ['xg ong', 'xuong ong'],
    'xg suon': ['xg suon', 'xuong suon'],
    'xuong suon': ['xg suon', 'xuong suon'],
    'xg nac': ['xg nac', 'xuong nac'],
    'xuong nac': ['xg nac', 'xuong nac'],
    'huyet': ['huyet'],
    'luoi': ['luoi'],
    'gan': ['gan bo', 'gan'],
    'long': ['long'],
    'nam': ['nam'],
    'nam mo': ['nam mo'],
    'nap': ['nap'],
    'bon': ['bon'],
    'bup': ['bup', 'bop'],
    'bop': ['bup', 'bop'],
    'dui': ['dui'],
    'suon': ['suon'],
    'deo': ['deo'],
    'lung': ['lung'],
    'vun': ['vun'],
    'bu': ['bu'],
    'ria': ['ria'],
    'gio': ['gio'],
    'xg uc': ['xg uc', 'xuong uc'],
    'xuong uc': ['xg uc', 'xuong uc'],
    'xg duoi': ['xg duoi', 'xuong duoi'],
    'xuong duoi': ['xg duoi', 'xuong duoi'],
    'gan phoi': ['gan phoi'],
    'gan pho': ['gan pho'],
    'mo': ['mo'],
    'xg cui gan': ['xg cui gan', 'xuong cui gan'],
    'xuong cui gan': ['xg cui gan', 'xuong cui gan'],
    'gau nac': ['gau nac'],
    'gau mo': ['gau mo'],
    'dim': ['dim'],
    'ti': ['ti'],
    'so': ['so']
  };
  return Array.from(new Set([key, ...(aliases[key] || [])].filter(Boolean)));
}

async function findExactProductByAlias(customerId, keyword) {
  const keys = canonicalProductAliases(keyword);
  if (keys.length === 0) return null;
  const [rows] = await db.query(`
    SELECT
      p.id,
      p.name,
      p.unit,
      p.stock_quantity,
      p.inventory_mode,
      p.allow_negative_stock,
      COALESCE(cpp.sale_price, p.default_sale_price, 0) AS price,
      poa.alias_text
    FROM product_ocr_aliases poa
    JOIN products p ON p.id = poa.product_id
    LEFT JOIN customer_product_prices cpp
      ON cpp.product_id = p.id
     AND cpp.customer_id = ?
     AND cpp.is_active = 1
     AND (cpp.effective_from IS NULL OR cpp.effective_from <= CURDATE())
     AND (cpp.effective_to IS NULL OR cpp.effective_to >= CURDATE())
    WHERE p.del_flg = 0
      AND p.is_active = 1
      AND (poa.customer_id = ? OR poa.customer_id IS NULL)
      AND LOWER(TRIM(poa.alias_text)) IN (?)
    ORDER BY
      CASE WHEN poa.customer_id = ? THEN 1 ELSE 2 END,
      p.id ASC
  `, [customerId, customerId, keys, customerId]);

  const uniqueProductIds = Array.from(new Set(rows.map((r) => r.id)));
  if (uniqueProductIds.length === 1) return rows[0];
  if (uniqueProductIds.length > 1) {
    throw new Error(`Alias sản phẩm "${keyword}" đang trùng nhiều sản phẩm (${uniqueProductIds.join(', ')}). Vui lòng làm sạch product_ocr_aliases trước khi dùng AI Voice POS.`);
  }
  return null;
}

function mergeDraftItemsByProduct(items) {
  const map = new Map();
  for (const item of items || []) {
    const key = item.product_id || canonicalProductKey(item.product_name || item.input_name);
    if (!key) continue;
    if (!map.has(key)) map.set(key, { ...item });
    else {
      const old = map.get(key);
      old.quantity = normalizeAmount(old.quantity) + normalizeAmount(item.quantity);
      old.amount = normalizeAmount(old.quantity) * normalizeAmount(old.price);
    }
  }
  return Array.from(map.values());
}

function findBestProductVariant(keyword, candidates) {
  const variants = expandProductKeywordVariants(keyword);
  let best = null;

  for (const variant of variants) {
    const match = findBestMatch(
      variant,
      candidates,
      (product) => `${product.name || ''} ${product.alias_text || ''}`,
      20
    );

    if (match && (!best || match.score > best.score)) {
      best = {
        ...match,
        variant
      };
    }
  }

  return best;
}

async function saveProductAlias(conn, customerId, aliasText, productId) {
  const alias = String(aliasText || '').trim().toLowerCase();

  if (!alias || !productId) {
    return;
  }

  const [rows] = await conn.query(`
    SELECT id, hit_count
    FROM product_ocr_aliases
    WHERE customer_id = ?
      AND alias_text = ?
      AND product_id = ?
    LIMIT 1
  `, [
    customerId,
    alias,
    productId
  ]);

  if (rows.length > 0) {
    await conn.query(`
      UPDATE product_ocr_aliases
      SET
        hit_count = COALESCE(hit_count, 0) + 1,
        updated_at = NOW()
      WHERE id = ?
    `, [rows[0].id]);

    return;
  }

  await conn.query(`
    INSERT INTO product_ocr_aliases (
      customer_id,
      alias_text,
      product_id,
      source,
      hit_count,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, 1, NOW(), NOW())
  `, [
    customerId,
    alias,
    productId,
    'AI_CHAT'
  ]);
}

async function findCustomerByName(customerName) {
  const keyword = String(customerName || '').trim();

  if (!keyword) {
    throw new Error('Thiếu tên khách hàng');
  }

  // Fast path: database LIKE
  const [directRows] = await db.query(`
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
    `%${keyword}%`,
    keyword,
    `%${keyword}%`
  ]);

  if (directRows.length > 0) {
    return directRows[0];
  }

  // Production path: dynamic accent-insensitive resolver from DB, no hard-coded customer names.
  const [customers] = await db.query(`
    SELECT
      id,
      name,
      phone,
      billing_calendar_type
    FROM customers
    WHERE del_flg = 0
    ORDER BY id ASC
    LIMIT 5000
  `);

  const best = findBestMatch(
    keyword,
    customers,
    (customer) => customer.name,
    20
  );

  if (!best) {
    throw new Error(`Không tìm thấy khách: ${customerName}`);
  }

  return best.item;
}

async function getFreshCustomer(customer) {
  const [rows] = await db.query(`
    SELECT
      id,
      name,
      phone,
      billing_calendar_type
    FROM customers
    WHERE id = ?
      AND del_flg = 0
    LIMIT 1
  `, [customer.id]);

  if (rows.length > 0) {
    return rows[0];
  }

  return customer;
}

async function findProductForCustomer(customerId, productName) {
  const keyword = String(productName || '').trim();

  if (!keyword) {
    throw new Error('Thiếu tên sản phẩm');
  }

  // Production safety: exact alias/name first. Do not fuzzy-match meat products before exact alias.
  const exactByAlias = await findExactProductByAlias(customerId, keyword);
  if (exactByAlias) return exactByAlias;

  // Fast path: product name / customer alias LIKE
  const [products] = await db.query(`
    SELECT
      p.id,
      p.name,
      p.unit,
      p.stock_quantity,
      p.inventory_mode,
      p.allow_negative_stock,
      COALESCE(cpp.sale_price, p.default_sale_price, 0) AS price,
      poa.alias_text
    FROM products p

    LEFT JOIN product_ocr_aliases poa
      ON poa.product_id = p.id
     AND poa.customer_id = ?

    LEFT JOIN customer_product_prices cpp
      ON cpp.product_id = p.id
     AND cpp.customer_id = ?
     AND cpp.is_active = 1
     AND (
       cpp.effective_from IS NULL
       OR cpp.effective_from <= CURDATE()
     )
     AND (
       cpp.effective_to IS NULL
       OR cpp.effective_to >= CURDATE()
     )

    WHERE p.del_flg = 0
      AND p.is_active = 1
      AND (
        LOWER(p.name) LIKE LOWER(?)
        OR LOWER(poa.alias_text) LIKE LOWER(?)
      )

    ORDER BY
      CASE
        WHEN LOWER(poa.alias_text) = LOWER(?) THEN 1
        WHEN LOWER(p.name) = LOWER(?) THEN 2
        WHEN LOWER(poa.alias_text) LIKE LOWER(?) THEN 3
        WHEN LOWER(p.name) LIKE LOWER(?) THEN 4
        ELSE 5
      END,
      cpp.effective_from DESC,
      cpp.id DESC

    LIMIT 1
  `, [
    customerId,
    customerId,
    `%${keyword}%`,
    `%${keyword}%`,
    keyword,
    keyword,
    `%${keyword}%`,
    `%${keyword}%`
  ]);

  if (products.length > 0) {
    return products[0];
  }

  // Production path: dynamic resolver from all active products + aliases.
  const [candidates] = await db.query(`
    SELECT
      p.id,
      p.name,
      p.unit,
      p.stock_quantity,
      p.inventory_mode,
      p.allow_negative_stock,
      COALESCE(cpp.sale_price, p.default_sale_price, 0) AS price,
      GROUP_CONCAT(DISTINCT poa.alias_text SEPARATOR ' ') AS alias_text
    FROM products p

    LEFT JOIN product_ocr_aliases poa
      ON poa.product_id = p.id
     AND (
       poa.customer_id = ?
       OR poa.customer_id IS NULL
     )

    LEFT JOIN customer_product_prices cpp
      ON cpp.product_id = p.id
     AND cpp.customer_id = ?
     AND cpp.is_active = 1
     AND (
       cpp.effective_from IS NULL
       OR cpp.effective_from <= CURDATE()
     )
     AND (
       cpp.effective_to IS NULL
       OR cpp.effective_to >= CURDATE()
     )

    WHERE p.del_flg = 0
      AND p.is_active = 1

    GROUP BY
      p.id,
      p.name,
      p.unit,
      p.stock_quantity,
      p.inventory_mode,
      p.allow_negative_stock,
      cpp.sale_price

    LIMIT 10000
  `, [
    customerId,
    customerId
  ]);

  const best = findBestProductVariant(keyword, candidates);

  if (!best) {
    throw new Error(`Không tìm thấy sản phẩm: ${productName}`);
  }

  return best.item;
}

async function createOrderDraft(payload) {
  const {
    customer_name,
    items = [],
    cash_amount = 0,
    transfer_amount = 0
  } = payload;

  if (!customer_name) {
    throw new Error('Thiếu customer_name');
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Thiếu items');
  }

  const customer = await findCustomerByName(customer_name);
  const paymentPolicy = customerPolicyService.getCustomerPolicy(customer);

  const draftItems = [];
  let totalAmount = 0;

  for (const item of items) {
    const product = await findProductForCustomer(customer.id, item.product_name);
    const quantity = normalizeAmount(item.quantity);

    if (quantity <= 0) {
      throw new Error(`Số lượng không hợp lệ cho sản phẩm ${item.product_name}`);
    }

    const price = normalizeAmount(item.price || product.price);

    if (price <= 0) {
      throw new Error(
        `Khách ${customer.name} chưa có giá cho sản phẩm ${product.name}`
      );
    }

    const amount = quantity * price;

    draftItems.push({
      product_id: product.id,
      product_name: product.name,
      input_name: item.product_name,
      unit: product.unit,
      quantity,
      price,
      amount,
      stock_quantity: product.stock_quantity,
      inventory_mode: product.inventory_mode,
      allow_negative_stock: product.allow_negative_stock
    });

    totalAmount += amount;
  }

  const mergedDraftItems = mergeDraftItemsByProduct(draftItems);
  totalAmount = mergedDraftItems.reduce((sum, item) => sum + normalizeAmount(item.amount), 0);

  let cashAmount = normalizeAmount(cash_amount);
  let transferAmount = normalizeAmount(transfer_amount);
  const requestedPaidAmount = cashAmount + transferAmount;

  const warnings = [];
  let canConfirm = true;

  if (paymentPolicy.customer_payment_type === 'REGULAR' && requestedPaidAmount > 0) {
    warnings.push('Khách hàng thường: POS chỉ tạo bill công nợ, thu tiền xử lý ở màn Thu tiền. Số tiền nhập trong POS sẽ không ghi nhận ở bill này.');
    cashAmount = 0;
    transferAmount = 0;
  }

  let paidAmount = cashAmount + transferAmount;

  if (paymentPolicy.customer_payment_type === 'WALK_IN' && paidAmount < totalAmount) {
    canConfirm = false;
    warnings.push('Khách vãng lai phải thu đủ tiền ngay trước khi lưu bill.');
  }

  const debtAmount = totalAmount - paidAmount;

  return {
    draft_id: `DRAFT_${Date.now()}`,
    status: 'DRAFT',
    customer,
    customer_payment_type: paymentPolicy.customer_payment_type,
    payment_policy: paymentPolicy,
    items: mergedDraftItems,
    total_amount: totalAmount,
    cash_amount: cashAmount,
    transfer_amount: transferAmount,
    requested_paid_amount: requestedPaidAmount,
    paid_amount: paidAmount,
    debt_amount: debtAmount > 0 ? debtAmount : 0,
    change_amount: paidAmount > totalAmount ? paidAmount - totalAmount : 0,
    can_confirm: canConfirm,
    requires_payment: paymentPolicy.customer_payment_type === 'WALK_IN' && paidAmount < totalAmount,
    warnings,
    message: paymentPolicy.customer_payment_type === 'WALK_IN'
      ? 'Khách vãng lai: bill nháp cần thu tiền ngay trước khi lưu.'
      : 'Khách hàng thường: bill nháp công nợ, thu tiền xử lý ở màn Thu tiền.'
  };
}

async function confirmOrderDraft(payload) {
  const {
    customer: inputCustomer,
    items = [],
    total_amount = 0,
    cash_amount = 0,
    transfer_amount = 0,
    paid_amount = 0,
    debt_amount = 0,
    note = 'Tạo từ AI'
  } = payload;

  if (!inputCustomer || !inputCustomer.id) {
    throw new Error('Thiếu customer.id');
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Thiếu items');
  }

  const customer = await getFreshCustomer(inputCustomer);
  const paymentPolicy = customerPolicyService.getCustomerPolicy(customer);
  const orderDate = todayYmd();
  const calendarType = normalizeCalendarType(customer.billing_calendar_type);
  const lunarDateText = calendarType === 'LUNAR'
    ? toLunarDateText(orderDate)
    : null;

  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    await inventoryService.validateOrderInventory(conn, items);

    const orderCode = `AI${Date.now()}`;
    const totalAmount = normalizeAmount(total_amount);
    let cashAmount = normalizeAmount(cash_amount);
    let bankAmount = normalizeAmount(transfer_amount);

    if (paymentPolicy.customer_payment_type === 'REGULAR') {
      // Business rule: regular customers receive a debt bill first.
      // Payments must be recorded later through Payment/Collection flow.
      cashAmount = 0;
      bankAmount = 0;
    }

    const paidAmount = cashAmount + bankAmount;

    if (paymentPolicy.customer_payment_type === 'WALK_IN' && paidAmount < totalAmount) {
      throw new Error('Khách vãng lai phải thu đủ tiền ngay trước khi lưu bill.');
    }

    const debtAmount = Math.max(0, totalAmount - paidAmount);

    const paymentStatus =
      debtAmount > 0
        ? (paidAmount > 0 ? 'PARTIAL' : 'UNPAID')
        : 'PAID';

    const [orderResult] = await conn.query(`
      INSERT INTO orders (
        order_code,
        customer_id,
        order_date,
        status,
        payment_status,
        total_amount,
        paid_amount,
        debt_amount,
        current_bill_amount,
        installment_amount,
        private_token,
        note,
        created_at,
        updated_at,
        del_flg,
        calendar_type,
        lunar_date_text
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 0, ?, ?
      )
    `, [
      orderCode,
      customer.id,
      orderDate,
      'CONFIRMED',
      paymentStatus,
      totalAmount,
      paidAmount,
      debtAmount,
      totalAmount,
      0,
      nanoid(24),
      note,
      calendarType,
      lunarDateText
    ]);

    const orderId = orderResult.insertId;

    for (const item of items) {
      await conn.query(`
        INSERT INTO order_items (
          order_id,
          product_id,
          product_name,
          unit,
          quantity,
          sale_price,
          total_price,
          price_type,
          note,
          inventory_mode,
          stock_checked
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        orderId,
        item.product_id,
        item.product_name,
        item.unit,
        item.quantity,
        item.price,
        item.amount,
        'PRIVATE_PRICE',
        null,
        null,
        0
      ]);

      await saveProductAlias(
        conn,
        customer.id,
        item.input_name || item.product_name,
        item.product_id
      );
    }

    const inventoryResults = await inventoryService.applyOrderInventory(
      conn,
      orderId,
      items,
      {
        user_id: null,
        order_date: orderDate
      }
    );

    if (debtAmount > 0) {
      await conn.query(`
        INSERT INTO debt_transactions (
          customer_id,
          order_id,
          transaction_date,
          type,
          amount,
          note,
          created_by
        ) VALUES (?, ?, ?, 'SALE', ?, ?, ?)
      `, [
        customer.id,
        orderId,
        orderDate,
        debtAmount,
        `Công nợ bill ${orderCode}`,
        null
      ]);
    }

    if (paidAmount > 0) {
      const paymentCode = `PAY${Date.now()}`;
      const paymentMethod = cashAmount > 0 && bankAmount > 0
        ? 'MIXED'
        : cashAmount > 0
          ? 'CASH'
          : 'BANK_TRANSFER';

      const [paymentResult] = await conn.query(`
        INSERT INTO payments (
          payment_code,
          customer_id,
          order_id,
          payment_date,
          amount,
          payment_method,
          note,
          created_at,
          cash_amount,
          bank_amount,
          current_bill_amount,
          installment_amount,
          monthly_installment_id,
          payment_calendar_type,
          payment_lunar_date_text
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?
        )
      `, [
        paymentCode,
        customer.id,
        orderId,
        orderDate,
        paidAmount,
        paymentMethod,
        'Thanh toán từ AI bill',
        cashAmount,
        bankAmount,
        totalAmount,
        0,
        null,
        calendarType,
        lunarDateText
      ]);

      await conn.query(`
        INSERT INTO debt_transactions (
          customer_id,
          order_id,
          payment_id,
          transaction_date,
          type,
          amount,
          note,
          created_by
        ) VALUES (?, ?, ?, ?, 'PAYMENT', ?, ?, ?)
      `, [
        customer.id,
        orderId,
        paymentResult.insertId,
        orderDate,
        paidAmount,
        `Thanh toán bill ${orderCode}`,
        null
      ]);
    }

    await conn.commit();

    return {
      order_id: orderId,
      order_code: orderCode,
      order_date: orderDate,
      calendar_type: calendarType,
      lunar_date_text: lunarDateText,
      total_amount: totalAmount,
      paid_amount: paidAmount,
      debt_amount: debtAmount,
      customer_payment_type: paymentPolicy.customer_payment_type,
      inventory_results: inventoryResults,
      message: 'Đã lưu bill thành công.'
    };

  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}


async function createRepeatOrderDraft(customerName, options = {}) {
  if (!customerName) {
    throw new Error('Thiếu tên khách để lặp lại bill');
  }

  const customer = await findCustomerByName(customerName);
  const limitDays = Number(options.limit_days || 30);

  const [orders] = await db.query(`
    SELECT
      id,
      order_code,
      order_date,
      calendar_type,
      lunar_date_text,
      total_amount
    FROM orders
    WHERE del_flg = 0
      AND customer_id = ?
      AND order_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
    ORDER BY order_date DESC, id DESC
    LIMIT 1
  `, [
    customer.id,
    limitDays
  ]);

  if (orders.length === 0) {
    throw new Error(`Không tìm thấy bill gần đây của khách ${customer.name}`);
  }

  const sourceOrder = orders[0];

  const [items] = await db.query(`
    SELECT
      product_id,
      product_name,
      unit,
      quantity,
      sale_price
    FROM order_items
    WHERE order_id = ?
    ORDER BY id ASC
  `, [sourceOrder.id]);

  if (items.length === 0) {
    throw new Error(`Bill ${sourceOrder.order_code} không có dòng hàng để lặp lại`);
  }

  const draft = await createOrderDraft({
    customer_name: customer.name,
    items: items.map((item) => ({
      product_name: item.product_name,
      quantity: item.quantity,
      unit_input: item.unit || 'kg'
    })),
    cash_amount: 0,
    transfer_amount: 0
  });

  return {
    source_order: sourceOrder,
    draft,
    message: `Đã tạo bill nháp theo bill gần nhất ${sourceOrder.order_code}.`
  };
}

module.exports = {

  createOrderDraft,
  createRepeatOrderDraft,
  confirmOrderDraft
};
