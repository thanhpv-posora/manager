const QRCode = require('qrcode');

function money(n) { return Number(n || 0).toLocaleString('vi-VN') + 'đ'; }

class PrintService {
  async settings() {
    try {
      const pool = require('../config/db');
      const [rows] = await pool.query(`SELECT setting_key,setting_value FROM business_settings`);
      const s = {};
      for (const r of rows) s[r.setting_key] = r.setting_value;
      return s;
    } catch(e) {
      return {shop_name:'MEATBIZ FOOD', bill_footer:'Cảm ơn quý khách!'};
    }
  }
  async billHtml(order) {
    const settings = await this.settings();
    const app = process.env.PUBLIC_APP_URL || 'http://localhost:5173';
    const url = `${app}/bill/${order.private_token || order.order_code}`;
    const qr = await QRCode.toDataURL(url);
    const installmentRows = order.installment && order.installment.plans ? order.installment.plans.map(p=>`
      <tr><td>${p.plan_name}</td><td class="right">${money(p.daily_amount)}</td><td>${p.start_date}</td><td class="right">${money(p.paid_amount)}</td></tr>
    `).join('') : '';
    const installmentRecentRows = order.installment && order.installment.recent_payments ? order.installment.recent_payments.map(p=>`
      <tr><td>${p.payment_date}</td><td class="right">${money(p.amount)}</td><td>${p.payment_method}</td></tr>
    `).join('') : '';
    const oldDebtRows = (order.old_debts||[]).map(d=>`
      <tr><td>${d.order_date}</td><td>${d.order_code}</td><td class="right">${money(d.total_amount)}</td><td class="right">${money(d.paid_amount)}</td><td class="right"><b>${money(d.debt_amount)}</b></td></tr>
    `).join('');
    const rows = order.items.map((i,idx)=>`
      <tr><td>${idx+1}</td><td>${i.product_name}</td><td class="right">${i.quantity} ${i.unit}</td><td class="right">${money(i.sale_price)}</td><td class="right">${money(i.total_price)}</td></tr>
    `).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><title>${order.order_code}</title><style>
body{font-family:Arial,sans-serif;margin:28px;color:#111}.header{display:flex;justify-content:space-between;border-bottom:3px solid #7f1d1d;padding-bottom:14px}
.logo{font-size:30px;font-weight:900;color:#7f1d1d}.sub{color:#666;font-size:13px}.qr{width:120px;height:120px}.info{margin:18px 0;display:grid;grid-template-columns:1fr 1fr;gap:10px}
table{width:100%;border-collapse:collapse;margin-top:10px}th{background:#7f1d1d;color:#fff}td,th{border:1px solid #ddd;padding:9px}.right{text-align:right}
.total{margin-top:15px;text-align:right;font-size:20px;font-weight:900}.print-btn{position:fixed;right:20px;top:20px;padding:12px 18px;background:#7f1d1d;color:#fff;border:0;border-radius:10px;font-weight:700}
.sign{display:flex;justify-content:space-between;margin-top:45px;text-align:center}@media print{.print-btn{display:none}body{margin:10px}}</style></head><body>
<button class="print-btn" onclick="window.print()">IN BILL</button>
<div class="header"><div><div class="logo">${settings.shop_name||"MEATBIZ FOOD"}</div><div class="sub">${settings.shop_address||""} ${settings.shop_phone? " - " + settings.shop_phone : ""}</div><div class="sub">Phiếu giao hàng / Bill bán hàng</div><div>Mã bill: <b>${order.order_code}</b></div><div>Ngày: ${order.order_date}</div></div><div><img class="qr" src="${qr}"><div class="sub">Quét QR xem bill</div></div></div>
<div class="info"><div><b>Khách hàng:</b> ${order.customer_name}<br><b>SĐT:</b> ${order.phone || ''}<br><b>Địa chỉ:</b> ${order.address || ''}</div><div><b>Trạng thái:</b> ${order.payment_status}<br><b>Ghi chú:</b> ${order.note || ''}</div></div>
<table><thead><tr><th>STT</th><th>Mặt hàng</th><th>SL</th><th>Đơn giá</th><th>Thành tiền</th></tr></thead><tbody>${rows}</tbody></table>
<div class="total">Tổng bill này: ${money(order.total_amount)}</div><div class="total">Đã thu bill này: ${money(order.paid_amount)} | Còn nợ bill này: ${money(order.debt_amount)}</div>
${oldDebtRows ? `<h3>Nợ cũ chưa thanh toán</h3><table><thead><tr><th>Ngày</th><th>Bill</th><th>Tổng</th><th>Đã thu</th><th>Còn nợ</th></tr></thead><tbody>${oldDebtRows}</tbody></table><div class="total">Tổng nợ cũ: ${money(order.old_debt_total)}</div><div class="total">Tổng cần thu gồm nợ cũ: ${money(Number(order.old_debt_total||0)+Number(order.debt_amount||0))}</div>` : ''}
${installmentRows ? `<h3>Kế hoạch trả góp công nợ</h3><table><thead><tr><th>Kế hoạch</th><th>Số tiền/ngày</th><th>Bắt đầu</th><th>Đã góp</th></tr></thead><tbody>${installmentRows}</tbody></table><div class="total">Mức góp/ngày: ${money(order.installment.daily_total)}</div><div class="total">Góp cần thu hôm nay: ${money(order.installment.due_today_total)}</div><div class="total">Tổng khách cần thanh toán: ${money(Number(order.total_amount||0)+Number(order.installment.due_today_total||0))}</div>${installmentRecentRows ? `<h4>Lịch sử góp gần đây</h4><table><thead><tr><th>Ngày</th><th>Số tiền</th><th>Hình thức</th></tr></thead><tbody>${installmentRecentRows}</tbody></table>` : ''}` : ''}
<div class="sign"><div>Người giao<br><br><br>____________</div><div>Khách nhận<br><br><br>____________</div></div></body></html>`;
  }

  async lotHtml(lot) {
    const expr = (v, fallback) => v && String(v).trim() ? v : fallback;
    const rawExpr = expr(lot.raw_weight_expr, lot.raw_weight);
    const boneExpr = expr(lot.bone_weight_expr, lot.bone_weight);
    const deductMode = lot.deduct_mode || 'PER_ANIMAL';
    const deductExpr = deductMode === 'TOTAL_KG'
      ? expr(lot.deducted_weight_expr, lot.deducted_weight)
      : `${lot.total_animals||0} con × ${lot.deduct_kg_per_animal||0} kg/con`;

    return `<!doctype html><html><head><meta charset="utf-8"><title>${lot.lot_code}</title><style>
body{font-family:Arial;margin:28px;color:#111}.header{border-bottom:3px solid #7f1d1d;padding-bottom:12px}.logo{font-size:28px;font-weight:900;color:#7f1d1d}
table{width:100%;border-collapse:collapse;margin-top:18px}td,th{border:1px solid #ddd;padding:10px}th{background:#7f1d1d;color:white}.right{text-align:right}.total{font-size:22px;font-weight:900;text-align:right;margin-top:18px}.print{position:fixed;right:20px;top:20px;padding:12px 18px;background:#7f1d1d;color:#fff;border:0;border-radius:10px}.note{white-space:pre-wrap}.muted{color:#666}@media print{.print{display:none}}</style></head><body>
<button class="print" onclick="window.print()">IN PHIẾU</button><div class="header"><div class="logo">PHIẾU NHẬP LÔ / NHÀ CUNG CẤP</div><div>Mã lô: <b>${lot.lot_code}</b></div><div>Ngày: ${lot.purchase_date}</div></div>
<p><b>Nhà cung cấp:</b> ${lot.supplier_name||''} - ${lot.supplier_phone||''}<br><b>Địa chỉ:</b> ${lot.supplier_address||''}</p>
<table><tbody>
<tr><th>Nội dung</th><th>Cách nhập</th><th class="right">Giá trị</th></tr>
<tr><td>Tổng kg thịt xô</td><td>${rawExpr}</td><td class="right">${lot.raw_weight||0} kg</td></tr>
<tr><td>Xương sườn quy đổi thịt xô</td><td>${boneExpr} / 2</td><td class="right">+${Number(lot.bone_weight||0)/2} kg</td></tr>
<tr><td>Trừ xô</td><td>${deductExpr}</td><td class="right">-${lot.deducted_weight||0} kg</td></tr>
<tr><td>Trừ bò hư</td><td></td><td class="right">-${lot.damage_weight||0} kg</td></tr>
<tr><td>Trừ mỡ</td><td></td><td class="right">-${lot.fat_weight||0} kg</td></tr>
<tr><td>Trừ khác</td><td>${lot.deduct_note||''}</td><td class="right">-${lot.other_deduct_weight||0} kg</td></tr>
<tr><td><b>Kg tính tiền</b></td><td></td><td class="right"><b>${lot.total_weight} kg</b></td></tr>
</tbody></table>

<table><tbody>
<tr><th>Phân loại bò</th><th class="right">Số con</th><th class="right">Kg phân bổ</th><th class="right">Đơn giá</th></tr>
<tr><td>Bò đực</td><td class="right">${lot.male_animals||0}</td><td class="right">${Number(lot.male_weight||0).toFixed(3)} kg</td><td class="right">${money(lot.male_price||lot.purchase_price)} / kg</td></tr>
<tr><td>Bò cái</td><td class="right">${lot.female_animals||0}</td><td class="right">${Number(lot.female_weight||0).toFixed(3)} kg</td><td class="right">${money(lot.female_price||lot.purchase_price)} / kg</td></tr>
</tbody></table>

<table><tbody>
<tr><td>Đã ứng</td><td class="right">${money(lot.advance_amount)}</td></tr>
<tr><td>Đã trả</td><td class="right">${money(lot.paid_amount)}</td></tr>
<tr><td>Còn phải trả</td><td class="right">${money(lot.remaining_amount)}</td></tr>
<tr><td>Ghi chú / mô tả lô</td><td class="note">${lot.note||''}</td></tr>
</tbody></table>
<div class="total">Thành tiền: ${money(lot.total_cost)}</div></body></html>`;
  }
  }
}
module.exports = new PrintService();
