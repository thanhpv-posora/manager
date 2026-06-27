'use strict';
const pool = require('../config/db');
const { customerScopeWhere } = require('../middleware/scope');

class PartnerAgent {
  constructor() {
    this.version = '1.0.0';
    this.responsibility = 'Partner read — unified supplier/customer view via customers.partner_type (BP-001B)';
  }

  async listPartners(user = null, query = {}) {
    const { role } = query;
    const where = ['del_flg = 0'];
    if      (role === 'supplier') where.push('(partner_type & 1) = 1');
    else if (role === 'customer') where.push('(partner_type & 2) = 2');
    else if (role === 'both')     where.push('partner_type = 3');
    const params = [];
    if (user && user.role === 'CUSTOMER') {
      const { clause, params: sp } = await customerScopeWhere(user, 'id');
      where.push(clause);
      params.push(...sp);
    }
    const [rows] = await pool.query(
      `SELECT id, customer_code, name, phone, address, note,
              partner_type, billing_calendar_type, is_active
       FROM customers
       WHERE ${where.join(' AND ')}
       ORDER BY name ASC`,
      params
    );
    return rows;
  }

  async listSuppliers() {
    return this.listPartners(null, { role: 'supplier' });
  }

  async listCustomers() {
    return this.listPartners(null, { role: 'customer' });
  }
}

module.exports = new PartnerAgent();
