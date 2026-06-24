'use strict';
const pool = require('../config/db');

class PartnerAgent {
  constructor() {
    this.version = '1.0.0';
    this.responsibility = 'Partner read — unified supplier/customer view via customers.partner_type (BP-001B)';
  }

  async listPartners(query = {}) {
    const { role } = query;
    const where = ['del_flg = 0'];
    if      (role === 'supplier') where.push('(partner_type & 1) = 1');
    else if (role === 'customer') where.push('(partner_type & 2) = 2');
    else if (role === 'both')     where.push('partner_type = 3');
    const [rows] = await pool.query(
      `SELECT id, customer_code, name, phone, address, note,
              partner_type, billing_calendar_type, is_active
       FROM customers
       WHERE ${where.join(' AND ')}
       ORDER BY name ASC`
    );
    return rows;
  }

  async listSuppliers() {
    return this.listPartners({ role: 'supplier' });
  }

  async listCustomers() {
    return this.listPartners({ role: 'customer' });
  }
}

module.exports = new PartnerAgent();
