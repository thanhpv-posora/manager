import React, { useEffect, useState, useCallback } from 'react';
import api from '../api/api';
import SafePage from '../components/SafePage';

const todayStr = () => new Date().toISOString().slice(0, 10);

function isValidLunar(text) {
  const parts = String(text || '').trim().split('/');
  if (parts.length !== 3 || !parts.every(p => /^\d+$/.test(p.trim()))) return false;
  const [d, m, y] = parts.map(Number);
  return d >= 1 && d <= 30 && m >= 1 && m <= 12 && y > 1900;
}

function fmtAmount(v) {
  const n = Number(String(v || '').replace(/[^0-9]/g, ''));
  return n > 0 ? n.toLocaleString('en-US') : '';
}

export default function RetailDailySummary() {
  const [calendarType, setCalendarType] = useState('SOLAR');
  const [businessDate, setBusinessDate] = useState(todayStr());
  const [lunarDateText, setLunarDateText] = useState('');
  const [amountRaw, setAmountRaw] = useState('');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [existingId, setExistingId] = useState(null);

  const loadRecord = useCallback(async (date, calType, lunarText) => {
    const isLunar = calType === 'LUNAR';
    if (isLunar) {
      if (!lunarText || !isValidLunar(lunarText)) return;
    } else {
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    }
    setLoading(true);
    setError('');
    setSuccess('');
    try {
      const params = isLunar
        ? { calendar_type: 'LUNAR', lunar_date_text: lunarText.trim() }
        : { business_date: date, calendar_type: 'SOLAR' };
      const r = await api.get('/retail-daily-summary', { params });
      const rec = r.data;
      if (rec) {
        setAmountRaw(String(rec.amount || ''));
        setNote(rec.note || '');
        if (rec.business_date) setBusinessDate(rec.business_date);
        if (rec.lunar_date_text) setLunarDateText(rec.lunar_date_text);
        setExistingId(rec.id || null);
      } else {
        setAmountRaw('');
        setNote('');
        setExistingId(null);
      }
    } catch(e) {
      setError(e.response?.data?.message || e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // SOLAR: auto-load when date or calendar type changes
  useEffect(() => {
    if (calendarType !== 'SOLAR') return;
    loadRecord(businessDate, 'SOLAR', null);
  }, [businessDate, calendarType]);

  // LUNAR: auto-load when lunar text is a complete valid date
  useEffect(() => {
    if (calendarType !== 'LUNAR') return;
    if (isValidLunar(lunarDateText)) {
      loadRecord(null, 'LUNAR', lunarDateText.trim());
    }
  }, [lunarDateText, calendarType]);

  const handleSave = async () => {
    setError('');
    setSuccess('');
    const amount = Number(String(amountRaw).replace(/[^0-9]/g, ''));
    if (!amount || amount <= 0) { setError('Vui lòng nhập số tiền bán lẻ lớn hơn 0.'); return; }
    if (calendarType === 'SOLAR' && (!businessDate || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate))) {
      setError('Ngày dương lịch không hợp lệ.'); return;
    }
    if (calendarType === 'LUNAR' && !isValidLunar(lunarDateText)) {
      setError('Vui lòng nhập ngày âm lịch hợp lệ (VD: 15/05/2026).'); return;
    }
    setSaving(true);
    try {
      const resp = await api.post('/retail-daily-summary/upsert', {
        calendar_type: calendarType,
        business_date: businessDate,
        lunar_date_text: lunarDateText,
        amount,
        note
      });
      setSuccess('Đã lưu doanh thu bán lẻ.');
      const saved = resp.data;
      if (saved?.business_date) setBusinessDate(saved.business_date);
      if (saved?.lunar_date_text) setLunarDateText(saved.lunar_date_text);
      await loadRecord(
        saved?.business_date || businessDate,
        calendarType,
        saved?.lunar_date_text || lunarDateText
      );
    } catch(e) {
      setError(e.response?.data?.message || e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafePage loading={false} error="">
      <div className="grid">
        <div className="card">
          <h3>Ghi nhận doanh thu bán lẻ</h3>
          <p className="muted">Ghi nhận tổng tiền thu bán lẻ theo ngày kinh doanh. Không liên kết đơn hàng hay tồn kho.</p>

          <div className="actions" style={{ flexWrap: 'wrap', gap: 12, marginTop: 16 }}>
            <div>
              <label className="muted" style={{ display: 'block', marginBottom: 4, fontSize: 13 }}>Loại lịch</label>
              <select
                className="select"
                style={{ width: 160 }}
                value={calendarType}
                onChange={e => {
                  setCalendarType(e.target.value);
                  setAmountRaw('');
                  setNote('');
                  setExistingId(null);
                  setError('');
                  setSuccess('');
                }}
              >
                <option value="SOLAR">Dương lịch</option>
                <option value="LUNAR">Âm lịch</option>
              </select>
            </div>

            {calendarType === 'SOLAR' ? (
              <div>
                <label className="muted" style={{ display: 'block', marginBottom: 4, fontSize: 13 }}>Ngày kinh doanh</label>
                <input
                  className="input"
                  type="date"
                  style={{ width: 180 }}
                  value={businessDate}
                  onChange={e => setBusinessDate(e.target.value)}
                />
              </div>
            ) : (
              <div>
                <label className="muted" style={{ display: 'block', marginBottom: 4, fontSize: 13 }}>Ngày âm lịch (DD/MM/YYYY)</label>
                <input
                  className="input"
                  type="text"
                  style={{ width: 180 }}
                  placeholder="VD: 15/05/2026"
                  value={lunarDateText}
                  onChange={e => setLunarDateText(e.target.value)}
                />
              </div>
            )}
          </div>

          {loading && <p className="muted" style={{ marginTop: 12 }}>Đang tải...</p>}

          {!loading && (
            <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 480 }}>
              {existingId && (
                <p style={{ fontSize: 13, color: '#16a34a' }}>Đã có dữ liệu ngày này — lưu sẽ cập nhật.</p>
              )}

              <div>
                <label className="muted" style={{ display: 'block', marginBottom: 4, fontSize: 13 }}>
                  Tổng doanh thu bán lẻ (đ)
                </label>
                <input
                  className="input"
                  type="text"
                  inputMode="numeric"
                  style={{ width: '100%', fontSize: 20, fontWeight: 700 }}
                  placeholder="0"
                  value={fmtAmount(amountRaw)}
                  onChange={e => setAmountRaw(String(e.target.value).replace(/[^0-9]/g, ''))}
                />
              </div>

              <div>
                <label className="muted" style={{ display: 'block', marginBottom: 4, fontSize: 13 }}>Ghi chú</label>
                <textarea
                  className="input"
                  rows={2}
                  style={{ width: '100%', resize: 'vertical' }}
                  placeholder="Tùy chọn..."
                  value={note}
                  onChange={e => setNote(e.target.value)}
                />
              </div>

              {error && <p style={{ color: '#dc2626', fontSize: 14 }}>{error}</p>}
              {success && <p style={{ color: '#16a34a', fontSize: 14 }}>{success}</p>}

              <div>
                <button className="btn" onClick={handleSave} disabled={saving}>
                  {saving ? 'Đang lưu...' : 'Lưu doanh thu bán lẻ'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </SafePage>
  );
}
