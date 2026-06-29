'use strict';

const pool = require('../config/db');
const { nextCode } = require('../utils/code');
const InventoryService = require('./InventoryService');

class InventoryReceiveService {
  async get(id) {
    // TODO INV-001: fetch inventory_receives + inventory_receive_items by id
    throw new Error('Not implemented');
  }

  async create(body, userId) {
    // TODO INV-001: create inventory_receives header + items
    // Sets purchase_order status to APPROVED or PARTIAL_RECEIVED
    // Does NOT touch stock_quantity — only receive() does
    throw new Error('Not implemented');
  }

  async receive(receiveId, userId) {
    // TODO INV-001: for each item, call InventoryService.in()
    // Updates purchase_order status to PARTIAL_RECEIVED or RECEIVED
    throw new Error('Not implemented');
  }

  async cancel(receiveId, userId) {
    // TODO INV-001: cancel a receive voucher that has not been received
    throw new Error('Not implemented');
  }
}

module.exports = new InventoryReceiveService();
