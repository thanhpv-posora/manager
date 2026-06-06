import React from 'react';
import MoneyInput from '../MoneyInput';

const money = n => Number(n || 0).toLocaleString('en-US') + 'đ';

export default function POSPaymentPanelAgent({
  total,
  paid,
  setPaid,
  onSave,
  onClear,
  disabled,
  message
}){
  const remain = total - Number(paid || 0);

  return (
    <aside className="pos-agent-payment pos-payment-dock">
      <div className="card pos-agent-payment-card">
        <h3>3. Thanh toán</h3>

        <div className="pos-agent-money-row">
          <span>Tổng tiền</span>
          <b>{money(total)}</b>
        </div>

        <div className="pos-paid-input">
          <label className="muted">Đã thu</label>
          <MoneyInput placeholder="Đã thu" value={paid} onChange={setPaid}/>
        </div>

        <div className="pos-agent-money-row pos-remain-row">
          <span>Còn nợ</span>
          <b>{money(remain)}</b>
        </div>

        <div className="actions pos-agent-payment-actions">
          <button className="btn" onClick={onSave} disabled={disabled}>
            Lưu bill
          </button>
          <button className="btn secondary" onClick={onClear}>
            Xóa SL
          </button>
        </div>

        {message && <p className="success">Đã tạo bill: {message}</p>}
      </div>
    </aside>
  );
}
