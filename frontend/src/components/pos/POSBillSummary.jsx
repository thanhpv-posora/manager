import React from 'react';
import { formatQty } from '../../utils/quantity';

const money = n => Number(n || 0).toLocaleString('en-US') + 'đ';

export default function POSBillSummary({
  totalQty,
  total,
  monthlyInstallment,
  saving,
  cid,
  selectedCategoryId,
  selectedCount,
  onSave,
  onClear,
  msg,
}) {
  return (
    <aside className="card pos-summary-card">
      <h3 className="pos-summary-title">Tổng bill</h3>
      <div className="pos-summary-totals">
        <div className="pos-summary-row pos-summary-row-sl"><span>SL</span><b>{formatQty(totalQty)}</b></div>
        <div className="pos-summary-row pos-summary-row-total"><span>Tiền</span><b>{money(total)}</b></div>
        <div className="pos-summary-row pos-summary-row-installment"><span>Góp/ngày</span><b>{money(monthlyInstallment)}</b></div>
      </div>
      <div className="actions pos-summary-actions">
        <button type="button" className="btn" disabled={saving || !cid || !selectedCategoryId || !selectedCount} onClick={onSave}>
          {saving ? 'Đang lưu...' : 'Lưu bill'}
        </button>
        <button type="button" className="btn secondary" onClick={onClear}>Xóa SL</button>
      </div>
      {msg && <div className="ai-alert success pos-summary-msg">Đã lưu: <b>{msg}</b></div>}
    </aside>
  );
}
