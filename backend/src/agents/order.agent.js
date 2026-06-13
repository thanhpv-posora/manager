const orderService = require('../services/order.service');
const aiSessionService = require('../services/aiSession.service');

function pickSessionId(body = {}) {
  return body.session_id || body.sessionId || body.session || 'DEFAULT';
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

      if (!latestSession) {
        latestSession = await aiSessionService.getLatestDraftSession(pickSessionId(body));
      }

      if (!latestSession) {
        throw new Error('Không có nháp bill để xác nhận. Vui lòng tạo nháp lại rồi bấm Xác nhận lưu.');
      }

      const draft = latestSession.draft_json;
      if (draft && draft.can_confirm === false) {
        throw new Error(draft.warnings?.[0] || 'Nháp chưa đủ điều kiện lưu bill.');
      }

      const data = await orderService.confirmOrderDraft(draft);
      await aiSessionService.markSessionConfirmed(latestSession.id);

      return res.json({
        success: true,
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
