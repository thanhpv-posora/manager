import React from 'react';
import { formatQty } from '../../utils/quantity';
import MoneyInput from '../MoneyInput';

const money = n => Number(n || 0).toLocaleString('en-US') + 'đ';

export default function POSBillSummary({
  totalQty,
  total,
  monthlyInstallment,
  billInstallmentAmount,
  showInstallment,
  onInstallmentChange,
  saving,
  cid,
  selectedCategoryId,
  selectedCount,
  onSave,
  onClear,
  msg,
}) {
  // FEAT (manual góp bill): grandTotal is goods (total) + the ACTUAL amount
  // going on THIS bill (billInstallmentAmount — defaults to the customer's
  // configured monthlyInstallment but is independently editable per bill,
  // see CreateOrder.jsx). Never the configured default directly — that would
  // silently ignore an operator override.
  const grandTotal = Number(total || 0) + Number(billInstallmentAmount || 0);
  return (
    <aside className="card pos-summary-card">
      <h3 className="pos-summary-title">Tổng bill</h3>
      <div className="pos-summary-totals">
        <div className="pos-summary-row pos-summary-row-sl"><span>SL</span><b>{formatQty(totalQty)}</b></div>
        <div className="pos-summary-row pos-summary-row-total"><span>Tiền hàng</span><b>{money(total)}</b></div>
        {showInstallment && (
          <div className="pos-summary-installment-block">
            <div className="pos-summary-installment-header">
              <span>Góp bill</span>
              {Number(monthlyInstallment) > 0 && (
                <span className="pos-summary-installment-default">Mặc định: {money(monthlyInstallment)}/ngày</span>
              )}
            </div>
            <div className="pos-summary-row pos-summary-row-installment-input">
              <span>Tiền góp bill này</span>
              <MoneyInput
                value={billInstallmentAmount}
                onChange={onInstallmentChange}
                disabled={saving}
                style={{ width: 130, textAlign: 'right' }}
              />
            </div>
          </div>
        )}
        <div className="pos-summary-row pos-summary-row-grandtotal"><span>Tổng bill</span><b>{money(grandTotal)}</b></div>
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
