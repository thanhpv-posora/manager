'use strict';

class PurchaseEngine {
  computePurchaseLine({ purchase_qty, expected_conversion_qty, actual_stock_qty_kg, purchase_unit_price }) {
    const qty    = Number(purchase_qty           || 0);
    const conv   = Number(expected_conversion_qty || 0);
    const actual = Number(actual_stock_qty_kg     || 0);
    const price  = Number(purchase_unit_price     || 0);

    if (qty   <= 0) throw Object.assign(new Error('purchase_qty phải lớn hơn 0'),            { status: 400 });
    if (conv  <= 0) throw Object.assign(new Error('expected_conversion_qty phải lớn hơn 0'), { status: 400 });
    if (price  < 0) throw Object.assign(new Error('purchase_unit_price không được âm'),       { status: 400 });

    const expected_stock_qty_kg   = qty * conv;
    const inventory_stock_qty_kg  = actual > 0 ? actual : expected_stock_qty_kg;

    if (inventory_stock_qty_kg <= 0) throw Object.assign(new Error('inventory_stock_qty_kg phải lớn hơn 0'), { status: 400 });

    const total_cost  = qty * price;
    const cost_per_kg = total_cost / inventory_stock_qty_kg;

    return { expected_stock_qty_kg, inventory_stock_qty_kg, total_cost, cost_per_kg };
  }
}

module.exports = new PurchaseEngine();
