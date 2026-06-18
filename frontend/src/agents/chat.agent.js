const chatService = require('../services/chat.service');
const aiErrorLogService = require('../services/aiErrorLog.service');

function normalizeChatBody(req) {
  const body = req.body;

  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
    const message = body.message ?? body.text ?? body.prompt ?? body.content ?? body.query ?? body.input;
    return {
      message,
      confirm: body.confirm === true || body.confirm === 'true',
      session_id: body.session_id || body.sessionId || body.session || 'DEFAULT',
      customer_type: body.customer_type || body.customerType || body.customer_payment_type || null,
      raw: body
    };
  }

  if (typeof body === 'string') {
    const raw = body.trim();
    try {
      const parsed = JSON.parse(raw);
      const message = parsed.message ?? parsed.text ?? parsed.prompt ?? parsed.content ?? parsed.query ?? parsed.input;
      return {
        message,
        confirm: parsed.confirm === true || parsed.confirm === 'true',
        session_id: parsed.session_id || parsed.sessionId || parsed.session || 'DEFAULT',
        customer_type: parsed.customer_type || parsed.customerType || parsed.customer_payment_type || null,
        raw: parsed
      };
    } catch (_) {
      return { message: raw, confirm: false, session_id: req.query?.session_id || 'DEFAULT', raw: { raw_text: raw } };
    }
  }

  return {
    message: req.query?.message || req.query?.text || req.query?.q,
    confirm: req.query?.confirm === 'true',
    session_id: req.query?.session_id || 'DEFAULT',
    customer_type: req.query?.customer_type || null,
    raw: req.query || {}
  };
}

function detectActionType(message, data, confirm) {
  const m = String(message || '').toLowerCase();
  if (confirm || /^(ok|xac nhan|xác nhận|luu|lưu)$/i.test(m.trim())) return 'AI_CONFIRM_DRAFT';
  if (data?.intent === 'CREATE_ORDER_DRAFT') return 'AI_CREATE_ORDER_DRAFT';
  if (data?.intent === 'AI_SUPPLIER_ORDER_DRAFT') return 'AI_SUPPLIER_ORDER_DRAFT';
  if (data?.intent === 'AI_DASHBOARD_SUMMARY') return 'AI_DASHBOARD_SUMMARY';
  if (m.includes('nhap hang') || m.includes('nhập hàng')) return 'AI_SUPPLIER_ORDER_DRAFT';
  if (m.includes('tom tat') || m.includes('tóm tắt')) return 'AI_DASHBOARD_SUMMARY';
  return 'AI_CHAT';
}

async function handleChat(req, res) {
  const normalized = normalizeChatBody(req);
  const { message, confirm, session_id, customer_type, raw } = normalized;

  try {
    if (!message || !String(message).trim()) {
      return res.status(400).json({
        success: false,
        message: 'Thiếu message',
        hint: 'Gửi JSON dạng: {"session_id":"A001","message":"nen nhap hang gi tuan toi"}'
      });
    }

    const data = await chatService.handleChat(String(message).trim(), { confirm, session_id, customer_type });
    const actionType = detectActionType(message, data, confirm);

    await aiErrorLogService.logAction({
      session_id,
      action_type: actionType,
      intent: data?.intent,
      request_text: String(message).trim(),
      request_json: raw,
      response_json: data,
      success_flg: 1
    });

    res.json({ success: true, data });
  } catch (err) {
    console.error('AI chat error:', err);
    const actionType = detectActionType(message, null, confirm);
    const logged = await aiErrorLogService.logError({
      session_id,
      action_type: actionType,
      intent: null,
      request_text: message,
      request_json: raw,
      error: err,
      extra: { path: req.originalUrl, method: req.method, customer_type },
      notify: true
    });

    res.status(500).json({
      success: false,
      message: err.message,
      error_id: logged.error_id || null,
      hint: 'Đã ghi log lỗi. Có thể bấm “AI điều tra lỗi” để xem nguyên nhân.'
    });
  }
}

module.exports = { handleChat };
