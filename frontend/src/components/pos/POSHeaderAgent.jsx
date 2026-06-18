import React from 'react';
import LunarDateSelector from '../LunarDateSelector';

const formatDate = (v) => {
  const raw = String(v || '').slice(0, 10);
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : raw;
};

export default function POSHeaderAgent({
  orderDate,
  setOrderDate,
  calendarType,
  setCalendarType,
  lunarDateText,
  setLunarDateText,
  dateOpen,
  setDateOpen
}){
  return (
    <div className="pos-agent-header pos-real-header">
      <div className="pos-agent-header-left">
        <div className="pos-agent-logo">🥩 Tạo bill POS</div>
        <div className="pos-agent-date-summary">
          <b>Ngày xuất hàng:</b>{' '}
          {calendarType === 'LUNAR'
            ? `Âm lịch ${lunarDateText || 'chưa chọn'}${orderDate ? ' / Dương lịch ' + formatDate(orderDate) : ''}`
            : `Dương lịch ${formatDate(orderDate)}`}
        </div>
      </div>

      <div className="pos-header-actions">
        <button type="button" className="btn secondary" onClick={() => setDateOpen(!dateOpen)}>
          {dateOpen ? 'Thu gọn ngày' : 'Chọn ngày xuất hàng'}
        </button>
      </div>

      {dateOpen && (
        <div className="pos-agent-date-dropdown pos-real-date-dropdown">
          <div className="form-grid">
            <label>
              <span className="muted">Ngày dương lịch</span>
              <input
                className="input"
                type="date"
                value={orderDate}
                onChange={e => setOrderDate(e.target.value)}
              />
            </label>
          </div>

          <LunarDateSelector
            solarDate={orderDate}
            calendarType={calendarType}
            onCalendarTypeChange={setCalendarType}
            value={lunarDateText}
            onChange={setLunarDateText}
          />
        </div>
      )}
    </div>
  );
}
