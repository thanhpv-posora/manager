'use strict';

const InventoryReceiveService = require('../services/InventoryReceiveService');

class InventoryReceiveAgent {
  constructor() {
    this.version = '1.0.0';
    this.responsibility = 'Inventory Receive Voucher — creates stock IN transactions from approved purchase orders (INV-001)';
  }

  async list(params) {
    return InventoryReceiveService.list(params);
  }

  async get(id) {
    return InventoryReceiveService.get(id);
  }

  async create(body, userId) {
    return InventoryReceiveService.create(body, userId);
  }

  async receive(id, userId) {
    return InventoryReceiveService.receive(id, userId);
  }

  async cancel(id, userId) {
    return InventoryReceiveService.cancel(id, userId);
  }
}

module.exports = new InventoryReceiveAgent();
