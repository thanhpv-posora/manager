import React from'react';
import {parseLunarText,lunarToSolarDate}from'../../utils/lunarDate';

// Only validate once the user has finished typing a complete DD/MM/YYYY pattern.
const isComplete=(text)=>/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(String(text||'').trim());

export default function CalendarDialog({
  open,
  calendarType='SOLAR',
  title,
  subtitle,
  inputLabel='Ngày',
  solarDate='',
  lunarDateText='',
  onSolarDateChange,
  onLunarDateTextChange,
  onConfirm,
  onCancel,
  maxSolarDate,
  confirmLabel='Xác nhận',
  cancelLabel='Hủy',
  errorText='',
}){
  if(!open)return null;

  const isLunar=calendarType==='LUNAR';

  let mappedSolar='';
  let lunarInvalid=false;
  if(isLunar&&isComplete(lunarDateText)){
    mappedSolar=lunarToSolarDate(parseLunarText(lunarDateText));
    lunarInvalid=!mappedSolar;
  }

  return(
    <div className="modal-backdrop">
      <div className="modal-card" style={{maxWidth:440}}>
        <div className="modal-header">
          <div>
            {title&&<h2>{title}</h2>}
            {subtitle&&<p className="muted">{subtitle}</p>}
          </div>
          <button type="button" className="btn secondary" onClick={onCancel}>Đóng</button>
        </div>

        <div style={{padding:'16px 0'}}>
          {isLunar?(
            <label className="field-label">
              <span>{inputLabel} âm lịch</span>
              <input
                className="input"
                value={lunarDateText}
                onChange={e=>onLunarDateTextChange&&onLunarDateTextChange(e.target.value)}
                placeholder="VD: 08/01/2026"
                autoFocus
              />
              {isComplete(lunarDateText)&&(
                <small className="muted" style={{display:'block',marginTop:4}}>
                  {lunarInvalid?'⚠ Ngày âm không hợp lệ':`→ Dương lịch: ${mappedSolar}`}
                </small>
              )}
            </label>
          ):(
            <label className="field-label">
              <span>{inputLabel}</span>
              <input
                className="input"
                type="date"
                value={solarDate}
                max={maxSolarDate}
                onChange={e=>onSolarDateChange&&onSolarDateChange(e.target.value)}
                autoFocus
              />
            </label>
          )}
          {errorText&&<div className="ai-alert danger" style={{marginTop:8}}>{errorText}</div>}
        </div>

        <div className="modal-footer">
          <button type="button" className="btn secondary" onClick={onCancel}>{cancelLabel}</button>
          <button type="button" className="btn" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
