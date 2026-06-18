const orderService = require('../services/order.service');
const aiSessionService = require('../services/aiSession.service');

function pickSessionId(body = {}) {
  return body.session_id || body.sessionId || body.session || 'DEFAULT';
}

async function findDraftForConfirm(body = {}) {
  let latestSession = null;

  if (body.draft_session_id || body.draftSessionId) {
    const wantedId = Number(body.draft_session_id || body.draftSessionId);
    const [rows] = await require('../config/db').query(`
      SELECT *
      FROM ai_chat_sessions
      WHERE id = ?
        AND status = 'DRAFT'
      LIMIT 1
    `, [wantedId]);

    if (rows.length > 0) {
      latestSession = {
        ...rows[0],
        draft_json: JSON.parse(rows[0].draft_json)
      };
    }
  }

  if (!latestSession && (body.session_id || body.sessionId || body.session)) {
    latestSession = await aiSessionService.getLatestDraftSession(pickSessionId(body));
  }

  // Safety fallback for current UI bug: some frontend builds create the draft with one session_id
  // but confirm with another or without draft_session_id. In that case use the newest recent
  // DRAFT only when it is unambiguous enough for single-counter POS usage.
  if (!latestSession) {
    const recentDrafts = await aiSessionService.getRecentDraftSessions(5);
    if (recentDrafts.length === 1) {
      latestSession = recentDrafts[0];
    } else if (recentDrafts.length > 1) {
      const requested = pickSessionId(body);
      console.warn('[AI_CONFIRM_DRAFT_AMBIGUOUS]', JSON.stringify({
        requested_session_id: requested,
        recent_drafts: recentDrafts.map(d => ({ id: d.id, session_id: d.session_id, customer_id: d.customer_id, created_at: d.created_at }))
      }));
    }
  }

  return latestSession;
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

    // Production Voice POS confirm path:
    // Frontend often only has session_id, because the draft is stored in ai_chat_sessions.
    // Confirm the newest DRAFT session for that session_id instead of expecting the full draft JSON.
    if (body.session_id || body.sessionId || body.session || body.draft_session_id || body.draftSessionId) {
      const latestSession = await findDraftForConfirm(body);

      if (!latestSession) {
        throw new Error('Không có nháp bill để xác nhận. Vui lòng tạo nháp lại rồi bấm Xác nhận lưu.');
      }

      const draft = latestSession.draft_json;
      if (draft && draft.can_confirm === false) {
        throw new Error(draft.warnings?.[0] || 'Nháp chưa đủ điều kiện lưu bill.');
      }

      console.info('[AI_CONFIRM_DRAFT]', JSON.stringify({
        draft_session_id: latestSession.id,
        session_id: latestSession.session_id,
        customer_id: latestSession.customer_id,
        item_count: Array.isArray(draft?.items) ? draft.items.length : 0
      }));

      const data = await orderService.confirmOrderDraft(draft);
      await aiSessionService.markSessionConfirmed(latestSession.id);

      return res.json({
        success: true,
        message: 'Đã lưu bill thành công.',
        data: {
          intent: 'CONFIRM_PREVIOUS_ORDER',
          confirmed: data,
          draft_session_id: latestSession.id
        }
      });
    }

    // Backward compatible: caller posts the full draft object.
    const data = await orderService.confirmOrderDraft(body);

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
