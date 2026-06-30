const pool = require('../config/db');
const { solarToLunar, parseLunarText, lunarToSolarDate } = require('../utils/lunarDate');

function lunarToText(l) {
  if (!l) return '';
  return `${String(l.day).padStart(2,'0')}/${String(l.month).padStart(2,'0')}/${l.year}`;
}

class RetailSummaryAgent {
  async upsert(data, user) {
    const { calendar_type, business_date, lunar_date_text, amount, note } = data;
    if (!amount || Number(amount) <= 0) {
      throw Object.assign(new Error('Số tiền bán lẻ phải lớn hơn 0'), { status: 400 });
    }
    const calType = String(calendar_type || 'SOLAR').toUpperCase() === 'LUNAR' ? 'LUNAR' : 'SOLAR';
    let solarDate, lunarText;

    if (calType === 'SOLAR') {
      if (!business_date || !/^\d{4}-\d{2}-\d{2}$/.test(business_date)) {
        throw Object.assign(new Error('Ngày dương lịch không hợp lệ'), { status: 400 });
      }
      solarDate = business_date;
      lunarText = lunarToText(solarToLunar(solarDate));
    } else {
      if (!lunar_date_text) throw Object.assign(new Error('Vui lòng nhập ngày âm lịch'), { status: 400 });
      const parsed = parseLunarText(lunar_date_text);
      if (!parsed) throw Object.assign(new Error('Ngày âm lịch không hợp lệ. Định dạng: DD/MM/YYYY'), { status: 400 });
      solarDate = lunarToSolarDate(parsed);
      if (!solarDate) throw Object.assign(new Error('Không thể quy đổi ngày âm sang dương'), { status: 400 });
      lunarText = lunar_date_text.trim();
    }

    await pool.query(`
      INSERT INTO retail_daily_summary
        (business_date, calendar_type, lunar_date_text, amount, note, status, created_by)
      VALUES (?, ?, ?, ?, ?, 'OPEN', ?)
      ON DUPLICATE KEY UPDATE
        lunar_date_text = VALUES(lunar_date_text),
        amount          = VALUES(amount),
        note            = VALUES(note),
        updated_by      = VALUES(created_by),
        updated_at      = NOW()
    `, [solarDate, calType, lunarText, Number(amount), note || null, user?.id || null]);

    return { business_date: solarDate, calendar_type: calType, lunar_date_text: lunarText, amount: Number(amount) };
  }

  async getByDate(businessDate, calendarType, lunarDateText) {
    const calType = String(calendarType || 'SOLAR').toUpperCase() === 'LUNAR' ? 'LUNAR' : 'SOLAR';
    let solarDate = businessDate;
    if (calType === 'LUNAR' && lunarDateText) {
      const parsed = parseLunarText(String(lunarDateText));
      if (parsed) solarDate = lunarToSolarDate(parsed);
    }
    if (!solarDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(solarDate))) return null;
    const [rows] = await pool.query(
      `SELECT * FROM retail_daily_summary WHERE business_date=? AND calendar_type=? LIMIT 1`,
      [solarDate, calType]
    );
    return rows[0] || null;
  }
}

module.exports = new RetailSummaryAgent();
