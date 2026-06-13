const aiSessionService = require('./aiSession.service');
const orderService = require('./order.service');
const aiPaymentService = require('./aiPayment.service');
const aiInsightService = require('./aiInsight.service');
const aiNluService = require('./aiNlu.service');
const aiInventoryInsightService = require('./aiInventoryInsight.service');
const aiInventoryPredictionService = require('./aiInventoryPrediction.service');
const aiSupplierOrderingService = require('./aiSupplierOrdering.service');

function sanitizeSpeechText(text) {
  return String(text || '')
    // sửa một số lỗi encoding hay gặp khi gõ tiếng Việt qua terminal/mobile
    .replace(/ch介/gi, 'chi')
    .replace(/hi仁n/gi, 'hien')
    .replace(/l亥y/gi, 'lay')
    .replace(/v仛i/gi, 'voi')
    .replace(/n产m/gi, 'nam')
    .replace(/m仙t/gi, 'mot')
    .replace(/r仓i/gi, 'roi')
    .replace(/tr亣/gi, 'tra')
    .replace(/亣/g, 'a')
    // chuẩn hóa vài từ thường gặp để fallback parser hiểu tốt hơn
    .replace(/\bchị\b/gi, 'chi')
    .replace(/\bcô\b/gi, 'co')
    .replace(/\bchú\b/gi, 'chu')
    .replace(/\bbác\b/gi, 'bac')
    .replace(/\blấy\b/gi, 'lay')
    .replace(/\bthêm\b/gi, 'them')
    .replace(/\bvới\b/gi, 'voi')
    .replace(/\bnầm\b/gi, 'nam mo')
    .replace(/\bnấp\b/gi, 'nap')
    .replace(/\bgầu\b/gi, 'gau')
    .replace(/\bxg\b/gi, 'xuong')
    .replace(/\bxương\b/gi, 'xuong')
    .replace(/\bbúp\b/gi, 'bup')
    .replace(/\bbóp\b/gi, 'bup')
    .replace(/\bbop\b/gi, 'bup')
    .replace(/\blộn\b/gi, 'lon')
    .replace(/\bnhầm\b/gi, 'nham')
    .replace(/\bbắp\b/gi, 'bap')
    .replace(/\bnạm\b/gi, 'nam')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeText(text) {
  return sanitizeSpeechText(text)
    .trim()
    .toLowerCase()
    .replace(/ký/g, 'kg')
    .replace(/kí/g, 'kg')
    .replace(/\bky\b/g, 'kg')
    .replace(/\bki\b/g, 'kg')
    .replace(/\bbop\b/g, 'bup')
    .replace(/\bboop\b/g, 'bup')
    .replace(/như/g, 'nhu')
    .replace(/hôm/g, 'hom')
    .replace(/bữa/g, 'bua')
    .replace(/trước/g, 'truoc')
    .replace(/lặp/g, 'lap')
    .replace(/gần/g, 'gan')
    .replace(/nhất/g, 'nhat')
    .replace(/ngàn/g, '000')
    .replace(/nghin/g, '000')
    .replace(/nghìn/g, '000');
}


function isInventoryPredictionMessage(message) {
  const text = normalizeText(message)
    .replace(/dự/g, 'du')
    .replace(/báo/g, 'bao')
    .replace(/tuần/g, 'tuan')
    .replace(/tới/g, 'toi')
    .replace(/thiếu/g, 'thieu')
    .replace(/đủ/g, 'du')
    .replace(/hàng/g, 'hang');

  return (
    text.includes('du bao ton kho') ||
    text.includes('du bao hang') ||
    text.includes('tuan toi thieu hang') ||
    text.includes('7 ngay toi') ||
    text.includes('hang nao sap het') ||
    text.includes('con du khong')
  );
}

function isSupplierSuggestionMessage(message) {
  const text = normalizeText(message)
    .replace(/nên/g, 'nen')
    .replace(/nhập/g, 'nhap')
    .replace(/hàng/g, 'hang')
    .replace(/tuần/g, 'tuan')
    .replace(/tới/g, 'toi')
    .replace(/đề/g, 'de')
    .replace(/xuất/g, 'xuat')
    .replace(/đặt/g, 'dat')
    .replace(/nhà/g, 'nha')
    .replace(/cung cấp/g, 'cung cap')
    .replace(/mai/g, 'mai');

  return (
    text.includes('nen nhap') ||
    text.includes('nhap hang gi') ||
    text.includes('de xuat nhap') ||
    text.includes('de xuat dat') ||
    text.includes('dat nha cung cap') ||
    text.includes('supplier') ||
    text.includes('mua them hang') ||
    text.includes('mai nhap gi') ||
    text.includes('tuan toi nhap gi')
  );
}

function extractPlanningDays(message) {
  const text = normalizeText(message);
  if (text.includes('tuan toi') || text.includes('tuần tới')) return 7;
  if (text.includes('ngay mai') || text.includes('mai')) return 1;
  const m = text.match(/(\d+)\s*(ngay|ngày)/i);
  return m ? Number(m[1]) : 7;
}

function parseMoney(text) {
  const match = text.match(/(?:trả|tra|tr亣|tm|tiền mặt|tien mat)\s*([0-9.,]+)\s*(k|ngàn|nghìn|tr|triệu)?/i);

  if (!match) {
    const fallback = text.match(/([0-9.,]+)\s*(k|ngàn|nghìn|tr|triệu)\s*$/i);
    if (!fallback) return 0;

    let num = Number(fallback[1].replace(/[.,]/g, ''));
    const unit = fallback[2].toLowerCase();

    if (unit === 'k' || unit === 'ngàn' || unit === 'nghìn') num *= 1000;
    if (unit === 'tr' || unit === 'triệu') num *= 1000000;

    return num;
  }

  let num = Number(match[1].replace(/[.,]/g, ''));

  if (match[2]) {
    const unit = match[2].toLowerCase();
    if (unit === 'k' || unit === 'ngàn' || unit === 'nghìn') num *= 1000;
    if (unit === 'tr' || unit === 'triệu') num *= 1000000;
  }

  return num;
}


function hasAmbiguousQuantity(message) {
  const text = normalizeText(message);

  return (
    /\bit\s+[a-zA-ZÀ-ỹ0-9]+/i.test(text) ||
    /\bmot\s+it\s+[a-zA-ZÀ-ỹ0-9]+/i.test(text) ||
    /\bmột\s+ít\s+[a-zA-ZÀ-ỹ0-9]+/i.test(text)
  );
}

function buildClarificationResponse(message, err) {
  const text = normalizeText(message);

  let productName = null;

  const vagueMatch =
    text.match(/\b(?:it|mot it|một ít)\s+([a-zA-ZÀ-ỹ0-9]+)/i);

  if (vagueMatch && vagueMatch[1]) {
    productName = vagueMatch[1];
  }

  return {
    intent: 'NEED_CLARIFICATION',
    reason: err ? err.message : 'Chưa đủ thông tin để tạo bill',
    message: productName
      ? `Món ${productName} là bao nhiêu kg? Ví dụ: ${productName} 1kg hoặc ${productName} 2kg.`
      : 'AI chưa hiểu đủ thông tin để lập bill. Khách thường cần có tên khách, ví dụ: Hồng Hiền 5 ký bắp 2 ký gầu. Khách vãng lai có thể nói: khách vãng lai 2 ký gầu tiền mặt.',
    original_message: message,
    requires_confirm: false
  };
}


function normalizeVoiceBillLines(message) {
  return String(message || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\b(thêm|them)\b/gi, ' ')
    .replace(/\b(đổi|doi)\b/gi, ' ')
    .replace(/\b(xoá|xóa|xoa|bỏ|bo)\s+[a-zA-ZÀ-ỹ0-9\s]+/gi, ' ')
    .replace(/\b(xong|kết thúc|ket thuc|done)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitVoiceOrderLines(message) {
  return String(message || '')
    .replace(/[;,，。]+/g, '\n')
    .split(/\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function cleanProductPhrase(value) {
  return normalizeText(value)
    .replace(/\b(kg|ky|ki|ký|kí|can|cân)\b/g, ' ')
    .replace(/\b(lay|them|mua|voi|va|cho|xong|huy|doi|xoa|luu|ok)\b/g, ' ')
    .replace(/\b(khach thuong|khach quen|regular|khach vang lai|vang lai|walk in|walkin)\b/g, ' ')
    .replace(/\b(chi|anh|co|chu|bac)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseItemFromLine(line) {
  const n = normalizeText(line);
  // product first: "nam 10 kg", "xuong ong 10 ky"
  let m = n.match(/^(.+?)\s+([0-9]+(?:[.,][0-9]+)?)\s*(?:kg|ky|ki|ký|kí|can|cân)?\s*$/i);
  if (m) {
    const productName = cleanProductPhrase(m[1]);
    const quantity = Number(String(m[2]).replace(',', '.'));
    if (productName && quantity > 0) return { product_name: productName, quantity, unit_input: 'kg' };
  }
  // quantity first: "10 kg nam", "10 nam"
  m = n.match(/^([0-9]+(?:[.,][0-9]+)?)\s*(?:kg|ky|ki|ký|kí|can|cân)?\s+(.+?)\s*$/i);
  if (m) {
    const productName = cleanProductPhrase(m[2]);
    const quantity = Number(String(m[1]).replace(',', '.'));
    if (productName && quantity > 0) return { product_name: productName, quantity, unit_input: 'kg' };
  }
  return null;
}

function mergeParsedItems(items) {
  const map = new Map();
  for (const item of items || []) {
    const key = normalizeText(item.product_name || '').replace(/\s+/g, ' ').trim();
    if (!key) continue;
    if (!map.has(key)) map.set(key, { ...item, quantity: Number(item.quantity || 0) });
    else map.get(key).quantity += Number(item.quantity || 0);
  }
  return Array.from(map.values()).filter((x) => x.quantity > 0);
}

function parseSimpleBill(message, options = {}) {
  const originalMessage = String(message || '');
  const selectedCustomerType = String(options.customer_type || '').toUpperCase();
  const lines = splitVoiceOrderLines(originalMessage);
  const normalizedWhole = normalizeText(normalizeVoiceBillLines(originalMessage));

  // If the first line has no quantity, treat it as customer name and parse items only from following lines.
  const firstLineNormForCustomer = lines.length > 1 ? normalizeText(lines[0]) : '';
  const firstLineIsCustomerOnly = Boolean(firstLineNormForCustomer && !parseItemFromLine(firstLineNormForCustomer));

  const firstItemMatch = normalizedWhole.match(/[0-9]+(?:[.,][0-9]+)?\s*(kg|ky|ký|kí|ki|can|cân)?/i);
  if (!firstItemMatch) {
    throw new Error('Không tìm thấy sản phẩm/số lượng để tạo bill');
  }

  let customerName = firstLineIsCustomerOnly
    ? firstLineNormForCustomer.replace(/^(chi|anh|co|chu|bac)\s+/i, '').trim()
    : normalizedWhole
      .substring(0, firstItemMatch.index)
      .trim()
      .replace(/\b(khach thuong|khach quen|regular|khach vang lai|vang lai|walk in|walkin)\b/gi, '')
      .replace(/\b(lay|them|mua|voi|cho)\b.*$/i, '')
      .replace(/^(chi|anh|co|chu|bac)\s+/i, '')
      .trim();

  if (!customerName && selectedCustomerType === 'WALK_IN') {
    customerName = 'Khách vãng lai';
  }

  if (!customerName) {
    throw new Error('Thiếu tên khách. Khách thường cần chọn hoặc nhập tên khách, ví dụ: Hồng Hiền 5 ký bắp 2 ký gầu.');
  }

  const items = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (firstLineIsCustomerOnly && lineIndex === 0) continue;
    const line = lines[lineIndex];
    const n = normalizeText(line);
    if (!n || n === customerName) continue;
    const parsedLine = parseItemFromLine(n);
    if (parsedLine) items.push(parsedLine);
  }

  if (items.length === 0) {
    const cleanText = normalizedWhole
      .replace(/(trả|tra|tm|tien mat|ck|chuyen khoan|bank).*$/i, '')
      .trim();
    const itemsText = cleanText.substring(firstItemMatch.index).trim();
    const itemRegex = /([0-9]+(?:[.,][0-9]+)?)\s*(kg|ky|ký|kí|ki|can|cân)?\s+([a-zA-ZÀ-ỹ0-9][a-zA-ZÀ-ỹ0-9\s]*?)(?=\s+[0-9]+(?:[.,][0-9]+)?\s*(?:kg|ky|ký|kí|ki|can|cân)?\s+|$)/gi;
    let match;
    while ((match = itemRegex.exec(itemsText)) !== null) {
      const productName = cleanProductPhrase(match[3]);
      if (productName) {
        items.push({
          product_name: productName,
          quantity: Number(match[1].replace(',', '.')),
          unit_input: 'kg'
        });
      }
    }
  }

  const mergedItems = mergeParsedItems(items);
  if (mergedItems.length === 0) {
    throw new Error('Không tìm thấy item');
  }

  const cashAmount = parseMoney(normalizedWhole);
  const isBank = /\b(ck|chuyen khoan|bank)\b/i.test(normalizedWhole);

  return {
    customer_name: customerName,
    items: mergedItems,
    cash_amount: isBank ? 0 : cashAmount,
    transfer_amount: isBank ? cashAmount : 0,
    raw_message: originalMessage,
    parsed_items_debug: mergedItems
  };
}

function isConfirmMessage(message) {
  const text = String(message || '')
    .trim()
    .toLowerCase();

  const keywords = [
    'ok',
    'ok lưu',
    'ok thu',
    'xác nhận',
    'xac nhan',
    'lưu bill',
    'luu bill',
    'lưu',
    'luu',
    'đồng ý',
    'dong y'
  ];

  return keywords.includes(text);
}

function isCancelMessage(message) {
  const text = String(message || '')
    .trim()
    .toLowerCase();

  const keywords = [
    'hủy',
    'huy',
    'bỏ',
    'bo',
    'không lưu',
    'khong luu',
    'cancel'
  ];

  return keywords.includes(text);
}


function isEditOrderDraftMessage(message) {
  const text = normalizeText(message);

  return (
    /^(thêm|them)\s+/i.test(text) ||
    /^(bỏ|bo|xóa|xoa)\s+/i.test(text) ||
    /^(đổi|doi|sửa|sua)\s+/i.test(text) ||
    /^(nham roi|lon roi|noi nham|doc nham)/i.test(text)
  );
}

function parseEditOrderDraftMessage(message) {
  const text = normalizeText(message);

  if (/^(xoa|xóa|xoá|bo|bỏ)\s+(tat ca|het|all|het tat ca)/i.test(text)) {
    return { action: 'CLEAR_ALL' };
  }

  if (/^(xoa dong cuoi|xoa mon vua noi|xoa cai vua noi|nham roi|lon roi|noi nham|doc nham)/i.test(text)) {
    return { action: 'REMOVE_LAST' };
  }

  const addMatch = text.match(/^(thêm|them)\s+([0-9]+(?:[.,][0-9]+)?)\s*(kg)?\s+([a-zA-ZÀ-ỹ0-9\s]+)/i);
  if (addMatch) {
    return {
      action: 'ADD_ITEM',
      item: {
        product_name: addMatch[4].trim(),
        quantity: Number(addMatch[2].replace(',', '.')),
        unit_input: addMatch[3] || 'kg'
      }
    };
  }

  const removeMatch = text.match(/^(bỏ|bo|xóa|xoa|xoá)\s+([a-zA-ZÀ-ỹ0-9\s]+)/i);
  if (removeMatch) {
    return {
      action: 'REMOVE_ITEM',
      product_name: removeMatch[2]
        .replace(/\b(di|nhe|nha|giup|cho|minh)\b/g, '')
        .trim()
    };
  }

  const changeQtyMatch = text.match(/^(đổi|doi|sửa|sua)\s+([a-zA-ZÀ-ỹ0-9\s]+?)\s+(thành|thanh|=)?\s*([0-9]+(?:[.,][0-9]+)?)\s*(kg)?$/i);
  if (changeQtyMatch) {
    return {
      action: 'CHANGE_QTY',
      product_name: changeQtyMatch[2].trim(),
      quantity: Number(changeQtyMatch[4].replace(',', '.')),
      unit_input: changeQtyMatch[5] || 'kg'
    };
  }

  throw new Error('Chưa hiểu lệnh sửa bill. Ví dụ: thêm 1 Gầu, bỏ Bon, đổi Bon 3, xóa dòng cuối, xóa tất cả');
}

function findDraftItemIndex(draft, productName) {
  const keyword = normalizeText(productName)
    .replace(/\b(di|nhe|nha|giup|cho|minh)\b/g, '')
    .trim();

  return draft.items.findIndex((item) => {
    const p = normalizeText(item.product_name || '');
    const input = normalizeText(item.input_name || '');
    return (
      p === keyword ||
      input === keyword ||
      p.includes(keyword) ||
      input.includes(keyword) ||
      keyword.includes(p) ||
      keyword.includes(input)
    );
  });
}

async function rebuildOrderDraftFromItems(customer, items, cashAmount = 0, transferAmount = 0) {
  return orderService.createOrderDraft({
    customer_name: customer.name,
    items: items.map((item) => ({
      product_name: item.input_name || item.product_name,
      quantity: item.quantity,
      unit_input: item.unit_input || item.unit || 'kg'
    })),
    cash_amount: cashAmount,
    transfer_amount: transferAmount
  });
}

async function editLatestOrderDraft(sessionId, message) {
  const latestSession = await aiSessionService.getLatestDraftSession(sessionId);

  if (!latestSession) {
    throw new Error('Không có bill nháp để sửa');
  }

  const draft = latestSession.draft_json;
  const edit = parseEditOrderDraftMessage(message);

  let nextItems = [...draft.items];

  if (edit.action === 'CLEAR_ALL') {
    await aiSessionService.markSessionCancelled(latestSession.id);
    return {
      intent: 'CLEAR_ORDER_DRAFT',
      message: 'Đã xoá tất cả món trong bill nháp.'
    };
  }

  if (edit.action === 'ADD_ITEM') {
    nextItems.push(edit.item);
  }

  if (edit.action === 'REMOVE_LAST') {
    nextItems.pop();
  }

  if (edit.action === 'REMOVE_ITEM') {
    const index = findDraftItemIndex(draft, edit.product_name);

    if (index < 0) {
      throw new Error(`Không tìm thấy món để bỏ: ${edit.product_name}`);
    }

    nextItems.splice(index, 1);
  }

  if (edit.action === 'CHANGE_QTY') {
    const index = findDraftItemIndex(draft, edit.product_name);

    if (index < 0) {
      throw new Error(`Không tìm thấy món để đổi số lượng: ${edit.product_name}`);
    }

    nextItems[index] = {
      ...nextItems[index],
      quantity: edit.quantity,
      unit_input: edit.unit_input || nextItems[index].unit_input || 'kg'
    };
  }

  if (nextItems.length === 0) {
    await aiSessionService.markSessionCancelled(latestSession.id);

    return {
      intent: 'EDIT_ORDER_DRAFT_EMPTY',
      message: 'Bill nháp đã hết món, mình đã hủy nháp này.'
    };
  }

  const newDraft = await rebuildOrderDraftFromItems(
    draft.customer,
    nextItems,
    draft.cash_amount || 0,
    draft.transfer_amount || 0
  );

  await aiSessionService.updateDraftSession(
    latestSession.id,
    newDraft
  );

  return {
    intent: edit.action,
    edit,
    draft: newDraft,
    requires_confirm: true,
    confirm_message: 'Xác nhận lưu bill?'
  };
}



function isRepeatOrderMessage(message) {
  const text = normalizeText(message);

  return (
    text.includes('nhu hom qua') ||
    text.includes('nhu bua truoc') ||
    text.includes('nhu lan truoc') ||
    text.includes('lap lai') ||
    text.includes('bill gan nhat') ||
    text.includes('lay nhu')
  );
}

function parseRepeatOrderMessage(message) {
  const text = normalizeText(message);

  let customerName = text
    .replace(/(lay)?\s*(nhu hom qua|nhu bua truoc|nhu lan truoc|lap lai|bill gan nhat|lay nhu).*$/i, '')
    .replace(/^(chi|anh|co|chu|bac)\s+/i, '')
    .trim();

  if (!customerName) {
    const match = text.match(/(?:cua)\s+([a-zA-ZÀ-ỹ0-9\s]+)$/i);
    customerName = match && match[1] ? match[1].trim() : '';
  }

  if (!customerName) {
    throw new Error('Thiếu tên khách để lặp lại bill. Ví dụ: tên khách lấy như hôm qua');
  }

  return {
    customer_name: customerName
  };
}

async function handleRepeatOrderMessage(sessionId, message, options = {}) {
  const parsed = parseRepeatOrderMessage(message);

  const result = await orderService.createRepeatOrderDraft(
    parsed.customer_name
  );

  const draft = result.draft;

  const draftSessionId = await aiSessionService.saveDraftSession(
    sessionId,
    draft.customer.id,
    draft
  );

  if (options.confirm === true) {
    const confirmed = await orderService.confirmOrderDraft(draft);
    await aiSessionService.markSessionConfirmed(draftSessionId);

    return {
      intent: 'REPEAT_ORDER_AND_CONFIRM',
      parsed,
      source_order: result.source_order,
      draft,
      confirmed
    };
  }

  return {
    intent: 'REPEAT_ORDER_DRAFT',
    parsed,
    source_order: result.source_order,
    draft,
    requires_confirm: true,
    confirm_message: 'Xác nhận lưu bill lặp lại?'
  };
}


function hasOrderItems(message) {
  return /[0-9]+(?:[.,][0-9]+)?\s*(kg|ký|kí)?\s+[a-zA-ZÀ-ỹ0-9]+/i.test(
    normalizeText(message)
  );
}


function nluToOrderPayload(nlu) {
  return {
    customer_name: nlu.customer_name,
    items: nlu.items || [],
    cash_amount: nlu.payment && nlu.payment.method === 'CASH'
      ? Number(nlu.payment.amount || 0)
      : 0,
    transfer_amount: nlu.payment && nlu.payment.method === 'BANK_TRANSFER'
      ? Number(nlu.payment.amount || 0)
      : 0
  };
}

function nluToEditMessage(nlu) {
  const intent = String(nlu.intent || '').toUpperCase();

  if (intent === 'ADD_ITEM') {
    const item = (nlu.items && nlu.items[0]) || {};
    return `thêm ${item.quantity || 0} ${item.product_name || ''}`;
  }

  if (intent === 'REMOVE_ITEM') {
    const productName =
      nlu.edit?.product_name ||
      (nlu.items && nlu.items[0] && nlu.items[0].product_name) ||
      '';

    return `bỏ ${productName}`;
  }

  if (intent === 'CHANGE_QTY') {
    const productName =
      nlu.edit?.product_name ||
      (nlu.items && nlu.items[0] && nlu.items[0].product_name) ||
      '';

    const quantity =
      nlu.edit?.quantity ||
      (nlu.items && nlu.items[0] && nlu.items[0].quantity) ||
      0;

    return `đổi ${productName} ${quantity}`;
  }

  return null;
}

function nluToPaymentMessage(nlu) {
  const amount = Number(nlu.payment?.amount || 0);
  const method = String(nlu.payment?.method || 'CASH').toUpperCase();
  const customerName = nlu.customer_name || '';

  if (!customerName || amount <= 0) {
    return null;
  }

  const amountText = String(amount);
  if (method === 'BANK_TRANSFER') {
    return `${customerName} ck ${amountText}`;
  }

  return `${customerName} trả ${amountText}`;
}

async function handleNluIntent(message, options, sessionId) {
  const nlu = await aiNluService.extractIntent(message, {
    session_id: sessionId
  });

  if (!nlu || nlu.confidence < 0.55 || nlu.intent === 'UNKNOWN') {
    return null;
  }

  if (nlu.intent === 'CONFIRM') {
    return handleChat('ok lưu', options);
  }

  if (nlu.intent === 'CANCEL') {
    return handleChat('hủy', options);
  }

  if (['ADD_ITEM', 'REMOVE_ITEM', 'CHANGE_QTY'].includes(nlu.intent)) {
    const editMessage = nluToEditMessage(nlu);
    if (!editMessage) return null;

    const result = await editLatestOrderDraft(sessionId, editMessage);
    result.nlu = nlu;
    return result;
  }

  if (nlu.intent === 'REPEAT_ORDER') {
    if (!nlu.customer_name) return null;

    const result = await orderService.createRepeatOrderDraft(
      nlu.customer_name
    );

    const draft = result.draft;

    const draftSessionId = await aiSessionService.saveDraftSession(
      sessionId,
      draft.customer.id,
      draft
    );

    if (options.confirm === true) {
      const confirmed = await orderService.confirmOrderDraft(draft);
      await aiSessionService.markSessionConfirmed(draftSessionId);

      return {
        intent: 'REPEAT_ORDER_AND_CONFIRM',
        source: 'LLM_NLU',
        nlu,
        source_order: result.source_order,
        draft,
        confirmed
      };
    }

    return {
      intent: 'REPEAT_ORDER_DRAFT',
      source: 'LLM_NLU',
      nlu,
      source_order: result.source_order,
      draft,
      requires_confirm: true,
      confirm_message: 'Xác nhận lưu bill lặp lại?'
    };
  }

  if (nlu.intent === 'CREATE_ORDER') {
    const draftPayload = nluToOrderPayload(nlu);

    if (!draftPayload.customer_name || draftPayload.items.length === 0) {
      return null;
    }

    const draft = await orderService.createOrderDraft(draftPayload);

    await aiSessionService.cancelOpenOrderDrafts(sessionId);

    const draftSessionId = await aiSessionService.saveDraftSession(
      sessionId,
      draft.customer.id,
      draft
    );

    if (options.confirm === true) {
      const confirmed = await orderService.confirmOrderDraft(draft);
      await aiSessionService.markSessionConfirmed(draftSessionId);

      return {
        intent: 'CREATE_ORDER_AND_CONFIRM',
        source: 'LLM_NLU',
        nlu,
        parsed: draftPayload,
        draft,
        confirmed
      };
    }

    return {
      intent: 'CREATE_ORDER_DRAFT',
      source: 'LLM_NLU',
      nlu,
      parsed: draftPayload,
      draft,
      requires_confirm: true,
      confirm_message: 'Xác nhận lưu bill?'
    };
  }

  if (nlu.intent === 'CREATE_PAYMENT') {
    const paymentMessage = nluToPaymentMessage(nlu);
    if (!paymentMessage) return null;

    const preview = await aiPaymentService.previewPayment(paymentMessage);

    const paymentSessionId = await aiSessionService.savePaymentSession(
      sessionId,
      preview.customer.id,
      preview
    );

    if (options.confirm === true) {
      const confirmed = await aiPaymentService.confirmPaymentFromPreview(
        preview,
        { id: null, role: 'ADMIN' }
      );

      await aiSessionService.markSessionConfirmed(paymentSessionId);

      return {
        intent: 'PAYMENT_AND_CONFIRM',
        source: 'LLM_NLU',
        nlu,
        preview,
        confirmed
      };
    }

    preview.source = 'LLM_NLU';
    preview.nlu = nlu;
    return preview;
  }

  if (nlu.intent === 'INVENTORY_PREDICTION') {
    const result = await aiInventoryPredictionService.getInventoryPrediction({ forecast_days: 7, lookback_days: 14 });
    result.source = 'LLM_NLU';
    result.nlu = nlu;
    return result;
  }

  if (nlu.intent === 'SUPPLIER_ORDER_SUGGESTION') {
    const draft = await aiSupplierOrderingService.buildSupplierOrderDraft({ forecast_days: 7, safety_days: 3, lookback_days: 14 });
    const draftSessionId = await aiSessionService.saveSupplierOrderSession(sessionId, draft);
    draft.source = 'LLM_NLU';
    draft.nlu = nlu;
    draft.draft_session_id = draftSessionId;
    return draft;
  }

  if (nlu.intent === 'INVENTORY_CHECK' || nlu.intent === 'LOW_STOCK_ALERT') {
    const result = await aiInventoryInsightService.handleInventoryInsight(message);
    result.source = 'LLM_NLU';
    result.nlu = nlu;
    return result;
  }

  if (nlu.intent === 'BUSINESS_INSIGHT') {
    const result = await aiInsightService.handleInsight(message);
    result.source = 'LLM_NLU';
    result.nlu = nlu;
    return result;
  }

  return null;
}


async function handleChat(message, options = {}) {
  const sessionId = options.session_id || 'DEFAULT';

  if (!message) {
    throw new Error('Thiếu message');
  }

  message = sanitizeSpeechText(message);

  // Deterministic business-operation intents must run before order parser/NLU fallback.
  // This prevents phrases like "nên nhập hàng gì tuần tới" from being parsed as a bill.
  if (isSupplierSuggestionMessage(message)) {
    const forecastDays = extractPlanningDays(message);
    const draft = await aiSupplierOrderingService.buildSupplierOrderDraft({
      forecast_days: forecastDays,
      safety_days: 3,
      lookback_days: 14
    });
    const draftSessionId = await aiSessionService.saveSupplierOrderSession(sessionId, draft);
    draft.draft_session_id = draftSessionId;
    return draft;
  }

  if (isInventoryPredictionMessage(message)) {
    const forecastDays = extractPlanningDays(message);
    return aiInventoryPredictionService.getInventoryPrediction({
      forecast_days: forecastDays,
      lookback_days: 14
    });
  }

  // Real AI NLU layer: understand free-form Vietnamese first.
  // If OPENAI_API_KEY is not configured or confidence is low, fallback to rule-based parser below.
  let nluResult = null;

  try {
    nluResult = await handleNluIntent(message, options, sessionId);
  } catch (err) {
    console.warn('AI NLU fallback to rule parser:', err.message);
    nluResult = null;
  }

  if (nluResult) {
    return nluResult;
  }

  if (isCancelMessage(message)) {
    const latestSession = await aiSessionService.getLatestPendingSession(sessionId);

    if (!latestSession) {
      throw new Error('Không có nháp để hủy');
    }

    await aiSessionService.markSessionCancelled(latestSession.id);

    return {
      intent: 'CANCEL_PREVIOUS_DRAFT',
      message: 'Đã hủy nháp gần nhất.'
    };
  }

  // Confirm newest pending draft: order draft or payment draft.
  if (isConfirmMessage(message)) {
    const latestSession = await aiSessionService.getLatestPendingSession(sessionId);

    if (!latestSession) {
      throw new Error('Không có nháp để xác nhận');
    }

    if (latestSession.status === 'SUPPLIER_ORDER_DRAFT') {
      const confirmed = await aiSupplierOrderingService.confirmSupplierOrderDraft(
        latestSession.draft_json,
        { id: null, role: 'ADMIN' }
      );

      await aiSessionService.markSessionConfirmed(latestSession.id);

      return {
        intent: 'CONFIRM_PREVIOUS_SUPPLIER_ORDER',
        confirmed
      };
    }

    if (latestSession.status === 'PAYMENT_DRAFT') {
      const confirmed = await aiPaymentService.confirmPaymentFromPreview(
        latestSession.draft_json,
        { id: null, role: 'ADMIN' }
      );

      await aiSessionService.markSessionConfirmed(latestSession.id);

      return {
        intent: 'CONFIRM_PREVIOUS_PAYMENT',
        confirmed
      };
    }

    if (latestSession.draft_json && latestSession.draft_json.can_confirm === false) {
      throw new Error(latestSession.draft_json.warnings?.[0] || 'Nháp chưa đủ điều kiện xác nhận');
    }

    const confirmed = await orderService.confirmOrderDraft(
      latestSession.draft_json
    );

    await aiSessionService.markSessionConfirmed(latestSession.id);

    return {
      intent: 'CONFIRM_PREVIOUS_ORDER',
      confirmed
    };
  }

  // Inventory insight Q&A, for example: còn bao nhiêu gà, sản phẩm nào sắp hết.
  if (aiInventoryInsightService.isInventoryMessage(message)) {
    return aiInventoryInsightService.handleInventoryInsight(message);
  }

  // Business insight Q&A, for example: doanh thu hôm nay, HongHien còn nợ bao nhiêu.
  if (aiInsightService.isInsightMessage(message)) {
    return aiInsightService.handleInsight(message);
  }

  // Repeat previous customer order, for example: HongHien lấy như hôm qua.
  if (isRepeatOrderMessage(message)) {
    return handleRepeatOrderMessage(sessionId, message, options);
  }

  // Edit latest order draft before creating a new order.
  if (isEditOrderDraftMessage(message)) {
    return editLatestOrderDraft(sessionId, message);
  }

  // Payment-only chat, for example: HongHien trả 500k / HongHien ck 2tr.
  if (aiPaymentService.isPaymentMessage(message) && !hasOrderItems(message)) {
    const preview = await aiPaymentService.previewPayment(message);

    const paymentSessionId = await aiSessionService.savePaymentSession(
      sessionId,
      preview.customer.id,
      preview
    );

    if (options.confirm === true) {
      const confirmed = await aiPaymentService.confirmPaymentFromPreview(
        preview,
        { id: null, role: 'ADMIN' }
      );

      await aiSessionService.markSessionConfirmed(paymentSessionId);

      return {
        intent: 'PAYMENT_AND_CONFIRM',
        preview,
        confirmed
      };
    }

    return preview;
  }

  // Create new order draft.
  let draftPayload;

  try {
    draftPayload = parseSimpleBill(message, options);
  } catch (err) {
    return buildClarificationResponse(message, err);
  }

  const draft = await orderService.createOrderDraft(
    draftPayload
  );

  await aiSessionService.cancelOpenOrderDrafts(sessionId);

  const draftSessionId = await aiSessionService.saveDraftSession(
    sessionId,
    draft.customer.id,
    draft
  );

  if (options.confirm === true) {
    const confirmed = await orderService.confirmOrderDraft(
      draft
    );

    await aiSessionService.markSessionConfirmed(
      draftSessionId
    );

    return {
      intent: 'CREATE_ORDER_AND_CONFIRM',
      parsed: draftPayload,
      draft,
      confirmed
    };
  }

  return {
    intent: 'CREATE_ORDER_DRAFT',
    parsed: draftPayload,
    draft,
    requires_confirm: draft.can_confirm !== false,
    requires_payment: draft.requires_payment === true,
    confirm_message: draft.can_confirm === false ? 'Nháp chưa đủ điều kiện lưu bill' : 'Xác nhận lưu bill?'
  };
}

module.exports = {
  handleChat
};
