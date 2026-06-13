const orderService = require('../services/order.service');
const aiSessionService = require('../services/aiSession.service');

function unwrapDraftPayload(body) {
  if (!body || typeof body !== 'object') return body;

  // Frontend variants supported:
  // 1) draft object directly
  // 2) { draft }
  // 3) { data: { draft } } from /api/ai/chat response
  // 4) { data: draft } from /api/ai/orders/create-draft response
  // 5) { intent, parsed, draft, ... }
  if (body.customer && Array.isArray(body.items)) return body;
  if (body.draft && body.draft.customer && Array.isArray(body.draft.items)) return body.draft;
  if (body.data && body.data.draft && body.data.draft.customer && Array.isArray(body.data.draft.items)) return body.data.draft;
  if (body.data && body.data.customer && Array.isArray(body.data.items)) return body.data;
  if (body.payload && body.payload.draft && body.payload.draft.customer && Array.isArray(body.payload.draft.items)) return body.payload.draft;
  if (body.payload && body.payload.customer && Array.isArray(body.payload.items)) return body.payload;

  return body;
}

async function createOrderDraft(req, res) {
  try {
    const draft = await orderService.createOrderDraft(req.body);

    return res.json({
      success: true,
      data: draft
    });
  } catch (err) {
    console.error('AI createOrderDraft error:', err);

    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
}

async function confirmOrderDraft(req, res) {
  try {
    const body = req.body || {};
    let draft = unwrapDraftPayload(body);
    let sessionRecord = null;

    // If the frontend only sends session_id/draft_session_id, confirm the saved pending draft.
    if (!draft || !draft.customer || !Array.isArray(draft.items)) {
      const sessionId = body.session_id || body.sessionId || body.session || req.query?.session_id || 'DEFAULT';
      sessionRecord = await aiSessionService.getLatestPendingSession(sessionId);
      if (!sessionRecord || !sessionRecord.draft_json) {
        return res.status(400).json({
          success: false,
          message: 'Không có nháp để xác nhận',
          hint: 'Gửi draft trực tiếp hoặc gửi session_id đúng với phiên đã tạo draft.'
        });
      }
      draft = sessionRecord.draft_json;
    }

    if (draft.can_confirm === false) {
      return res.status(400).json({
        success: false,
        message: draft.warnings?.[0] || 'Nháp chưa đủ điều kiện lưu bill',
        data: { draft }
      });
    }

    const data = await orderService.confirmOrderDraft(draft);

    if (sessionRecord?.id) {
      await aiSessionService.markSessionConfirmed(sessionRecord.id);
    } else if (body.draft_session_id || body.draftSessionId) {
      await aiSessionService.markSessionConfirmed(body.draft_session_id || body.draftSessionId).catch(() => {});
    }

    return res.json({
      success: true,
      data
    });
  } catch (err) {
    console.error('AI confirmOrderDraft error:', err);

    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
}

module.exports = {
  createOrderDraft,
  confirmOrderDraft
};