'use strict';
const pool = require('../config/db');

class UnitAgent {
  async list() {
    const [rows] = await pool.query(
      `SELECT id, code, name, is_active, created_at, updated_at
       FROM units
       ORDER BY code ASC`
    );
    return rows;
  }

  async create(data) {
    const code = String(data.code || '').trim().toUpperCase();
    const name = String(data.name || '').trim();
    if (!code) throw Object.assign(new Error('Thiếu mã đơn vị (code)'), { status: 400 });
    if (!name) throw Object.assign(new Error('Thiếu tên đơn vị (name)'), { status: 400 });

    const [dup] = await pool.query(`SELECT id FROM units WHERE code = ?`, [code]);
    if (dup.length) throw Object.assign(new Error(`Mã đơn vị "${code}" đã tồn tại`), { status: 400 });

    const [result] = await pool.query(
      `INSERT INTO units(code, name, is_active) VALUES (?, ?, 1)`,
      [code, name]
    );
    return { message: 'Đã tạo đơn vị', id: result.insertId };
  }

  async update(id, data) {
    const [existing] = await pool.query(`SELECT id FROM units WHERE id = ?`, [id]);
    if (!existing.length) throw Object.assign(new Error('Không tìm thấy đơn vị'), { status: 404 });

    const code = String(data.code || '').trim().toUpperCase();
    const name = String(data.name || '').trim();
    if (!code) throw Object.assign(new Error('Thiếu mã đơn vị (code)'), { status: 400 });
    if (!name) throw Object.assign(new Error('Thiếu tên đơn vị (name)'), { status: 400 });

    const [dup] = await pool.query(`SELECT id FROM units WHERE code = ? AND id <> ?`, [code, id]);
    if (dup.length) throw Object.assign(new Error(`Mã đơn vị "${code}" đã tồn tại`), { status: 400 });

    const isActive = data.is_active !== undefined ? (data.is_active ? 1 : 0) : null;
    await pool.query(
      `UPDATE units SET code = ?, name = ?, is_active = COALESCE(?, is_active) WHERE id = ?`,
      [code, name, isActive, id]
    );
    return { message: 'Đã cập nhật đơn vị' };
  }

  async disable(id) {
    const [existing] = await pool.query(`SELECT id FROM units WHERE id = ?`, [id]);
    if (!existing.length) throw Object.assign(new Error('Không tìm thấy đơn vị'), { status: 404 });
    await pool.query(`UPDATE units SET is_active = 0 WHERE id = ?`, [id]);
    return { message: 'Đã tắt đơn vị' };
  }
}

module.exports = new UnitAgent();
