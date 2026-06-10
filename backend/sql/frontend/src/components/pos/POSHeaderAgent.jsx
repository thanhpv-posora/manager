import React from 'react';
import LunarDateSelector from '../LunarDateSelector';

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
          <b>Ngày in bill:</b>{' '}
          {calendarType === 'LUNAR'
            ? `Âm lịch ${lunarDateText || 'chưa chọn'}`
            : `Dương lịch ${orderDate}`}
        </div>
      </div>

      <div className="pos-header-actions">
        <button type="button" className="btn secondary" onClick={() => setDateOpen(!dateOpen)}>
          {dateOpen ? 'Thu gọn ngày' : 'Chọn ngày in bill'}
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
