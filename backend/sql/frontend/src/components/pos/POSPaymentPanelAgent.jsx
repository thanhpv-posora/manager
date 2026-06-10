import React from 'react';
import MoneyInput from '../MoneyInput';

const money = n => Number(n || 0).toLocaleString('en-US') + 'đ';

export default function POSPaymentPanelAgent({
  total,
  monthlyInstallment=0,
  cashAmount,
  bankAmount,
  setCashAmount,
  setBankAmount,
  paid,
  setPaid,
  onSave,
  onClear,
  disabled,
  message
}){
  const payableTotal = Number(total||0)+Number(monthlyInstallment||0);
  const actualPaid = Number(cashAmount||0)+Number(bankAmount||0);
  const remain = Math.max(0,payableTotal-actualPaid);
  // V6.51: Tiền mặt và chuyển khoản nhập độc lập.
  // Không tự ép tổng 2 field bằng tổng bill; nếu trả thiếu thì còn nợ.
  const changeBank=v=>{
    const b=Number(v||0);
    setBankAmount?.(v);
    setPaid?.(b+Number(cashAmount||0));
  };
  const changeCash=v=>{
    const c=Number(v||0);
    setCashAmount?.(v);
    setPaid?.(c+Number(bankAmount||0));
  };

  return (
    <aside className="pos-agent-payment pos-payment-dock">
      <div className="card pos-agent-payment-card">
        <h3>3. Thanh toán</h3>

        <div className="pos-agent-money-row"><span>Bill hôm nay</span><b>{money(total)}</b></div>
        <div className="pos-agent-money-row"><span>Góp nợ/ngày</span><b>{money(monthlyInstallment)}</b></div>
        <div className="pos-agent-money-row"><span>Tổng cần thanh toán</span><b>{money(payableTotal)}</b></div>

        <div className="pos-paid-input">
          <label className="muted">Tiền mặt</label>
          <MoneyInput placeholder="Tiền mặt" value={cashAmount} onChange={changeCash}/>
        </div>
        <div className="pos-paid-input">
          <label className="muted">Chuyển khoản</label>
          <MoneyInput placeholder="Chuyển khoản" value={bankAmount} onChange={changeBank}/>
        </div>

        <div className="pos-agent-money-row"><span>Đã thu</span><b>{money(actualPaid)}</b></div>
        <div className="pos-agent-money-row pos-remain-row"><span>Còn nợ</span><b>{money(remain)}</b></div>

        <div className="actions pos-agent-payment-actions">
          <button className="btn" onClick={onSave} disabled={disabled}>Lưu bill</button>
          <button className="btn secondary" onClick={onClear}>Xóa SL</button>
        </div>

        {message && <p className="success">Đã tạo bill: {message}</p>}
      </div>
    </aside>
  );
}
