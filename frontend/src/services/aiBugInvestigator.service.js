const aiErrorLogService = require('./aiErrorLog.service');

function analyzeError(row) {
  const msg = `${row?.error_message || ''}\n${row?.error_stack || ''}`.toLowerCase();
  const action = row?.action_type || 'UNKNOWN_ACTION';
  const causes = [];
  const files = new Set();
  const fixes = [];

  if (msg.includes('unknown column')) {
    causes.push('Database schema chưa khớp với code hiện tại. Có cột đang được INSERT/SELECT nhưng DB chưa có.');
    fixes.push('Chạy migration SQL mới nhất hoặc dùng schema compatibility script.');
    files.add('backend/sql'); files.add('backend/src/services/order.service.js');
  }
  if (msg.includes('không tìm thấy sản phẩm') || msg.includes('khong tim thay san pham')) {
    causes.push('Resolver chưa map được tên hàng/alias người dùng nói sang sản phẩm trong DB.');
    fixes.push('Bổ sung product_ocr_aliases hoặc meat voice dictionary cho tên hàng đó.');
    files.add('backend/src/services/order.service.js'); files.add('product_ocr_aliases');
  }
  if (msg.includes('chưa có giá') || msg.includes('gia')) {
    causes.push('Sản phẩm/khách chưa có giá riêng và default_sale_price có thể đang rỗng hoặc bằng 0.');
    fixes.push('Kiểm tra default_sale_price trong products hoặc customer_product_prices.');
    files.add('backend/src/services/order.service.js');
  }
  if (msg.includes('khách vãng lai phải thu đủ tiền') || msg.includes('walk_in')) {
    causes.push('Bill khách vãng lai chưa có số tiền thu đủ nên backend chặn lưu.');
    fixes.push('Khi chọn khách vãng lai, cần nhập/đọc tiền mặt hoặc chuyển khoản đủ tổng bill.');
    files.add('frontend/src/components/ai/AIVoicePOSPanel.jsx'); files.add('backend/src/services/order.service.js');
  }
  if (msg.includes('thiếu customer') || msg.includes('thiếu tên khách')) {
    causes.push('Draft thiếu thông tin khách hàng. Khách thường bắt buộc có tên khách.');
    fixes.push('Đọc tên khách ở dòng đầu hoặc chọn khách trước khi tạo bill.');
    files.add('backend/src/services/chat.service.js');
  }
  if (msg.includes('timeout')) {
    causes.push('OpenAI hoặc API xử lý quá lâu.');
    fixes.push('Dùng fallback parser, tăng timeout hoặc chia bill nhiều dòng.');
    files.add('backend/src/services/aiNlu.service.js');
  }

  if (!causes.length) {
    causes.push('Lỗi chưa có rule phân tích tự động. Cần xem error_stack và request_json trong ai_error_logs.');
    fixes.push('Mở log chi tiết theo error_id để xác định service gây lỗi.');
    files.add('backend/src/services/chat.service.js');
  }

  return {
    error_id: row?.id,
    action_type: action,
    intent: row?.intent,
    session_id: row?.session_id,
    created_at: row?.created_at,
    error_message: row?.error_message,
    likely_causes: causes,
    suggested_fixes: fixes,
    related_files: Array.from(files),
    summary: `AI điều tra: ${causes[0]}`
  };
}

async function investigateLatest() {
  const rows = await aiErrorLogService.getLatestErrors(1);
  if (!rows.length) {
    return { found: false, message: 'Chưa có lỗi AI nào trong ai_error_logs.' };
  }
  return { found: true, investigation: analyzeError(rows[0]) };
}

async function listInvestigations(limit = 10) {
  const rows = await aiErrorLogService.getLatestErrors(limit);
  return rows.map(analyzeError);
}

module.exports = { investigateLatest, listInvestigations, analyzeError };
