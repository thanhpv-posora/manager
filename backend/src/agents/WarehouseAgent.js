'use strict';
const pool = require('../config/db');

class WarehouseAgent {
  async list() {
    const [rows] = await pool.query(
      `SELECT id, code, name, is_default, is_active
       FROM warehouses
       WHERE is_active = 1
       ORDER BY is_default DESC, name ASC`
    );
    return rows;
  }

  async getDefaultId(conn) {
    const runner = conn || pool;
    const [[row]] = await runner.query(
      `SELECT id FROM warehouses WHERE is_default = 1 AND is_active = 1 LIMIT 1`
    );
    return row ? row.id : null;
  }
}

module.exports = new WarehouseAgent();
